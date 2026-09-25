import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Badge, Card, Empty, ErrorBanner, Field, PageHeader, Spinner, Toggle, useAction, useAsync } from '../components/ui';
import { useSession } from '../session';
import type { DeviceSummary, Loan } from '../types';

const TIER: Record<Loan['tier'], { label: string; tone: 'green' | 'blue' | 'amber' | 'red' }> = {
  ok: { label: 'Current', tone: 'green' },
  reminder: { label: 'Reminder', tone: 'blue' },
  nag: { label: 'Overdue (reminder screen)', tone: 'amber' },
  hard_lock: { label: 'Overdue (locked)', tone: 'red' },
};

/** Monthly schedule starting at `first` (YYYY-MM-DD). */
function monthly(first: string, count: number, amount: number) {
  const [y, m, d] = first.split('-').map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, i) => {
    const dt = new Date(Date.UTC(y, m - 1 + i, 1));
    const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(d, last));
    return { dueDate: dt.toISOString().slice(0, 10), amount };
  });
}

function NewLoan({ onCreated }: { onCreated: () => void }) {
  const devices = useAsync(() => api.get<{ devices: DeviceSummary[] }>('/devices?status=active'), []);
  const [f, setF] = useState({ deviceId: '', accountRef: '', amount: '2500', count: '12', first: new Date().toISOString().slice(0, 10), supportContact: '', paymentUrl: '', graceDays: '2', hardLockAfterDays: '7', disclosed: false });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const act = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    await act.run(async () => {
      await api.post('/loans', {
        deviceId: f.deviceId,
        accountRef: f.accountRef,
        supportContact: f.supportContact,
        ...(f.paymentUrl ? { paymentUrl: f.paymentUrl } : {}),
        graceDays: Number(f.graceDays),
        hardLockAfterDays: Number(f.hardLockAfterDays),
        termsDisclosedAt: new Date().toISOString(),
        installments: monthly(f.first, Number(f.count), Number(f.amount)),
      });
      onCreated();
    });
  }

  return (
    <Card title="New loan account">
      <form onSubmit={submit} className="form-grid two">
        <ErrorBanner error={act.error} />
        <Field label="Device">
          <select value={f.deviceId} onChange={set('deviceId')} required>
            <option value="">Select…</option>
            {devices.data?.devices.filter((d) => d.managementMode === 'device_owner').map((d) => <option key={d.id} value={d.id}>{d.displayName}{d.ownerRef ? ` · ${d.ownerRef}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Loan account reference"><input value={f.accountRef} onChange={set('accountRef')} required /></Field>
        <Field label="Installment amount (INR)"><input type="number" min={1} step="0.01" value={f.amount} onChange={set('amount')} required /></Field>
        <Field label="Number of monthly installments"><input type="number" min={1} max={360} value={f.count} onChange={set('count')} required /></Field>
        <Field label="First due date"><input type="date" value={f.first} onChange={set('first')} required /></Field>
        <Field label="Support contact (shown on lock screen)"><input value={f.supportContact} onChange={set('supportContact')} required /></Field>
        <Field label="Payment link (https)"><input type="url" value={f.paymentUrl} onChange={set('paymentUrl')} /></Field>
        <Field label="Grace days before reminder screen"><input type="number" min={0} value={f.graceDays} onChange={set('graceDays')} /></Field>
        <Field label="Days overdue before full lock"><input type="number" min={1} value={f.hardLockAfterDays} onChange={set('hardLockAfterDays')} /></Field>
        <div className="attest full">
          <Toggle checked={f.disclosed} onChange={(v) => setF({ ...f, disclosed: v })} label="The buyer was shown the locking terms at sale, and emergency calling stays available when locked." />
        </div>
        <button className="btn btn-primary" disabled={act.busy || !f.disclosed}>Create loan</button>
      </form>
    </Card>
  );
}

function LoanDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.get<Loan>(`/loans/${id}`), [id]);
  const [ref, setRef] = useState('');
  const [amount, setAmount] = useState('');
  const act = useAction();
  const { canManage } = useSession();
  if (loading) return <Spinner />;
  if (!data) return <ErrorBanner error={error} />;
  const refresh = async () => { await reload(); onChange(); };
  return (
    <Card title={`Loan ${data.accountRef}`}>
      <ErrorBanner error={act.error} />
      <table className="table">
        <thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Paid</th></tr></thead>
        <tbody>
          {data.installments.map((i) => (
            <tr key={i.id}><td>{i.seq}</td><td>{i.dueDate}</td><td>{data.currency} {i.amount.toFixed(2)}</td><td>{i.paidAt ? <Badge tone="green">{i.paymentRef}</Badge> : '—'}</td></tr>
          ))}
        </tbody>
      </table>
      {canManage && data.status === 'active' && (
        <>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api.post(`/loans/${id}/payments`, { paymentRef: ref, amount: Number(amount) }); setRef(''); setAmount(''); await refresh(); }); }}>
            <Field label="Payment reference"><input value={ref} onChange={(e) => setRef(e.target.value)} required /></Field>
            <Field label="Amount"><input type="number" step="0.01" min={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
            <button className="btn">Record payment</button>
          </form>
          <Toggle checked={data.autoLockPaused} onChange={(v) => void act.run(async () => { await api.patch(`/loans/${id}`, { autoLockPaused: v }); await refresh(); })} label="Pause automatic locking for this account" />
        </>
      )}
    </Card>
  );
}

export default function LoansPage() {
  const { org, canManage } = useSession();
  const { data, error, loading, reload } = useAsync(() => api.get<{ loans: Loan[] }>('/loans'), []);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="Loan accounts"
        subtitle={org?.webhookConfigured ? 'Payments received through the gateway webhook unlock devices automatically.' : 'Set up the payment webhook in Settings to unlock devices automatically when payments arrive.'}
        actions={canManage && <button className="btn btn-primary" onClick={() => setCreating(!creating)}>{creating ? 'Cancel' : '+ New loan'}</button>}
      />
      {creating && <NewLoan onCreated={() => { setCreating(false); void reload(); }} />}
      <Card>
        <ErrorBanner error={error} />
        {loading ? <Spinner /> : !data?.loans.length ? <Empty>No loan accounts.</Empty> : (
          <table className="table">
            <thead><tr><th>Account</th><th>Device</th><th>Status</th><th>Next due</th><th>Amount due</th><th /></tr></thead>
            <tbody>
              {data.loans.map((l) => (
                <tr key={l.id}>
                  <td className="strong">{l.accountRef}</td>
                  <td><Link to={`/devices/${l.deviceId}`}>{l.deviceName}</Link></td>
                  <td>{l.status === 'closed' ? <Badge>Closed</Badge> : <Badge tone={TIER[l.tier].tone}>{TIER[l.tier].label}{l.overdueDays ? ` · ${l.overdueDays}d` : ''}</Badge>}{l.autoLockPaused && <> <Badge>Auto-lock paused</Badge></>}</td>
                  <td>{l.nextDueDate ?? '—'}</td>
                  <td>{l.amountDue ? `${l.currency} ${l.amountDue.toFixed(2)}` : '—'}</td>
                  <td><button className="btn btn-sm" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Hide' : 'Details'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {open && <LoanDetail id={open} onChange={() => void reload()} />}
    </>
  );
}
