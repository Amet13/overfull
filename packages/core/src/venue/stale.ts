import type { Problem } from '../types.js';
import type { VenueProfile } from './types.js';

/** A profile is flagged when its `checkedOn` date is more than this many months old. */
export const STALE_AFTER_MONTHS = 14;

/** A profile is flagged this many days after its edition's submission deadline. */
export const DEADLINE_GRACE_DAYS = 30;

const DAY_MS = 86_400_000;

function utcDate(s: string | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
}

/**
 * Info note when the venue profile is for an edition whose submission deadline passed more
 * than 30 days ago, or else when it was last compared with the official pages long ago.
 */
export function staleProfileProblems(profile: VenueProfile, now: Date): Problem[] {
  const sources = profile.source?.length ? ` (${profile.source.join(', ')})` : '';
  const deadline = utcDate(profile.deadline);
  if (deadline) {
    const days = Math.floor((now.getTime() - deadline.getTime()) / DAY_MS);
    if (days > DEADLINE_GRACE_DAYS) {
      return [
        {
          rule: 'venue-profile-stale',
          check: 'venue',
          severity: 'info',
          message: `Profile ${profile.id} is for an edition whose submission deadline (${profile.deadline}) passed ${days} days ago; a later edition may have other rules`,
          fix: `For a camera-ready version, follow the venue's final instructions. For a later edition, read its call for papers${sources} and use its profile when there is one`,
          data: { profile: profile.id, deadline: profile.deadline, days },
        },
      ];
    }
  }
  const checked = utcDate(profile.checkedOn);
  if (!checked) return [];
  const limit = new Date(checked);
  limit.setUTCMonth(limit.getUTCMonth() + STALE_AFTER_MONTHS);
  if (now.getTime() <= limit.getTime()) return [];
  return [
    {
      rule: 'venue-profile-stale',
      check: 'venue',
      severity: 'info',
      message: `Profile ${profile.id} was last checked against the venue's pages on ${profile.checkedOn}; it may be out of date`,
      fix: `Read the venue's current instructions${sources} before you submit`,
      data: { profile: profile.id, checkedOn: profile.checkedOn, months: STALE_AFTER_MONTHS },
    },
  ];
}
