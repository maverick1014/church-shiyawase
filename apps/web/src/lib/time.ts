/**
 * Every date and time in this app is Malaysia time — the church is in one
 * place, and a service at 10:00 is 10:00 for everyone reading the screen.
 *
 * Without this module the app silently used whatever timezone the *runtime*
 * happened to be in: UTC inside the Cloudflare Worker (so a 10:00 service
 * server-rendered as "02:00"), and the viewer's own zone in the browser. The
 * stored data was never wrong — a meeting's `starts_at` carries its own
 * offset — only the reading of it was.
 *
 * Nothing here should be bypassed with `getHours()` / `setHours()` /
 * `getTimezoneOffset()`: those all read the runtime zone.
 */

export const CHURCH_TZ = 'Asia/Kuala_Lumpur';
export const CHURCH_TZ_OFFSET = '+08:00';

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: CHURCH_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export type ChurchParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
};

/** The wall-clock reading in Malaysia for a given instant. */
export function churchParts(date: Date): ChurchParts {
  const found: Record<string, string> = {};
  for (const p of PARTS.formatToParts(date)) {
    if (p.type !== 'literal') found[p.type] = p.value;
  }
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    // Intl renders midnight as "24" in some engines under hour12: false.
    hour: Number(found.hour) % 24,
    minute: Number(found.minute),
  };
}

/**
 * The instant at which a Malaysia wall-clock reading occurs. Malaysia has had
 * no daylight saving since 1982, so the offset is constant — but deriving it
 * from `churchParts` rather than hardcoding +8 keeps this honest if the zone
 * database ever says otherwise.
 */
export function churchInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // How far the naive UTC reading of those numbers sits from the real zone.
  const p = churchParts(new Date(asUtc));
  const drift = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - asUtc;
  return new Date(asUtc - drift);
}

/**
 * Day of week (0 = Sunday) of the Malaysian calendar date containing `at`.
 * Computed on the date numbers themselves — reading `getUTCDay()` off a
 * `churchInstant` would report the day before, since KL midnight is 16:00 UTC
 * on the previous date.
 */
export function churchDayOfWeek(at: Date = new Date()): number {
  const p = churchParts(at);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Midnight in Malaysia on the day that contains `at` (default: now). */
export function startOfChurchDay(at: Date = new Date()): Date {
  const p = churchParts(at);
  return churchInstant(p.year, p.month, p.day);
}

/** Midnight in Malaysia `days` days after the day containing `at`. */
export function addChurchDays(at: Date, days: number): Date {
  const p = churchParts(at);
  return churchInstant(p.year, p.month, p.day + days);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` in Malaysia. */
export function churchDateKey(at: Date = new Date()): string {
  const p = churchParts(at);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * `YYYY-MM-DDTHH:mm` for a `<input type="datetime-local">`, read in Malaysia
 * time so the field shows the same clock reading the list does.
 */
export function toChurchInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = churchParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The reverse: a `datetime-local` value is a bare wall-clock reading with no
 * zone, and we always mean Malaysia by it — never the browser's zone.
 */
export function fromChurchInput(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return churchInstant(+m[1], +m[2], +m[3], +m[4], +m[5]).toISOString();
}

/* -------------------------------------------------------------------------
 * Calendar-label arithmetic
 *
 * The helpers below work on `YYYY-MM-DD` LABELS, not on instants: which dates
 * a month contains is the same question in every zone, so they do their
 * counting on a UTC-anchored `Date` and only ever read it back with the `UTC`
 * accessors. That is what makes them safe under `TZ=America/New_York` — the
 * banned accessors (`getFullYear` / `getMonth` / `getDate` / `getHours`) read
 * the runtime's zone, `getUTCDay` / `getUTCDate` never do.
 * ---------------------------------------------------------------------- */

/**
 * Every date in one calendar month that falls on `weekday` (0 = Sunday), as
 * `YYYY-MM-DD` in order.
 *
 * Both attendance sheets are built on this: the Sunday roll call takes the
 * Sundays of the month it is showing, and a life group takes the month's
 * copies of its own meeting day. Neither may hand-roll it — one of them
 * counted Sundays for a Tuesday group before this was shared (rule G4).
 */
export function weekdayDatesOfMonth(
  year: number,
  month1to12: number,
  weekday: number,
): string[] {
  const dates: string[] = [];
  const d = new Date(Date.UTC(year, month1to12 - 1, 1));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCMonth() === month1to12 - 1) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return dates;
}

/** The Sundays of one Malaysian calendar month — the Sunday sheet's columns. */
export function sundaysOfMonth(year: number, month1to12: number): string[] {
  return weekdayDatesOfMonth(year, month1to12, 0);
}

/**
 * Is this `YYYY-MM-DD` a real date, and is it a Sunday? The Sunday sheet's
 * table refuses anything else (a CHECK constraint in migration 0013), and the
 * API says so in words rather than letting Postgres answer with a constraint
 * name.
 */
export function isSundayDate(dateOnly: string | null | undefined): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly ?? '');
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const at = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC rolls 2026-02-31 forward into March — compare it back so an
  // impossible date is rejected rather than silently moved.
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d)
    return false;
  return at.getUTCDay() === 0;
}

/**
 * A stored DATE (`YYYY-MM-DD`) covers its whole Malaysian day. Comparing a
 * course's `ends_on` against `new Date(ends_on)` would retire it at 08:00 that
 * morning, because a bare date parses as UTC midnight.
 */
export function endOfChurchDate(dateOnly: string | null | undefined): Date | null {
  if (!dateOnly) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  if (!m) return null;
  return churchInstant(+m[1], +m[2], +m[3] + 1);
}

/** The Malaysian midnight a stored DATE (`YYYY-MM-DD`) begins — the other
 *  half of `endOfChurchDate`, for "has this not started yet" comparisons. */
export function startOfChurchDate(dateOnly: string | null | undefined): Date | null {
  if (!dateOnly) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  if (!m) return null;
  return churchInstant(+m[1], +m[2], +m[3]);
}
