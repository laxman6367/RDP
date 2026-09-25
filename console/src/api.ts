// Thin client for the Redcore backend (/v1). Keeps the access token in memory
// and the refresh token in sessionStorage, refreshing transparently on 401.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const REFRESH_KEY = 'redcore.refresh';

let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  mfa: boolean;
  mfaEnrollmentRequired?: boolean;
}

export const auth = {
  set(t: Tokens) {
    accessToken = t.accessToken;
    sessionStorage.setItem(REFRESH_KEY, t.refreshToken);
  },
  clear() {
    accessToken = null;
    sessionStorage.removeItem(REFRESH_KEY);
  },
  hasSession: () => !!accessToken || !!sessionStorage.getItem(REFRESH_KEY),
  onLost(fn: () => void) {
    onAuthLost = fn;
  },
};

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const rt = sessionStorage.getItem(REFRESH_KEY);
  if (!rt) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      auth.set(await res.json());
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function raw(method: string, path: string, body?: unknown, init: RequestInit = {}, retry = true): Promise<Response> {
  if (!accessToken && retry) await refresh();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/v1${path}`, { ...init, method, headers, body: payload });
  if (res.status === 401 && retry && !path.startsWith('/auth/login')) {
    if (await refresh()) return raw(method, path, body, init, false);
    auth.clear();
    onAuthLost?.();
  }
  if (!res.ok) {
    let err: { error?: string; message?: string; details?: Array<{ path: string; message: string }> } = {};
    try {
      err = await res.json();
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, err.error ?? 'ERROR', err.message ?? res.statusText, err.details);
  }
  return res;
}

export const api = {
  get: async <T = any>(path: string): Promise<T> => (await raw('GET', path)).json(),
  post: async <T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
    (await raw('POST', path, body ?? {}, { headers })).json(),
  put: async <T = any>(path: string, body?: unknown): Promise<T> => (await raw('PUT', path, body ?? {})).json(),
  patch: async <T = any>(path: string, body?: unknown): Promise<T> => (await raw('PATCH', path, body ?? {})).json(),
  del: async <T = any>(path: string): Promise<T> => (await raw('DELETE', path)).json(),
  blob: async (path: string): Promise<Blob> => (await raw('GET', path)).blob(),
  login: async (email: string, password: string, totp?: string): Promise<Tokens> => {
    const res = await fetch(`${BASE}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, ...(totp ? { totp } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? 'Login failed');
    auth.set(data);
    return data;
  },
  logout: async () => {
    const rt = sessionStorage.getItem(REFRESH_KEY);
    if (rt) await fetch(`${BASE}/v1/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) }).catch(() => {});
    auth.clear();
  },
};

export async function download(path: string, filename: string) {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

export const newIdempotencyKey = () => crypto.randomUUID();
