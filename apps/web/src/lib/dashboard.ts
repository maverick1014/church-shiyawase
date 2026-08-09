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

import { ChurchRole, MemberStatus } from '@tog/shared';
import type { MemberRow } from './types';
import { churchParts } from './time';

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
        m.church_role !== ChurchRole.Visitor
      ) {
        active++;
      }
    }
    return { month: key, visits, active };
  });
}
