import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Card, ErrorBanner, Field, fmtTime, PageHeader, Toggle, useAction, useAsync } from '../components/ui';
import { useSession } from '../session';
import type { Policy } from '../types';

interface TokenResult {
  id: string;
  code: string;
  expiresAt: string;
  attestationText: string;
  pairingQr: string;
  provisioningQr: string | null;
}

function Qr({ value, caption }: { value: string; caption: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(value, { margin: 1, width: 260, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [value]);
  return (
    <figure className="qr-figure">
      {src && <img src={src} alt={caption} className="qr" />}
      <figcaption className="small muted">{caption}</figcaption>
    </figure>
  );
}

export default function EnrollPage() {
  const { org, me } = useSession();
  const family = org?.type === 'family';
  const policies = useAsync(() => api.get<{ policies: Policy[] }>('/policies'), []);
  const [subjectLabel, setSubjectLabel] = useState('');
  const [ownerRef, setOwnerRef] = useState('');
  const [age, setAge] = useState('');
  const [mode, setMode] = useState<'device_owner' | 'profile_owner'>('device_owner');
  const [attesterName, setAttesterName] = useState(me?.admin.displayName ?? '');
  const [attest, setAttest] = useState(false);
  const [coppa, setCoppa] = useState(false);
  const [policyId, setPolicyId] = useState('');
  const [result, setResult] = useState<TokenResult | null>(null);
  const { busy, error, run } = useAction();
  const ageNum = age === '' ? undefined : Number(age);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      setResult(
        await api.post<TokenResult>('/enrollment-tokens', {
          subjectLabel,
          ...(ownerRef ? { ownerRef } : {}),
          managementMode: family ? mode : 'device_owner',
          ownership: family && mode === 'profile_owner' ? 'byod' : 'company',
          consentType: family ? 'guardian_of_minor' : 'company_owned',
          ...(family ? { subjectAge: ageNum, coppaParentalConsent: coppa } : {}),
          guardianAttestation: attest,
          attesterName,
          ...(policyId ? { policyId } : {}),
        }),
      );
    });
  }

  if (result) {
    return (
      <>
        <PageHeader title="Enrollment ready" subtitle={`Valid until ${fmtTime(result.expiresAt)} · single use`} />
        <Card>
          <div className="enroll-result">
            <div>
              <p className="muted">Pairing code</p>
              <p className="pairing-code">{result.code.slice(0, 3)} {result.code.slice(3)}</p>
              <ol className="steps">
                {result.provisioningQr ? (
                  <>
                    <li>Factory-reset the device (or take it out of the box).</li>
                    <li>On the welcome screen, tap the screen six times to open the QR scanner.</li>
                    <li>Scan the <strong>provisioning QR</strong>. The device downloads Redcore and becomes managed.</li>
                    <li>The device holder reviews the notice below and accepts.</li>
                  </>
                ) : (
                  <>
                    <li>Install Redcore on the child’s phone.</li>
                    <li>Open it and scan the <strong>pairing QR</strong>, or type the code.</li>
                    <li>Follow the guided permission steps together with your child.</li>
                  </>
                )}
              </ol>
            </div>
            {result.provisioningQr && <Qr value={result.provisioningQr} caption="Provisioning QR (Device Owner setup)" />}
            <Qr value={result.pairingQr} caption="Pairing QR (Redcore app)" />
          </div>
          <div className="banner banner-info"><strong>Notice shown to the device holder:</strong> {result.attestationText}</div>
          <button className="btn" onClick={() => setResult(null)}>Enroll another device</button>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Enroll a device" subtitle={family ? 'Pair your child’s phone with Redcore.' : 'Provision a company-owned device as Device Owner.'} />
      <Card>
        <form onSubmit={submit} className="form-grid">
          <ErrorBanner error={error} />
          <Field label={family ? 'Child’s name' : 'Device label'}>
            <input value={subjectLabel} onChange={(e) => setSubjectLabel(e.target.value)} required maxLength={120} placeholder={family ? 'Riya' : 'Handset 0042'} />
          </Field>
          {family ? (
            <>
              <Field label="Child’s age" hint="Parental control is only available for children under 18.">
                <input type="number" min={0} max={17} value={age} onChange={(e) => setAge(e.target.value)} required />
              </Field>
              <Field label="Setup type">
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  <option value="device_owner">Fully managed (new or reset phone) — all features incl. kiosk</option>
                  <option value="profile_owner">Work profile on an existing phone — no kiosk</option>
                </select>
              </Field>
            </>
          ) : (
            <Field label={org?.type === 'emi' ? 'Loan account / customer reference' : 'Employee / officer reference'}>
              <input value={ownerRef} onChange={(e) => setOwnerRef(e.target.value)} maxLength={120} />
            </Field>
          )}
          <Field label="Initial policy">
            <select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
              <option value="">— None —</option>
              {policies.data?.policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label={family ? 'Your full name (parent / guardian)' : 'Attesting officer / team'}>
            <input value={attesterName} onChange={(e) => setAttesterName(e.target.value)} required minLength={2} />
          </Field>
          <div className="attest">
            <Toggle
              checked={attest}
              onChange={setAttest}
              label={family
                ? 'I am the parent or legal guardian of this child. I will tell them the phone is managed, and I understand a notice is always shown on the device.'
                : 'This device is owned by our organization (financed, issued or corporate). The holder has been informed of the management and locking terms, and emergency calls stay available.'}
            />
            {family && ageNum !== undefined && ageNum < 13 && (
              <Toggle checked={coppa} onChange={setCoppa} label="I give verifiable parental consent for the data collection described (required for children under 13 — COPPA)." />
            )}
          </div>
          <button className="btn btn-primary" disabled={busy || !attest}>Generate pairing code</button>
        </form>
      </Card>
    </>
  );
}
