import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, auth } from './api';
import type { Capability, Me, Org } from './types';

interface Session {
  me: Me | null;
  org: Org | null;
  loading: boolean;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  can: (cap: Capability) => boolean;
  canCommand: boolean;
  canManage: boolean;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!auth.hasSession()) {
      setMe(null);
      setOrg(null);
      setLoading(false);
      return;
    }
    try {
      const m = await api.get<Me>('/auth/me');
      setMe(m);
      // /org needs a completed MFA session when MFA is mandatory.
      if (!m.mfaRequired || m.admin.mfa) setOrg(await api.get<Org>('/org'));
      else setOrg(null);
    } catch {
      setMe(null);
      setOrg(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    auth.onLost(() => {
      setMe(null);
      setOrg(null);
    });
    void reload();
  }, [reload]);

  const signOut = useCallback(async () => {
    await api.logout();
    setMe(null);
    setOrg(null);
  }, []);

  const role = me?.admin.role;
  const value: Session = {
    me,
    org,
    loading,
    reload,
    signOut,
    can: (cap) => !!org?.capabilities.includes(cap),
    canCommand: role === 'super_admin' || role === 'org_admin' || role === 'operator',
    canManage: role === 'super_admin' || role === 'org_admin',
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
