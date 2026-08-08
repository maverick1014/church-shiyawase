import type { SheetColumn, SheetMeeting, SheetTickName } from './types';
import { churchParts, sundaysOfMonth } from './time';

/**
 * 聚会点名 — the columns of one month's roll-call sheet.
 *
 * The sheet has ONE table and two kinds of column, because a month contains
 * two kinds of occasion:
 *
 *   sunday  — every Sunday of the month, straight from the calendar. Nobody
 *             creates one, so a Sunday nobody marked still gets its column.
 *             It carries the two ticks a Sunday has: 会前 and 主日.
 *   meeting — a meeting someone genuinely added (a 31 August night prayer
 *             meeting). One occasion, so exactly ONE tick: 到场. There is no
 *             会前 to invent for it.
 *
 * The two live in different tables (`sunday_attendance` / `event_attendance`),
 * and this module is what keeps that out of the page: the API answers with one
 * ordered list of columns, each carrying its own key and its own tick names,
 * and the page renders whatever it is given. The key is also what a write
 * quotes back (`PUT /api/attendance/sheet`), so the SERVER — not the page —
 * decides which table a tick lands in.
 *
 * Everything here works on `YYYY-MM-DD` labels and Malaysian wall-clock
 * readings (rule G6a): which dates a month holds, and which day a 20:00
 * meeting belongs to, must not depend on the runtime's zone.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** The ticks each kind of column carries. */
export const SUNDAY_TICKS: readonly SheetTickName[] = ['pre_service', 'service'];
export const MEETING_TICKS: readonly SheetTickName[] = ['attended'];

/** Canonical order of the tick names, for the sheet's total columns. */
export const TICK_ORDER: readonly SheetTickName[] = ['pre_service', 'service', 'attended'];

export const sundayColumnKey = (date: string) => `sunday:${date}`;
export const meetingColumnKey = (eventId: string) => `meeting:${eventId}`;

/**
 * A column key, read back. The write endpoint takes the key the read handed
 * out and resolves it here, so "which table does this cell live in" is
 * answered in exactly one place instead of by the client.
 */
export type ParsedColumn =
  | { kind: 'sunday'; date: string }
  | { kind: 'meeting'; eventId: string };

export function parseColumnKey(key: string | null | undefined): ParsedColumn | null {
  const value = String(key ?? '');
  const sep = value.indexOf(':');
  if (sep <= 0) return null;
  const rest = value.slice(sep + 1);
  if (!rest) return null;
  if (value.slice(0, sep) === 'sunday') return { kind: 'sunday', date: rest };
  if (value.slice(0, sep) === 'meeting') return { kind: 'meeting', eventId: rest };
  return null;
}

/**
 * One month's columns, in the order they are read across the sheet: by date,
 * and within a date the Sunday first (the fixed point of that day) then the
 * meetings by their own time of day.
 *
 * The tie-breakers are the meeting's title and finally its id, so two meetings
 * added for the same minute always come out in the same order — a grid whose
 * columns shuffle between two reads would move a tick under the cursor.
 */
export function sheetColumns(
  year: number,
  month: number,
  meetings: readonly SheetMeeting[],
): SheetColumn[] {
  const entries: { at: string; column: SheetColumn }[] = sundaysOfMonth(year, month).map(
    (date) => ({
      // '0' sorts the Sunday ahead of that day's meetings, whatever time they
      // were set for — a Sunday has no time of its own to compare with.
      at: `${date} 0`,
      column: {
        key: sundayColumnKey(date),
        kind: 'sunday',
        date,
        ticks: [...SUNDAY_TICKS],
        meeting: null,
      },
    }),
  );

  for (const meeting of meetings) {
    const p = churchParts(new Date(meeting.starts_at));
    const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    entries.push({
      at: `${date} 1 ${pad(p.hour)}:${pad(p.minute)} ${meeting.title} ${meeting.id}`,
      column: {
        key: meetingColumnKey(meeting.id),
        kind: 'meeting',
        date,
        ticks: [...MEETING_TICKS],
        meeting,
      },
    });
  }

  // Plain comparison, never `localeCompare`: the order has to be identical on
  // the Worker and in the browser, and a locale-aware collation is not.
  return entries
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((e) => e.column);
}

/**
 * Which ticks this sheet actually holds, in canonical order — one total column
 * each. A month with no hand-added meeting has no 到场 total to draw.
 */
export function sheetTicks(columns: readonly SheetColumn[]): SheetTickName[] {
  const present = new Set<SheetTickName>();
  for (const c of columns) for (const t of c.ticks) present.add(t);
  return TICK_ORDER.filter((t) => present.has(t));
}
