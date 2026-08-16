/**
 * Pure aggregation for the dashboard's "New Visits vs Active Members" chart —
 * kept out of the component (rule G5: components stay thin, logic lives in
 * `lib/`, same as `lib/sheet.ts` and `lib/members-import.ts`) and unit-tested
 * on its own.
 *
 * Every date question here goes through `churchParts` (rule G6a) rather than
 * `getFullYear()`/`getMonth()` on a bare `Date` — those read the RUNTIME's
 * zone, which is UTC inside the Cloudflare Worker and the viewer's own zone in
 * the browser, so "the current month" would answer two different things for
 * the same instant. `joined_at` itself is a bare `YYYY-MM-DD` DATE column with
 * no time component, so once "the current month" is known safely, comparing
 * its `YYYY-MM` prefix against another month's needs no further zone handling.
 */

import { MemberStatus, isMemberRole } from '@tog/shared';
import type { MemberRow } from './types';
import { addChurchDays, churchDateKey, churchDayOfWeek, churchParts } from './time';
import type { GroupHealthStatus } from './labels';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Shift a (year, month) pair by `delta` months — `delta` may be negative. */
function shiftMonth(year: number, month1to12: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month1to12 - 1) + delta;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12 + 1;
  return { year: y, month: m };
}

export interface MonthlyTrendPoint {
  /** `YYYY-MM`, in calendar order. */
  month: string;
  /** Members whose 来访日期 (`joined_at`) falls in this month — everyone who
   *  first came then, visitor or member alike; nulls are simply excluded. */
  visits: number;
  /**
   * A CUMULATIVE growth curve, NOT a true historical snapshot: it counts
   * members whose `joined_at` falls on or before this month AND who are
   * active and non-visitor AS OF RIGHT NOW. `status` and `church_role` are
   * only known for today, never for a past month, so this reads "how many of
   * today's active members had joined by then" — not "how many were active
   * back then". Members with no `joined_at` cannot be placed on the timeline
   * and are excluded from both series.
   */
  active: number;
}

/**
 * The trailing `monthsBack` months (oldest first), through the current
 * calendar month in Malaysia.
 */
export function monthlyVisitAndActiveTrend(
  members: readonly MemberRow[],
  monthsBack: number,
  now: Date = new Date(),
): MonthlyTrendPoint[] {
  const n = churchParts(now);
  const months = Array.from({ length: monthsBack }, (_, i) => {
    const { year, month } = shiftMonth(n.year, n.month, i - (monthsBack - 1));
    return `${year}-${pad2(month)}`;
  });

  return months.map((key) => {
    let visits = 0;
    let active = 0;
    for (const m of members) {
      if (!m.joined_at) continue;
      const joinMonth = m.joined_at.slice(0, 7);
      if (joinMonth === key) visits++;
      if (
        joinMonth <= key &&
        m.status === MemberStatus.Active &&
        // `isMemberRole`, not `!== visitor`: a BEST (0031) is no more one of
        // today's active MEMBERS than a 访客 is, and naming the question once
        // means the next non-member role is excluded here for free.
        isMemberRole(m.church_role)
      ) {
        active++;
      }
    }
    return { month: key, visits, active };
  });
}


/* -------------------------------------------------------------------------
 * The pastoral dashboard (0130)
 *
 * The page's four sections are: last Sunday's turnout, who has stopped
 * coming, what is on this week, and how the life groups look. Everything here
 * is the pure half — the API hands down already-counted numbers, and these
 * turn them into what the page draws.
 * ---------------------------------------------------------------------- */

/** One Sunday's two ticks, as the API counts them. */
export interface SundayPoint {
  /** `YYYY-MM-DD`, always a Sunday. */
  date: string;
  /** 会前 — how many were marked before the service. */
  preService: number;
  /** 主日 — how many were marked at it. This is "the attendance". */
  service: number;
}

/**
 * The last `count` Sundays up to and including the most recent one, oldest
 * first.
 *
 * Built by walking back from the Sunday on or before `today` rather than by
 * listing a month, because the run this feeds crosses month boundaries — eight
 * Sundays from mid-January reaches back into November. Every step goes through
 * `addChurchDays` (rule G6a): a bare `Date` arithmetic here would drift by a
 * day for any viewer west of Malaysia.
 */
export function recentSundays(today: Date, count: number): string[] {
  if (count <= 0) return [];
  // 0 = Sunday, so this many days back lands on the Sunday on or before today
  // (today itself when today IS Sunday).
  const back = churchDayOfWeek(today);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(churchDateKey(addChurchDays(today, -back - i * 7)));
  }
  return out;
}

export interface SundayPulse {
  /** The most recent Sunday on record, or null when there is none at all. */
  latest: SundayPoint | null;
  /**
   * Mean 主日 attendance over the Sundays BEFORE the latest one — the bar the
   * latest is being compared against. Null when there is nothing to compare
   * to, which is a different statement from "the average is zero" and is why
   * the page draws no delta at all in that case.
   */
  average: number | null;
  /** `latest.service - average`, rounded; null whenever `average` is. */
  delta: number | null;
  /**
   * How many Sundays the average was actually taken over — which is NOT
   * `points.length - 1` once the leading unmarked run is dropped. The card
   * says "vs the {n}-Sunday average", so it has to be told the real n rather
   * than counting the window itself and overstating it.
   */
  sampled: number;
}

/**
 * Last Sunday against the Sundays before it.
 *
 * The comparison deliberately EXCLUDES the latest Sunday from its own average
 * — comparing a number against a mean it is part of always understates the
 * change, and on a small church with four points it understates it badly.
 *
 * A Sunday nobody marked is a real zero here, not a gap: the sheet stores no
 * rows for an unmarked Sunday, so the API sends 0, and a church that forgot to
 * take the roll call should see the flat line that follows from that rather
 * than have it quietly smoothed away.
 */
export function sundayPulse(points: readonly SundayPoint[]): SundayPulse {
  if (points.length === 0) return { latest: null, average: null, delta: null, sampled: 0 };
  const latest = points[points.length - 1];

  /*
   * LEADING zeroes are dropped before averaging; zeroes in the middle are not.
   *
   * The two are different facts wearing the same 0. Once a church has started
   * taking the roll call, a Sunday with no rows means nobody marked it, and
   * that belongs in the average — it is exactly the "we forgot" this card
   * should surface. But a run of zeroes BEFORE the first Sunday anyone ever
   * marked is not a run of empty services, it is the app not yet being used,
   * and averaging against it produces a number that is arithmetically true and
   * completely misleading: a church two weeks into using this would be told
   * last Sunday was "+9 on the 7-Sunday average" when the comparison had six
   * weeks of pre-history in it.
   *
   * Found by reading the live payload rather than by reasoning about it — the
   * church's own first two marked Sundays sat behind exactly this run.
   */
  const firstMarked = points.findIndex((p) => p.service > 0 || p.preService > 0);
  const history = firstMarked === -1 ? [] : points.slice(firstMarked, -1);
  if (history.length === 0) return { latest, average: null, delta: null, sampled: 0 };
  const mean = history.reduce((sum, p) => sum + p.service, 0) / history.length;
  return { latest, average: mean, delta: Math.round(latest.service - mean), sampled: history.length };
}

/**
 * How many groups sit in each health bucket, in the order the page draws them.
 *
 * Keyed by the STORED status code, never by a translated label (rule G8) —
 * the chips this feeds are language-independent and link into `/groups`'s own
 * filter, which reads the same codes.
 */
export function groupHealthRollup(
  groups: readonly { status: GroupHealthStatus }[],
): { status: GroupHealthStatus; count: number }[] {
  const order: GroupHealthStatus[] = ['splittable', 'balanced', 'need_members'];
  return order.map((status) => ({
    status,
    count: groups.filter((g) => g.status === status).length,
  }));
}
