import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download, newIdempotencyKey } from '../api';
import { LocationMap, type Point } from '../components/LocationMap';
import {
  Badge, Card, Empty, ErrorBanner, Field, fmtAgo, fmtTime, kioskLabel, kioskTone, PageHeader, Spinner, splitList, Toggle, useAction, useAsync,
} from '../components/ui';
import { useSession } from '../session';
import type { Alert, DeviceSummary, Policy, TransparencyReport, Wallpaper } from '../types';

interface DeviceDetail {
  device: DeviceSummary;
  orgType: string;
  phase: 1 | 2;
  desiredState: any;
  reportedState: any;
  integrity: any;
  consent: any;
  policy: { id: string; name: string; version: number } | null;
  loan: { id: string; accountRef: string; status: string; tier: string } | null;
}

type Tab = 'overview' | 'commands' | 'apps' | 'location' | 'comms' | 'alerts' | 'transparency' | 'audit';

export default function DevicePage() {
  const { id } = useParams<{ id: string }>();
  const { org, can } = useSession();
  const [tab, setTab] = useState<Tab>('overview');
  const { data, error, loading, reload } = useAsync(() => api.get<DeviceDetail>(`/devices/${id}`), [id]);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;
  const d = data.device;
  const family = org?.type === 'family';
  const tabs: Array<[Tab, string, boolean]> = [
    ['overview', 'Overview', true],
    ['commands', 'Commands', true],
    ['apps', 'Apps & screen time', can('apps')],
    ['location', 'Location', can('location')],
    ['comms', 'Messages & calls', can('comms')],
    ['alerts', 'Alerts', true],
    ['transparency', 'What the user sees', true],
    ['audit', 'Audit', true],
  ];

  return (
    <>
      <PageHeader
        title={d.displayName}
        subtitle={<>
          {[d.manufacturer, d.model].filter(Boolean).join(' ')} · Android {d.osVersion} · {d.managementMode === 'device_owner' ? 'Device Owner' : 'Profile Owner'} · last seen {fmtAgo(d.lastSeen)}
        </>}
        actions={<>
          {d.status === 'retired' ? <Badge>Retired</Badge> : <Badge tone={kioskTone(d.kioskMode)}>{kioskLabel[d.kioskMode] ?? d.kioskMode}</Badge>}
          {d.inSync ? <Badge tone="green">In sync</Badge> : <Badge tone="amber">Applying v{d.desiredVersion}</Badge>}
          <button className="btn btn-sm" onClick={() => void reload()}>Refresh</button>
        </>}
      />
      <div className="device-layout">
        <div>
          <div className="tabs">
            {tabs.filter((t) => t[2]).map(([key, label]) => (
              <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          {tab === 'overview' && <Overview data={data} family={family} />}
          {tab === 'commands' && <Commands id={d.id} />}
          {tab === 'apps' && <Apps id={d.id} />}
          {tab === 'location' && <Location id={d.id} fences={data.desiredState.policy?.spec?.location?.geofences ?? []} />}
          {tab === 'comms' && <Comms id={d.id} reported={data.reportedState} />}
          {tab === 'alerts' && <DeviceAlerts id={d.id} />}
          {tab === 'transparency' && <Transparency id={d.id} />}
          {tab === 'audit' && <DeviceAudit id={d.id} />}
        </div>
        {d.status === 'active' && <Actions data={data} onChange={reload} />}
      </div>
    </>
  );
}

function Overview({ data, family }: { data: DeviceDetail; family: boolean }) {
  const st = data.desiredState;
  const perms = (data.reportedState?.permissions ?? {}) as Record<string, string>;
  return (
    <>
      <Card title="Current state">
        <dl className="kv">
          <dt>Lock</dt>
          <dd>
            <Badge tone={kioskTone(st.kiosk.mode)}>{kioskLabel[st.kiosk.mode] ?? st.kiosk.mode}</Badge>
            {st.kiosk.source !== 'none' && <span className="muted small"> set by {st.kiosk.source === 'loan_rule' ? 'EMI loan rules' : 'an administrator'}</span>}
            {st.kiosk.allowlist?.length > 0 && <div className="small">Allowed: {st.kiosk.allowlist.join(', ')}</div>}
          </dd>
          <dt>Policy</dt>
          <dd>{data.policy ? `${data.policy.name} (v${data.policy.version})` : <span className="muted">None</span>}</dd>
          {!family && <><dt>Wallpaper</dt><dd>{st.wallpaper ? `${st.wallpaper.source === 'policy' ? 'Fleet default' : 'Device-specific'}${st.wallpaper.lockChange ? ' · locked' : ''}` : <span className="muted">Not managed</span>}</dd></>}
          <dt>Restrictions</dt>
          <dd>{st.userRestrictions.length ? st.userRestrictions.join(', ') : <span className="muted">None</span>}</dd>
          <dt>Desired / reported</dt>
          <dd>v{data.device.desiredVersion} / v{data.device.reportedVersion}</dd>
          <dt>Integrity</dt>
          <dd><Badge tone={data.integrity?.status === 'verified' ? 'green' : data.integrity?.status === 'failed' ? 'red' : 'neutral'}>{data.integrity?.status ?? 'unverified'}</Badge></dd>
          {data.loan && <><dt>Loan</dt><dd><Link to="/loans">{data.loan.accountRef}</Link> · {data.loan.status} · tier {data.loan.tier}</dd></>}
        </dl>
      </Card>
      {Object.keys(perms).length > 0 && (
        <Card title="Permissions on device">
          <div className="chips">
            {Object.entries(perms).map(([k, v]) => <Badge key={k} tone={v === 'granted' ? 'green' : v === 'denied' ? 'red' : 'neutral'}>{k}: {v}</Badge>)}
          </div>
        </Card>
      )}
      {data.consent && (
        <Card title="Consent record">
          <dl className="kv">
            <dt>Type</dt><dd>{data.consent.type === 'guardian_of_minor' ? 'Parent / legal guardian of a minor' : 'Company-owned device'}</dd>
            <dt>Attested by</dt><dd>{data.consent.attesterName}</dd>
            {data.consent.subjectAge !== null && <><dt>Child’s age</dt><dd>{data.consent.subjectAge}{data.consent.coppaApplicable && <> <Badge tone="blue">COPPA</Badge></>}</dd></>}
            <dt>Holder acknowledged</dt><dd>{fmtTime(data.consent.deviceAcknowledgedAt)}{data.consent.deviceHolderName && ` by ${data.consent.deviceHolderName}`}</dd>
            <dt>Statement</dt><dd className="small">{data.consent.attestationText}</dd>
          </dl>
        </Card>
      )}
    </>
  );
}

function Actions({ data, onChange }: { data: DeviceDetail; onChange: () => Promise<void> }) {
  const { org, can, canCommand, canManage } = useSession();
  const nav = useNavigate();
  const id = data.device.id;
  const act = useAction();
  const family = org?.type === 'family';
  const [mode, setMode] = useState(org?.type === 'emi' ? 'payment' : family ? 'study' : 'kiosk');
  const [allowlist, setAllowlist] = useState('');
  const [message, setMessage] = useState('');
  const [supportContact, setSupportContact] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [text, setText] = useState('');
  const [wallpaperId, setWallpaperId] = useState('');
  const [lockChange, setLockChange] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const wallpapers = useAsync(() => (can('wallpaper') ? api.get<{ wallpapers: Wallpaper[] }>('/wallpapers') : Promise.resolve({ wallpapers: [] })), []);
  const policies = useAsync(() => api.get<{ policies: Policy[] }>('/policies'), []);
  const spec = data.desiredState.policy?.spec;

  const modes: Array<[string, string]> = family
    ? [['study', 'Study mode (approved apps)'], ['kiosk', 'Single-app kiosk'], ['full', 'Full lock']]
    : org?.type === 'emi'
      ? [['payment', 'Payment-due lock'], ['kiosk', 'Kiosk (allow-list)'], ['full', 'Full lock']]
      : [['kiosk', 'Single-purpose kiosk'], ['full', 'Full lock']];

  const done = async (msg: string) => {
    setNotice(msg);
    await onChange();
  };

  async function lock(e: FormEvent) {
    e.preventDefault();
    await act.run(async () => {
      const r = await api.post(`/devices/${id}/lock`, {
        mode,
        allowlist: splitList(allowlist),
        ...(message ? { message } : {}),
        ...(supportContact ? { supportContact } : {}),
        ...(paymentUrl ? { paymentUrl } : {}),
      }, { 'idempotency-key': newIdempotencyKey() });
      await done(r.changed ? 'Lock sent to the device.' : 'Device already in this state.');
    });
  }

  if (!canCommand) return <aside className="actions"><Card title="Actions"><p className="muted">Read-only access.</p></Card></aside>;

  return (
    <aside className="actions">
      {notice && <div className="banner banner-ok">{notice}</div>}
      <ErrorBanner error={act.error} />
      {can('kiosk') && (
        <Card title="Kiosk lock">
          {data.desiredState.kiosk.mode !== 'none' ? (
            <button className="btn btn-block" disabled={act.busy} onClick={() => void act.run(async () => {
              await api.post(`/devices/${id}/unlock`, {}, { 'idempotency-key': newIdempotencyKey() });
              await done('Unlock sent to the device.');
            })}>Unlock device</button>
          ) : (
            <form onSubmit={lock} className="stack">
              <Field label="Mode">
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {modes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              {(mode === 'kiosk' || mode === 'study') && (
                <Field label="Allowed apps" hint="Package names, comma separated">
                  <input value={allowlist} onChange={(e) => setAllowlist(e.target.value)} placeholder="org.khanacademy.android" required={mode === 'kiosk'} />
                </Field>
              )}
              <Field label="Message on lock screen">
                <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={280} />
              </Field>
              {mode === 'payment' && (
                <>
                  <Field label="Support contact"><input value={supportContact} onChange={(e) => setSupportContact(e.target.value)} required /></Field>
                  <Field label="Payment link (https)"><input type="url" value={paymentUrl} onChange={(e) => setPaymentUrl(e.target.value)} /></Field>
                </>
              )}
              <p className="small muted">Emergency calling always remains available.</p>
              <button className="btn btn-danger btn-block" disabled={act.busy}>Lock device</button>
            </form>
          )}
        </Card>
      )}

      {can('wallpaper') && (
        <Card title="Wallpaper">
          <div className="stack">
            <select value={wallpaperId} onChange={(e) => setWallpaperId(e.target.value)}>
              <option value="">— Fleet default / none —</option>
              {wallpapers.data?.wallpapers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <Toggle checked={lockChange} onChange={setLockChange} label="Prevent the user changing it" />
            <button className="btn btn-block" disabled={act.busy} onClick={() => void act.run(async () => {
              const r = await api.post(`/devices/${id}/wallpaper`, { wallpaperId: wallpaperId || null, lockChange }, { 'idempotency-key': newIdempotencyKey() });
              await done(r.changed ? 'Wallpaper sent to the device.' : 'Wallpaper unchanged.');
            })}>Apply wallpaper</button>
            {!wallpapers.data?.wallpapers.length && <Link to="/wallpapers" className="small">Upload a wallpaper first</Link>}
          </div>
        </Card>
      )}

      <Card title={family ? 'Quick actions' : 'Message'}>
        <div className="stack">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Show a message on the device" maxLength={500} />
          <button className="btn btn-block" disabled={act.busy || !text} onClick={() => void act.run(async () => {
            await api.post(`/devices/${id}/message`, { text }, { 'idempotency-key': newIdempotencyKey() });
            setText('');
            await done('Message sent.');
          })}>Send message</button>
          {can('location') && (
            <button className="btn btn-block" disabled={act.busy || !spec?.location?.enabled} title={spec?.location?.enabled ? '' : 'Enable location in the policy'} onClick={() => void act.run(async () => {
              await api.post(`/devices/${id}/locate`, {}, { 'idempotency-key': newIdempotencyKey() });
              await done('Locating… the result will appear on the Location tab.');
            })}>Locate now</button>
          )}
          {can('anti_theft') && (
            <button className="btn btn-block" disabled={act.busy || !spec?.antiTheft?.enabled} title={spec?.antiTheft?.enabled ? '' : 'Enable lost-device mode in the policy'} onClick={() => {
              if (!confirm('Report this device lost? The device will show a notice, share its location and take one photo.')) return;
              void act.run(async () => {
                await api.post(`/devices/${id}/lost`, {}, { 'idempotency-key': newIdempotencyKey() });
                await done('Lost-device request sent. The holder will see a notice.');
              });
            }}>Report lost</button>
          )}
        </div>
      </Card>

      {canManage && (
        <Card title="Management">
          <div className="stack">
            <Field label="Policy">
              <select value={data.policy?.id ?? ''} onChange={(e) => void act.run(async () => {
                await api.put(`/devices/${id}/policy`, { policyId: e.target.value || null });
                await done('Policy assigned.');
              })}>
                <option value="">— No policy —</option>
                {policies.data?.policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <button className="btn btn-block" onClick={() => void act.run(() => download(`/devices/${id}/export`, `redcore-device-${id}.json`))}>Export data</button>
            {family && (
              <button className="btn btn-block" onClick={() => {
                if (!confirm('Delete all collected telemetry and alerts for this device?')) return;
                void act.run(async () => {
                  const r = await api.del(`/devices/${id}/telemetry`);
                  await done(`Deleted ${r.deleted.telemetry} telemetry record(s).`);
                });
              }}>Delete collected data</button>
            )}
            <button className="btn btn-danger-outline btn-block" onClick={() => {
              if (!confirm('Release this device from management? All restrictions will be lifted and the agent will stop reporting.')) return;
              void act.run(async () => {
                await api.post(`/devices/${id}/retire`);
                nav('/devices');
              });
            }}>Release device</button>
          </div>
        </Card>
      )}
    </aside>
  );
}

function Commands({ id }: { id: string }) {
  const { data, error, loading } = useAsync(() => api.get<{ commands: any[] }>(`/devices/${id}/command-history`), [id]);
  if (loading) return <Spinner />;
  return (
    <Card title="Command history">
      <ErrorBanner error={error} />
      {!data?.commands.length ? <Empty>No commands yet.</Empty> : (
        <table className="table">
          <thead><tr><th>Command</th><th>Status</th><th>Issued by</th><th>Created</th><th>Acked</th><th>Tries</th></tr></thead>
          <tbody>
            {data.commands.map((c) => (
              <tr key={c.id}>
                <td>{c.type}{c.payload?.version ? <span className="muted small"> v{c.payload.version}</span> : null}</td>
                <td><Badge tone={c.status === 'succeeded' ? 'green' : c.status === 'failed' || c.status === 'expired' ? 'red' : c.status === 'cancelled' ? 'neutral' : 'amber'}>{c.status}</Badge></td>
                <td className="small">{c.issuedBySystem ? `system: ${c.issuedBySystem}` : 'admin'}</td>
                <td className="small">{fmtTime(c.createdAt)}</td>
                <td className="small">{fmtTime(c.ackAt)}</td>
                <td>{c.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Apps({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(() => api.get<{ inventoryAt: string | null; apps: any[]; usage: Array<{ day: string; package: string; minutes: number }> }>(`/devices/${id}/apps`), [id]);
  const act = useAction();
  if (loading) return <Spinner />;
  const today = data?.usage.filter((u) => u.day === data.usage[0]?.day) ?? [];
  const weekly = new Map<string, number>();
  data?.usage.forEach((u) => weekly.set(u.package, (weekly.get(u.package) ?? 0) + u.minutes));
  const maxWeek = Math.max(1, ...weekly.values());
  return (
    <>
      <ErrorBanner error={error ?? act.error} />
      <Card title="Screen time — last 7 days" actions={<button className="btn btn-sm" onClick={() => void act.run(async () => { await api.post(`/devices/${id}/sync-inventory`); setTimeout(() => void reload(), 3000); })}>Refresh from device</button>}>
        {weekly.size === 0 ? <Empty>No usage reported yet.</Empty> : (
          <div className="bars">
            {[...weekly.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([pkg, min]) => (
              <div key={pkg} className="bar-row">
                <span className="bar-label">{data?.apps.find((a) => a.package === pkg)?.label ?? pkg}</span>
                <span className="bar"><span style={{ width: `${(min / maxWeek) * 100}%` }} /></span>
                <span className="bar-value">{Math.floor(min / 60)}h {min % 60}m</span>
              </div>
            ))}
          </div>
        )}
        {today.length > 0 && <p className="small muted">Most recent day ({data?.usage[0]?.day}): {today.reduce((s, u) => s + u.minutes, 0)} minutes total.</p>}
      </Card>
      <Card title={`Installed apps${data?.inventoryAt ? ` · as of ${fmtTime(data.inventoryAt)}` : ''}`}>
        {!data?.apps.length ? <Empty>No app inventory reported yet.</Empty> : (
          <table className="table">
            <thead><tr><th>App</th><th>Category</th><th>Limit</th><th>Status</th></tr></thead>
            <tbody>
              {data.apps.map((a) => (
                <tr key={a.package}>
                  <td>{a.label ?? a.package}<div className="muted small">{a.package}</div></td>
                  <td>{a.category ?? '—'}</td>
                  <td>{a.dailyLimitMinutes !== null ? `${a.dailyLimitMinutes} min/day` : '—'}</td>
                  <td>{a.blocked ? <Badge tone="red">Blocked</Badge> : <Badge tone="green">Allowed</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small muted">Block apps, set time limits and downtime in <Link to="/policies">Policies</Link>.</p>
      </Card>
    </>
  );
}

function Location({ id, fences }: { id: string; fences: any[] }) {
  const { data, error, loading } = useAsync(() => api.get<{ locations: Point[] }>(`/devices/${id}/locations?limit=500`), [id]);
  if (loading) return <Spinner />;
  const pts = data?.locations ?? [];
  return (
    <Card title="Location" actions={pts[0] && <span className="muted small">Latest {fmtAgo(pts[0].ts)}</span>}>
      <ErrorBanner error={error} />
      <LocationMap points={pts} fences={fences} />
      {!pts.length && <p className="muted small">No location reported yet. Location must be enabled in the device’s policy.</p>}
    </Card>
  );
}

function Comms({ id, reported }: { id: string; reported: any }) {
  const [kind, setKind] = useState<'sms' | 'call_log' | 'contacts'>('call_log');
  const { data, error, loading } = useAsync(() => api.get<{ items: Array<{ payload: any; ts: string }>; permissions: Record<string, string> }>(`/devices/${id}/telemetry/${kind}`), [id, kind]);
  const permKey = { sms: 'READ_SMS', call_log: 'READ_CALL_LOG', contacts: 'READ_CONTACTS' }[kind];
  const perm = (reported?.permissions ?? {})[permKey];
  return (
    <Card title="Messages, calls & contacts">
      <div className="tabs tabs-sub">
        {(['call_log', 'sms', 'contacts'] as const).map((k) => <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{{ call_log: 'Calls', sms: 'SMS', contacts: 'Contacts' }[k]}</button>)}
      </div>
      {perm && perm !== 'granted' && (
        <div className="banner banner-warn">
          This panel is unavailable: the <code>{permKey}</code> permission is <strong>{perm}</strong> on the device. Redcore keeps working without it (spec §4.5 fallback).
        </div>
      )}
      <ErrorBanner error={error} />
      {loading ? <Spinner /> : !data?.items.length ? <Empty>Nothing reported. This must be enabled in the device’s policy and permitted on the device.</Empty> : (
        <table className="table">
          <tbody>
            {data.items.map((i, n) => (
              <tr key={n}>
                <td className="small">{fmtTime(i.ts)}</td>
                <td>{i.payload.name ?? i.payload.address ?? i.payload.number ?? '—'}</td>
                <td className="small">{kind === 'call_log' ? `${i.payload.type ?? ''} · ${i.payload.durationSec ?? 0}s` : kind === 'sms' ? (i.payload.body ?? <span className="muted">(content not collected)</span>) : (i.payload.phones ?? []).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function DeviceAlerts({ id }: { id: string }) {
  const { data, error, loading } = useAsync(() => api.get<{ alerts: Alert[] }>(`/alerts?deviceId=${id}`), [id]);
  if (loading) return <Spinner />;
  return (
    <Card title="Alerts">
      <ErrorBanner error={error} />
      {!data?.alerts.length ? <Empty>No alerts.</Empty> : (
        <ul className="feed">
          {data.alerts.map((a) => <li key={a.id}><Badge tone={a.kind === 'tamper' || a.kind === 'sos' ? 'red' : 'amber'}>{a.kind}</Badge> <span className="small">{fmtTime(a.ts)}</span> <code className="small">{JSON.stringify(a.payload)}</code></li>)}
        </ul>
      )}
    </Card>
  );
}

function Transparency({ id }: { id: string }) {
  const { data, error, loading } = useAsync(() => api.get<TransparencyReport>(`/devices/${id}/transparency`), [id]);
  if (loading) return <Spinner />;
  return (
    <Card title="Shown on the device’s transparency screen">
      <ErrorBanner error={error} />
      {data && (
        <div className="transparency">
          <p className="strong">{data.headline}</p>
          <ul>{data.items.map((i) => <li key={i.key}><strong>{i.title}.</strong> {i.detail}</li>)}</ul>
          <p className="small muted">A persistent notification on the device always shows that Redcore is active.</p>
        </div>
      )}
    </Card>
  );
}

function DeviceAudit({ id }: { id: string }) {
  const { data, error, loading } = useAsync(() => api.get<{ events: any[] }>(`/devices/${id}/audit`), [id]);
  if (loading) return <Spinner />;
  return (
    <Card title="Audit trail for this device">
      <ErrorBanner error={error} />
      <table className="table">
        <tbody>
          {data?.events.map((e) => <tr key={e.id}><td className="small">{fmtTime(e.ts)}</td><td>{e.action}</td><td className="small">{e.actorType}</td></tr>)}
        </tbody>
      </table>
    </Card>
  );
}
