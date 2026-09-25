import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, Card, ErrorBanner, Field, PageHeader, useAction, useAsync } from '../components/ui';
import { useSession } from '../session';

interface AdminRow {
  id: string;
  role: string;
  email: string;
  displayName: string;
  mfaEnabled: boolean;
  disabledAt: string | null;
}

export default function SettingsPage() {
  const { org, me, canManage, reload } = useSession();
  const [name, setName] = useState(org?.name ?? '');
  const [retention, setRetention] = useState(String(org?.retentionDays ?? 30));
  const [secret, setSecret] = useState<string | null>(null);
  const act = useAction();
  const admins = useAsync(() => (canManage ? api.get<{ admins: AdminRow[] }>('/admins') : Promise.resolve({ admins: [] })), [canManage]);
  const [na, setNa] = useState({ email: '', displayName: '', role: 'operator', temporaryPassword: '' });

  async function saveOrg(e: FormEvent) {
    e.preventDefault();
    await act.run(async () => {
      await api.patch('/org', { name, retentionDays: Number(retention) });
      await reload();
    });
  }

  async function addAdmin(e: FormEvent) {
    e.preventDefault();
    await act.run(async () => {
      await api.post('/admins', na);
      setNa({ email: '', displayName: '', role: 'operator', temporaryPassword: '' });
      await admins.reload();
    });
  }

  if (!org) return null;
  return (
    <>
      <PageHeader title="Settings" />
      <ErrorBanner error={act.error ?? admins.error} />
      <Card title="Organization">
        <form onSubmit={saveOrg} className="form-grid two">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} /></Field>
          {org.phase === 1 && (
            <Field label="Data retention (days)" hint="Collected data older than this is deleted automatically.">
              <input type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} disabled={!canManage} />
            </Field>
          )}
          {canManage && <button className="btn btn-primary">Save</button>}
        </form>
      </Card>

      {org.type === 'emi' && canManage && (
        <Card title="Payment gateway webhook">
          <p>Configure your payment gateway to POST payment notifications to:</p>
          <p><code className="break">{org.webhookUrl}</code></p>
          <p className="small muted">
            Sign each request with HMAC-SHA256 over <code>{'`${timestamp}.${rawBody}`'}</code> using the secret, and send
            <code> X-Redcore-Timestamp</code> (unix seconds) and <code>X-Redcore-Signature: sha256=&lt;hex&gt;</code>.
            Body: <code>{'{ accountRef, paymentRef, amount, paidAt? }'}</code>.
          </p>
          {secret ? (
            <div className="banner banner-warn">Copy this secret now; it will not be shown again: <code className="break">{secret}</code></div>
          ) : (
            <button className="btn" onClick={() => {
              if (org.webhookConfigured && !confirm('Rotate the secret? The current one stops working immediately.')) return;
              void act.run(async () => { setSecret((await api.post('/org/webhook-secret')).secret); await reload(); });
            }}>{org.webhookConfigured ? 'Rotate secret' : 'Generate secret'}</button>
          )}
        </Card>
      )}

      {canManage && (
        <Card title="Administrators">
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>MFA</th><th /></tr></thead>
            <tbody>
              {admins.data?.admins.map((a) => (
                <tr key={a.id}>
                  <td>{a.displayName}</td>
                  <td>{a.email}</td>
                  <td>{a.role.replace('_', ' ')}</td>
                  <td>{a.mfaEnabled ? <Badge tone="green">On</Badge> : <Badge tone="amber">Not set up</Badge>}</td>
                  <td>{a.disabledAt ? <Badge>Disabled</Badge> : a.id !== me?.admin.id && (
                    <button className="btn btn-sm" onClick={() => { if (confirm(`Disable ${a.email}?`)) void act.run(async () => { await api.del(`/admins/${a.id}`); await admins.reload(); }); }}>Disable</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <form onSubmit={addAdmin} className="form-grid two">
            <Field label="Name"><input value={na.displayName} onChange={(e) => setNa({ ...na, displayName: e.target.value })} required /></Field>
            <Field label="Email"><input type="email" value={na.email} onChange={(e) => setNa({ ...na, email: e.target.value })} required /></Field>
            <Field label="Role">
              <select value={na.role} onChange={(e) => setNa({ ...na, role: e.target.value })}>
                <option value="org_admin">Org admin — full access</option>
                <option value="operator">Operator — lock, unlock, wallpaper, messages</option>
                <option value="read_only">Read-only</option>
              </select>
            </Field>
            <Field label="Temporary password" hint="At least 10 characters. They will set up MFA on first sign-in.">
              <input type="password" value={na.temporaryPassword} onChange={(e) => setNa({ ...na, temporaryPassword: e.target.value })} minLength={10} required />
            </Field>
            <button className="btn">Add administrator</button>
          </form>
        </Card>
      )}

      <Card title="Command signing key">
        <p className="small muted">Devices only accept commands signed with the matching private key. Build the agent with this public key (<code>REDCORE_COMMAND_PUBLIC_KEY</code>).</p>
        <code className="break small">{org.commandPublicKey}</code>
      </Card>
    </>
  );
}
