import type { SheetCell, SheetColumn, SheetMeeting, SheetTickName } from './types';
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

/**
 * Canonical order of the tick names. Nothing on the sheet is ordered by it any
 * more — every column carries its own `ticks` — but it is the complete list of
 * tick names, which is what the dictionary test walks to prove each one has a
 * label in all three languages.
 */
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
 * How one whole column stands: is everybody ticked, nobody, or somebody.
 *
 * This is what the column's check-all control shows and what decides which way
 * it goes when it is pressed — "all" unticks the column, anything else ticks
 * the rest of it. `some` is a real third state (drawn as an indeterminate
 * checkbox), never rounded to on or off: a header that claimed "everyone" while
 * three people were unticked would be a lie about records.
 *
 * A column with no rows at all is `none` — there is nothing to untick, and the
 * control is disabled by the caller anyway.
 */
export type ColumnTickState = 'none' | 'some' | 'all';

export function columnTickState(flags: readonly boolean[]): ColumnTickState {
  if (flags.length === 0) return 'none';
  let on = 0;
  for (const f of flags) if (f) on++;
  if (on === 0) return 'none';
  return on === flags.length ? 'all' : 'some';
}

/** The little of a sheet row these two helpers need — a person and their cells. */
type TickedRow = { member: { id: string }; cells: Record<string, SheetCell> };

/**
 * Every sub-column's state and how many ticks it holds, keyed `<column>|<tick>`.
 *
 * TWO pages read it — 崇拜与祷告会 and the life group's own card, which now
 * carries the same Sunday columns — and each reads it three times over: the
 * check-all's own state, the number its clearing confirmation must quote, and
 * the headcount in the totals row. Counting once here is what keeps those three
 * from ever disagreeing (rule G5), and keeping it in one module is what keeps
 * the two pages from drifting apart (rule G4).
 */
export function sheetColumnStates(
  columns: readonly SheetColumn[],
  rows: readonly TickedRow[],
): Map<string, { state: ColumnTickState; ticked: number }> {
  const map = new Map<string, { state: ColumnTickState; ticked: number }>();
  for (const c of columns) {
    for (const tick of c.ticks) {
      const flags = rows.map((r) => !!r.cells[c.key]?.[tick]);
      map.set(`${c.key}|${tick}`, {
        state: columnTickState(flags),
        ticked: flags.filter(Boolean).length,
      });
    }
  }
  return map;
}

/**
 * 全员到齐, as requests: which members to write, and the whole cell to write for
 * each of them.
 *
 * The members are grouped by what their OTHER tick in this column already says,
 * so filling 主日 can never rewrite somebody's 会前 — which is exactly what one
 * flat "set the whole cell for everyone" call would have done. That is at most
 * two requests for a Sunday and one for a meeting; never one per member.
 */
export function sheetColumnWrites(
  column: SheetColumn,
  tick: SheetTickName,
  next: boolean,
  rows: readonly TickedRow[],
): { cell: SheetCell; ids: string[] }[] {
  const groups = new Map<string, { cell: SheetCell; ids: string[] }>();
  for (const r of rows) {
    const current = r.cells[column.key] ?? {};
    const cell: SheetCell = {};
    for (const name of column.ticks) cell[name] = name === tick ? next : !!current[name];
    const shape = column.ticks.map((name) => (cell[name] ? '1' : '0')).join('');
    const group = groups.get(shape);
    if (group) group.ids.push(r.member.id);
    else groups.set(shape, { cell, ids: [r.member.id] });
  }
  return [...groups.values()];
}
