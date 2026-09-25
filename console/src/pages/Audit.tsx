import { useState } from 'react';
import { api, download } from '../api';
import { Card, Empty, ErrorBanner, fmtTime, PageHeader, Spinner, useAction, useAsync } from '../components/ui';

interface Event {
  id: string;
  ts: string;
  actorType: string;
  actorId: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
}

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const qs = new URLSearchParams({ limit: '100', ...(action ? { action } : {}), ...(before ? { before } : {}) });
  const { data, error, loading } = useAsync(() => api.get<{ events: Event[]; nextBefore: string | null }>(`/audit?${qs}`), [action, before]);
  const exp = useAction();
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every admin, device, system and webhook action — who did what, when."
        actions={<button className="btn" disabled={exp.busy} onClick={() => void exp.run(() => download(`/audit?format=csv&limit=5000${action ? `&action=${encodeURIComponent(action)}` : ''}`, 'redcore-audit.csv'))}>Export CSV</button>}
      />
      <Card>
        <div className="toolbar">
          <input placeholder="Filter by action prefix, e.g. device.lock" value={action} onChange={(e) => { setAction(e.target.value); setBefore(null); }} />
        </div>
        <ErrorBanner error={error ?? exp.error} />
        {loading ? <Spinner /> : !data?.events.length ? <Empty>No events.</Empty> : (
          <>
            <table className="table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{fmtTime(e.ts)}</td>
                    <td className="small">{e.actorEmail ?? `${e.actorType}${e.actorType === 'admin' ? '' : `: ${e.actorId.slice(0, 12)}`}`}</td>
                    <td><code>{e.action}</code></td>
                    <td className="small">{e.targetType ? `${e.targetType} ${e.targetId?.slice(0, 8)}` : '—'}</td>
                    <td className="small">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              {before && <button className="btn btn-sm" onClick={() => setBefore(null)}>Newest</button>}
              {data.nextBefore && <button className="btn btn-sm" onClick={() => setBefore(data.nextBefore)}>Older →</button>}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
