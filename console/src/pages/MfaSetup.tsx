import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { api, auth } from '../api';
import { ErrorBanner, Field, useAction } from '../components/ui';
import { useSession } from '../session';

export default function MfaSetupPage() {
  const { reload, signOut, me } = useSession();
  const [secret, setSecret] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (me?.admin.mfaEnabled) return;
    void run(async () => {
      const s = await api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/setup');
      setSecret(s.secret);
      setQr(await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 220 }));
    });
  }, [me, run]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      auth.set(await api.post('/auth/mfa/enable', { code }));
      await reload();
    });
  }

  if (me?.admin.mfaEnabled) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h2>Verification required</h2>
          <p>Sign in again with your authenticator code.</p>
          <button className="btn btn-primary btn-block" onClick={() => void signOut()}>Sign in again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h2>Set up two-factor authentication</h2>
        <p className="muted">Multi-factor authentication is required for every Redcore administrator. Scan this code with Google Authenticator, Microsoft Authenticator, 1Password or similar.</p>
        <ErrorBanner error={error} />
        {qr && <img src={qr} alt="Authenticator QR code" className="qr" />}
        {secret && <p className="small">Or enter this key manually: <code className="break">{secret}</code></p>}
        <Field label="6-digit code">
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" pattern="\d{6}" required autoFocus />
        </Field>
        <button className="btn btn-primary btn-block" disabled={busy || !secret}>Verify and continue</button>
        <button type="button" className="btn btn-link" onClick={() => void signOut()}>Sign out</button>
      </form>
    </div>
  );
}
