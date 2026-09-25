import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Spinner } from './components/ui';
import AlertsPage from './pages/Alerts';
import AuditPage from './pages/Audit';
import DevicePage from './pages/Device';
import EnrollPage from './pages/Enroll';
import FleetPage from './pages/Fleet';
import LoansPage from './pages/Loans';
import LoginPage from './pages/Login';
import MfaSetupPage from './pages/MfaSetup';
import PoliciesPage from './pages/Policies';
import SettingsPage from './pages/Settings';
import WallpapersPage from './pages/Wallpapers';
import { useSession } from './session';

const SEGMENT_LABEL = { family: 'Parental control', emi: 'EMI finance', govt: 'Government', enterprise: 'Enterprise' } as const;

export default function App() {
  const { me, org, loading, signOut, can } = useSession();
  if (loading) return <div className="center-screen"><Spinner /></div>;
  if (!me) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  if (me.mfaRequired && !me.admin.mfa) return <MfaSetupPage />;
  if (!org) return <div className="center-screen"><Spinner /></div>;

  const family = org.type === 'family';
  return (
    <div className="shell">
      <aside className="sidebar">
        <img src="/redcore-logo.png" alt="Redcore MDM" className="logo" />
        <div className="org-chip">
          <strong>{org.name}</strong>
          <span>{SEGMENT_LABEL[org.type]} · Phase {org.phase}</span>
        </div>
        <nav>
          <NavLink to="/devices">{family ? 'Children’s devices' : 'Fleet'}</NavLink>
          <NavLink to="/enroll">Enroll device</NavLink>
          <NavLink to="/policies">Policies</NavLink>
          {can('loans') && <NavLink to="/loans">Loan accounts</NavLink>}
          {can('wallpaper') && <NavLink to="/wallpapers">Wallpapers</NavLink>}
          <NavLink to="/alerts">Alerts</NavLink>
          <NavLink to="/audit">Audit log</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-footer">
          <span className="muted">{me.admin.displayName}</span>
          <span className="muted small">{me.admin.role.replace('_', ' ')}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/devices" replace />} />
          <Route path="/devices" element={<FleetPage />} />
          <Route path="/devices/:id" element={<DevicePage />} />
          <Route path="/enroll" element={<EnrollPage />} />
          <Route path="/policies" element={<PoliciesPage />} />
          <Route path="/loans" element={<LoansPage />} />
          <Route path="/wallpapers" element={<WallpapersPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/devices" replace />} />
        </Routes>
      </main>
    </div>
  );
}
