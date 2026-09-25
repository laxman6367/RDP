import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTx } from '../../db.js';
import { badRequest, notFound } from '../../errors.js';
import { sha256Hex } from '../../security/tokens.js';
import { audit } from '../../services/audit.js';
import { sniffImageType } from '../../services/blob-store.js';
import type { WallpaperRow } from '../../services/policy-apply.js';
import { requireAdmin, requireCapability, resolveOrg, type Services } from '../context.js';

const toWallpaper = (w: WallpaperRow) => ({
  id: w.id,
  name: w.name,
  contentType: w.content_type,
  sizeBytes: w.size_bytes,
  sha256: w.sha256,
  createdAt: w.created_at,
});

export async function wallpaperRoutes(app: FastifyInstance, s: Services) {
  app.get('/wallpapers', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    requireCapability(org, 'wallpaper');
    const { rows } = await s.db.query<WallpaperRow>('select * from wallpapers where org_id = $1 order by created_at desc', [org.id]);
    return { wallpapers: rows.map(toWallpaper) };
  });

  /** multipart/form-data with a `file` part (PNG, JPEG or WebP) and an optional `name` field. */
  app.post('/wallpapers', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'command');
    const org = await resolveOrg(s, req, admin);
    requireCapability(org, 'wallpaper');
    const file = await req.file({ limits: { fileSize: s.cfg.MAX_WALLPAPER_BYTES, files: 1 } });
    if (!file) throw badRequest('FILE_REQUIRED');
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest('FILE_TOO_LARGE');
    const type = sniffImageType(data);
    if (!type) throw badRequest('UNSUPPORTED_IMAGE', 'Upload a PNG, JPEG or WebP image');
    const nameField = file.fields.name as { value?: string } | undefined;
    const name = (nameField?.value ?? file.filename ?? 'wallpaper').slice(0, 120);
    const id = randomUUID();
    const key = `wallpapers/${org.id}/${id}`;
    await s.blobs.put(key, data);
    const row = await withTx(s.db, async (tx) => {
      const w = (
        await tx.query<WallpaperRow>(
          'insert into wallpapers (id, org_id, name, content_type, size_bytes, sha256, storage_key, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *',
          [id, org.id, name, type, data.length, sha256Hex(data), key, admin.id],
        )
      ).rows[0]!;
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'wallpaper.upload', targetType: 'wallpaper', targetId: id, meta: { name, size: data.length }, ip: req.ip });
      return w;
    });
    reply.code(201);
    return toWallpaper(row);
  });

  app.get<{ Params: { id: string } }>('/wallpapers/:id/content', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    const w = (await s.db.query<WallpaperRow>('select * from wallpapers where id = $1 and org_id = $2', [req.params.id, org.id])).rows[0];
    if (!w) throw notFound('wallpaper');
    const data = await s.blobs.get(w.storage_key);
    if (!data) throw notFound('wallpaper');
    reply.header('content-type', w.content_type).header('cache-control', 'private, max-age=3600');
    return data;
  });
}
