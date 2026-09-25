import { useState, type FormEvent } from 'react';
import { api, ApiError, auth } from '../api';
import { ErrorBanner, Field, useAction } from '../components/ui';
import { useSession } from '../session';

export default function LoginPage() {
  const { reload } = useSession();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgType, setOrgType] = useState('family');
  const [displayName, setDisplayName] = useState('');
  const { busy, error, run, setError } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      try {
        if (mode === 'register') {
          const t = await api.post('/auth/register', { orgName, orgType, email, password, displayName });
          auth.set(t);
        } else {
          await api.login(email, password, needTotp ? totp : undefined);
        }
        await reload();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'MFA_CODE_REQUIRED') {
          setNeedTotp(true);
          setError(null);
          return;
        }
        throw err;
      }
    });
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <img src="/redcore-logo.png" alt="Redcore MDM" className="auth-logo" />
        <p className="muted">Transparent, consent-based device management.</p>
        <ErrorBanner error={error} />
        {mode === 'register' && (
          <>
            <Field label="Your name">
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </Field>
            <Field label="Account type">
              <select value={orgType} onChange={(e) => setOrgType(e.target.value)}>
                <option value="family">Family — parental control for a child’s phone</option>
                <option value="emi">EMI finance — payment-linked lock</option>
                <option value="govt">Government — officer devices</option>
                <option value="enterprise">Enterprise — company devices</option>
              </select>
            </Field>
            <Field label={orgType === 'family' ? 'Family name' : 'Organization name'}>
              <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required minLength={2} />
            </Field>
          </>
        )}
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </Field>
        <Field label="Password" hint={mode === 'register' ? 'At least 10 characters' : undefined}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'register' ? 10 : 1} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
        </Field>
        {needTotp && (
          <Field label="Authenticator code">
            <input value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" pattern="\d{6}" autoFocus required />
          </Field>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
        </button>
        <button type="button" className="btn btn-link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setNeedTotp(false); }}>
          {mode === 'login' ? 'New to Redcore? Create an account' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
