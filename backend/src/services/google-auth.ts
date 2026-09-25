import { importPKCS8, SignJWT } from 'jose';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

/** Minimal OAuth2 service-account flow (JWT bearer grant) for FCM and Play Integrity. */
export class GoogleAuth {
  private readonly sa: ServiceAccount;
  private readonly cache = new Map<string, { token: string; exp: number }>();

  constructor(json: string) {
    this.sa = JSON.parse(json) as ServiceAccount;
  }

  get projectId(): string | undefined {
    return this.sa.project_id;
  }

  async accessToken(scope: string): Promise<string> {
    const cached = this.cache.get(scope);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const tokenUri = this.sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const key = await importPKCS8(this.sa.private_key, 'RS256');
    const assertion = await new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.sa.client_email)
      .setAudience(tokenUri)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cache.set(scope, { token: body.access_token, exp: Date.now() + body.expires_in * 1000 });
    return body.access_token;
  }
}
