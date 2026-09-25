import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Badge, Card, Empty, ErrorBanner, fmtTime, PageHeader, Spinner, useAction, useAsync } from '../components/ui';
import { useSession } from '../session';
import type { Alert } from '../types';

const LABEL: Record<string, string> = {
  tamper: 'Tamper',
  sos: 'SOS',
  geofence_enter: 'Arrived',
  geofence_exit: 'Left',
  install_request: 'Install request',
  limit_reached: 'Limit reached',
  permission_denied: 'Permission denied',
  keyword: 'Safety keyword',
  unknown_number: 'Unknown number',
};

function describe(a: Alert): string {
  const p = a.payload as Record<string, unknown>;
  if (a.kind === 'tamper') return `Reason: ${String(p.reason ?? 'unknown').replace(/_/g, ' ')}`;
  if (a.kind === 'geofence_enter' || a.kind === 'geofence_exit') return String(p.fenceName ?? p.fence ?? '');
  if (a.kind === 'install_request' || a.kind === 'limit_reached') return String(p.label ?? p.package ?? '');
  if (a.kind === 'permission_denied') return String(p.permission ?? '');
  return '';
}

export default function AlertsPage() {
  const { canCommand } = useSession();
  const [onlyOpen, setOnlyOpen] = useState(true);
  const { data, error, loading, reload } = useAsync(() => api.get<{ alerts: Alert[] }>(`/alerts?unacknowledged=${onlyOpen}`), [onlyOpen]);
  const act = useAction();
  return (
    <>
      <PageHeader title="Alerts" actions={<label className="toggle"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Unacknowledged only</label>} />
      <Card>
        <ErrorBanner error={error ?? act.error} />
        {loading ? <Spinner /> : !data?.alerts.length ? <Empty>No alerts.</Empty> : (
          <table className="table">
            <thead><tr><th>When</th><th>Device</th><th>Alert</th><th>Details</th><th /></tr></thead>
            <tbody>
              {data.alerts.map((a) => (
                <tr key={a.id}>
                  <td className="small">{fmtTime(a.ts)}</td>
                  <td><Link to={`/devices/${a.deviceId}`}>{a.deviceName}</Link></td>
                  <td><Badge tone={a.kind === 'tamper' || a.kind === 'sos' ? 'red' : 'amber'}>{LABEL[a.kind] ?? a.kind}</Badge></td>
                  <td className="small">{describe(a)}</td>
                  <td>{!a.acknowledgedAt && canCommand && (
                    <button className="btn btn-sm" disabled={act.busy} onClick={() => void act.run(async () => { await api.post(`/alerts/${a.id}/ack`); await reload(); })}>Acknowledge</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
