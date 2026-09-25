import type { DesiredState } from './desired-state.js';
import type { FamilyPolicy } from './policy.js';
import type { OrgType } from './segments.js';

export interface TransparencyItem {
  key: string;
  title: string;
  detail: string;
}

export interface TransparencyReport {
  managedBy: string;
  organization: string;
  organizationType: OrgType;
  headline: string;
  items: TransparencyItem[];
}

/**
 * Plain-language list of exactly what is monitored/controlled on the device
 * (spec §3.2). The agent renders the same report on its transparency screen and
 * the console shows it to admins, so both sides see identical wording.
 */
export function buildTransparencyReport(input: {
  orgType: OrgType;
  orgName: string;
  managedBy: string;
  state: DesiredState;
}): TransparencyReport {
  const { orgType, orgName, managedBy, state } = input;
  const items: TransparencyItem[] = [];
  const add = (key: string, title: string, detail: string) => items.push({ key, title, detail });

  if (state.released) {
    return {
      managedBy,
      organization: orgName,
      organizationType: orgType,
      headline: 'This device has been released from Redcore management.',
      items: [],
    };
  }

  const headline =
    orgType === 'family'
      ? `This device is managed by a parent/guardian: ${managedBy}.`
      : `This device is owned and managed by ${orgName}.`;

  if (orgType === 'family') {
    const p = state.policy?.spec as FamilyPolicy | undefined;
    if (!p || p.apps.reportUsage) add('apps.usage', 'App list and screen time', 'Installed apps and time spent in each app are shared with your guardian.');
    if (p && (p.apps.blocked.length || p.apps.timeLimits.length || p.apps.categoryLimits.length)) {
      add('apps.limits', 'App limits', `${p.apps.blocked.length} app(s) blocked; ${p.apps.timeLimits.length + p.apps.categoryLimits.length} daily time limit(s).`);
    }
    if (p?.apps.downtime.length) add('apps.downtime', 'Downtime', p.apps.downtime.map((d) => `${d.name} ${d.schedule.start}–${d.schedule.end}`).join('; '));
    if (p?.apps.requireInstallApproval) add('apps.install', 'App installs', 'New apps need guardian approval before they can be installed.');
    if (p?.location.enabled) {
      add('location', 'Location', `Your location is shared every ${p.location.intervalMinutes} minutes and when your guardian requests it. ${p.location.geofences.length} place alert(s) are set.`);
    }
    if (p?.location.sosEnabled) add('location.sos', 'SOS', 'You can send your location to your guardian at any time from the Redcore app.');
    if (p?.camera.disabled) add('camera.disabled', 'Camera', 'The camera is turned off.');
    if (p?.camera.disabledSchedules.length) add('camera.schedule', 'Camera schedule', 'The camera is turned off during scheduled hours.');
    if (p && (p.camera.cameraDeniedPackages.length || p.camera.microphoneDeniedPackages.length)) {
      add('camera.permissions', 'Camera & microphone permissions', `Camera access removed for ${p.camera.cameraDeniedPackages.length} app(s); microphone access removed for ${p.camera.microphoneDeniedPackages.length} app(s). Redcore never records audio or video.`);
    }
    if (p && p.comms.sms !== 'off') {
      add('comms.sms', 'Text messages', p.comms.sms === 'content' ? 'SMS senders, times and message text are shared with your guardian.' : 'SMS senders and times (not message text) are shared with your guardian.');
    }
    if (p?.comms.callLog) add('comms.calls', 'Call history', 'Incoming, outgoing and missed calls (number, time, duration) are shared with your guardian.');
    if (p?.comms.contacts) add('comms.contacts', 'Contacts', 'Your saved contacts are shared with your guardian.');
    if (p?.comms.blockedNumbers.length) add('comms.blocked', 'Blocked numbers', `${p.comms.blockedNumbers.length} number(s) are blocked from calling.`);
    if (p?.comms.unknownNumberAlerts) add('comms.unknown', 'Unknown number alerts', 'Your guardian is alerted about calls or texts from numbers not in your contacts.');
    if (p?.comms.keywordAlerts) add('comms.keywords', 'Safety keyword alerts (SMS)', 'Messages are checked on this phone for safety keywords; only matches are sent as alerts.');
    if (p?.social.notificationSafetySignals) {
      add('social.signals', 'Safety keyword alerts (notifications)', 'Notifications are checked on this phone for safety keywords; only matches are sent as alerts. Private chats are never read or decrypted.');
    }
    if (p?.kiosk.studyMode.schedules.length) add('kiosk.study', 'Study mode', 'During scheduled hours only approved apps can be used.');
    if (p?.antiTheft.enabled) add('antitheft', 'Lost-device mode', 'If this device is reported lost, it may take a photo and share its location. You will see a notice when this happens.');
  } else {
    add('kiosk', 'Device lock', orgType === 'emi'
      ? 'If an EMI payment is overdue this device may be limited to the payment screen. Emergency calls always remain available.'
      : 'This device may be locked to approved work apps by your administrator. Emergency calls always remain available.');
    add('wallpaper', 'Wallpaper', state.wallpaper?.lockChange ? 'The wallpaper is set by your organization and cannot be changed.' : 'Your organization may set the wallpaper.');
    if (state.userRestrictions.includes('no_factory_reset')) add('antitamper', 'Anti-tamper', 'Factory reset, safe mode and adding users are disabled on this company-owned device.');
    add('nodata', 'No personal data collected', 'Redcore does not collect location, messages, calls, contacts or app usage on this device.');
  }

  if (state.kiosk.mode !== 'none') add('kiosk.active', 'Lock active now', lockDescription(state));

  return { managedBy, organization: orgName, organizationType: orgType, headline, items };
}

function lockDescription(state: DesiredState): string {
  switch (state.kiosk.mode) {
    case 'payment_due':
      return 'This device is locked because a payment is overdue. Emergency calls and the payment screen are available.';
    case 'payment_nag':
      return 'A payment is overdue. A reminder screen is shown until it is paid.';
    case 'study':
      return 'Study mode is on: only approved apps can be used.';
    case 'full':
      return 'This device is locked by your administrator. Emergency calls are available.';
    default:
      return 'This device is locked to approved apps.';
  }
}
