import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Wraps an async action with busy + error state for buttons and forms. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e as Error);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function ErrorBanner({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  const details = error instanceof ApiError ? error.details : undefined;
  return (
    <div className="banner banner-error" role="alert">
      <strong>{error instanceof ApiError ? error.code.replace(/_/g, ' ').toLowerCase() : 'Error'}:</strong> {error.message}
      {details?.length ? (
        <ul>
          {details.map((d, i) => (
            <li key={i}>
              <code>{d.path || '(root)'}</code> {d.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'red' | 'green' | 'amber' | 'blue'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small className="field-hint">{hint}</small>}
      </span>
    </label>
  );
}

export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

export function fmtAgo(iso: string | null | undefined) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const kioskLabel: Record<string, string> = {
  none: 'Unlocked',
  single_purpose: 'Kiosk',
  full: 'Locked',
  study: 'Study mode',
  payment_due: 'Payment lock',
  payment_nag: 'Payment reminder',
};

export const kioskTone = (mode: string) => (mode === 'none' ? 'green' : mode === 'payment_nag' || mode === 'study' ? 'amber' : 'red');

export const splitList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
