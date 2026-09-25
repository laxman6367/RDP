import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, newIdempotencyKey } from '../api';
import { Badge, Card, Empty, ErrorBanner, fmtAgo, kioskLabel, kioskTone, PageHeader, Spinner, useAction, useAsync } from '../components/ui';
import { useSession } from '../session';
import type { DeviceSummary } from '../types';

export default function FleetPage() {
  const { org, canCommand } = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [locked, setLocked] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const params = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(locked ? { locked } : {}) });
  const { data, error, loading, reload } = useAsync(() => api.get<{ devices: DeviceSummary[] }>(`/devices?${params}`), [q, status, locked]);
  const bulk = useAction();
  const family = org?.type === 'family';
  const devices = data?.devices ?? [];

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function bulkAction(action: 'lock' | 'unlock') {
    const deviceIds = [...selected];
    if (!deviceIds.length) return;
    if (!confirm(`${action === 'lock' ? 'Lock' : 'Unlock'} ${deviceIds.length} device(s)?`)) return;
    await bulk.run(async () => {
      await api.post(`/devices/bulk/${action}`, { deviceIds, ...(action === 'lock' ? { lock: { mode: 'full', message: 'Locked by your administrator' } } : {}) }, { 'idempotency-key': newIdempotencyKey() });
      setSelected(new Set());
      await reload();
    });
  }

  return (
    <>
      <PageHeader
        title={family ? 'Children’s devices' : 'Fleet'}
        subtitle={`${devices.length} device(s)`}
        actions={<Link to="/enroll" className="btn btn-primary">+ Enroll device</Link>}
      />
      <Card>
        <div className="toolbar">
          <input placeholder="Search name, owner reference, model…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
            <option value="">All</option>
          </select>
          <select value={locked} onChange={(e) => setLocked(e.target.value)}>
            <option value="">Any lock state</option>
            <option value="true">Locked</option>
            <option value="false">Unlocked</option>
          </select>
          {!family && canCommand && selected.size > 0 && (
            <div className="toolbar-right">
              <span className="muted">{selected.size} selected</span>
              <button className="btn btn-danger btn-sm" disabled={bulk.busy} onClick={() => void bulkAction('lock')}>Lock</button>
              <button className="btn btn-sm" disabled={bulk.busy} onClick={() => void bulkAction('unlock')}>Unlock</button>
            </div>
          )}
        </div>
        <ErrorBanner error={error ?? bulk.error} />
        {loading && !data ? <Spinner /> : devices.length === 0 ? (
          <Empty>No devices yet. <Link to="/enroll">Enroll the first one.</Link></Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                {!family && <th />}
                <th>Device</th>
                <th>{family ? 'Child' : 'Owner ref'}</th>
                <th>State</th>
                <th>Policy</th>
                <th>Sync</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  {!family && <td><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} aria-label={`Select ${d.displayName}`} /></td>}
                  <td>
                    <Link to={`/devices/${d.id}`} className="strong">{d.displayName}</Link>
                    <div className="muted small">{[d.manufacturer, d.model].filter(Boolean).join(' ')} · Android {d.osVersion ?? '?'}</div>
                  </td>
                  <td>{family ? d.displayName : d.ownerRef ?? '—'}</td>
                  <td>
                    {d.status === 'retired' ? <Badge>Retired</Badge> : <Badge tone={kioskTone(d.kioskMode)}>{kioskLabel[d.kioskMode] ?? d.kioskMode}</Badge>}
                    {d.integrity === 'failed' && <> <Badge tone="red">Integrity</Badge></>}
                  </td>
                  <td>{d.policyName ?? <span className="muted">—</span>}</td>
                  <td>{d.inSync ? <Badge tone="green">In sync</Badge> : <Badge tone="amber">Pending v{d.desiredVersion}</Badge>}</td>
                  <td title={d.lastSeen ?? ''}>{fmtAgo(d.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
