import type { FastifyBaseLogger } from 'fastify';
import type { GoogleAuth } from './google-auth.js';

/**
 * Silent wake-up channel (spec §7). The push carries no command data — the
 * agent always pulls commands over HTTPS, since push delivery isn't guaranteed.
 */
export interface PushService {
  wake(fcmToken: string | null | undefined, reason: string): Promise<void>;
}

export class NoopPushService implements PushService {
  readonly sent: Array<{ token: string; reason: string }> = [];
  async wake(fcmToken: string | null | undefined, reason: string): Promise<void> {
    if (fcmToken) this.sent.push({ token: fcmToken, reason });
  }
}

export class FcmPushService implements PushService {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly projectId: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async wake(fcmToken: string | null | undefined, reason: string): Promise<void> {
    if (!fcmToken) return;
    try {
      const token = await this.auth.accessToken('https://www.googleapis.com/auth/firebase.messaging');
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { token: fcmToken, data: { t: 'sync', r: reason }, android: { priority: 'HIGH', ttl: '86400s' } },
        }),
      });
      if (!res.ok) this.log.warn({ status: res.status, reason }, 'FCM wake failed');
    } catch (err) {
      // Never fail the admin request because push failed; the agent also polls.
      this.log.warn({ err, reason }, 'FCM wake error');
    }
  }
}
