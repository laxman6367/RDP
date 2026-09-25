import type { Queryable } from '../db.js';
import type { DesiredState } from '../domain/desired-state.js';
import type { EnterprisePolicy, PolicySpec } from '../domain/policy.js';

export interface PolicyRow {
  id: string;
  org_id: string;
  name: string;
  phase: 1 | 2;
  spec: PolicySpec;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface WallpaperRow {
  id: string;
  org_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  created_at: Date;
}

export const wallpaperPath = (deviceId: string, wallpaperId: string) => `/v1/devices/${deviceId}/wallpapers/${wallpaperId}`;

/**
 * Returns `state` with `policy` applied. For Phase 2 policies a per-fleet
 * default wallpaper (spec §5.3) is applied too, unless an admin has set a
 * device-specific wallpaper.
 */
export async function stateWithPolicy(
  q: Queryable,
  deviceId: string,
  state: DesiredState,
  policy: PolicyRow | null,
): Promise<DesiredState> {
  const next: DesiredState = { ...state, policy: policy ? { id: policy.id, version: policy.version, spec: policy.spec } : null };
  if (state.wallpaper?.source === 'admin') return next;
  next.wallpaper = null;
  const wp = policy?.phase === 2 ? (policy.spec as EnterprisePolicy).wallpaper : undefined;
  if (policy && wp?.defaultWallpaperId) {
    const row = (
      await q.query<WallpaperRow>('select * from wallpapers where id = $1 and org_id = $2', [wp.defaultWallpaperId, policy.org_id])
    ).rows[0];
    if (row) {
      next.wallpaper = {
        wallpaperId: row.id,
        path: wallpaperPath(deviceId, row.id),
        sha256: row.sha256,
        target: wp.target,
        lockChange: wp.lockChange,
        source: 'policy',
      };
    }
  }
  return next;
}
