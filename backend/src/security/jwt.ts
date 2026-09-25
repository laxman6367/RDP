import { jwtVerify, SignJWT } from 'jose';
import type { Role } from '../domain/roles.js';

export interface AccessClaims {
  sub: string;
  org: string | null;
  role: Role;
  /** True when the session completed a TOTP challenge. */
  mfa: boolean;
}

export class JwtService {
  private readonly key: Uint8Array;

  constructor(secret: string, private readonly ttlSeconds: number) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ org: claims.org, role: claims.role, mfa: claims.mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer('redcore')
      .setAudience('redcore-console')
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'redcore', audience: 'redcore-console' });
    return {
      sub: String(payload.sub),
      org: (payload.org as string | null) ?? null,
      role: payload.role as Role,
      mfa: payload.mfa === true,
    };
  }
}
