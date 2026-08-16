/**
 * 成员导入 — reading a spreadsheet of members, decided in ONE place.
 *
 * The page parses the file in the browser so a person can SEE what an import
 * will do before anything is written; the API then decides the same thing again
 * server-side, because the preview is a courtesy and the server is the
 * authority (rule G2). Both call `planImport` here, so the two can never
 * disagree about what a row means — only about what the database contained at
 * the moment each of them looked.
 *
 * Nothing in this module touches the DOM, `fetch`, SheetJS or React: the caller
 * hands it plain strings (whichever way it got them) and a snapshot of the
 * church, and gets back a decision per row. That is what makes it usable from
 * the Worker as well as the browser, and what makes it unit-testable.
 *
 * A MEMBER IS A PAIR OF NAMES (migration 0018): the Chinese `full_name` and the
 * `english_name` under it, compared trimmed and case-insensitively with "no
 * English name" counting as a value of its own. `pairKey` below computes
 * exactly what the `members_name_pair_key` index computes, which is what lets
 * an import say "this is the same person, update them" instead of inserting a
 * second copy — and what makes a row the database would refuse a row this
 * module refuses first, in words.
 */

import { ChurchRole, Gender, GroupPosition, MemberStatus } from '@tog/shared';
import { en, type MessageKey } from './i18n/en';
import { ms } from './i18n/ms';
import { zh } from './i18n/zh';

/** Every column an import may carry. Anything else in the file is ignored. */
export type ImportField =
  | 'full_name'
  | 'english_name'
  | 'phone'
  | 'email'
  | 'address'
  | 'referred_by'
  | 'gender'
  | 'date_of_birth'
  | 'joined_at'
  | 'church_role'
  | 'status'
  | 'hall'
  | 'group'
  | 'serving_roles';

export type ImportColumn = {
  field: ImportField;
  /** The header the template writes and the preview labels a problem with. */
  labelKey: MessageKey;
  /** Without it there is nothing to import — only the Chinese name is. */
  required?: boolean;
  /** Longest value accepted. A spreadsheet cell can hold a whole paragraph. */
  maxLength: number;
  /** Header spellings accepted beyond the three dictionaries' own labels. */
  extra?: readonly string[];
};

/**
 * The columns, in the order the template writes them.
 *
 * A header is matched against the label in ALL THREE dictionaries (see
 * `headerAliases`), not against a hardcoded English word: a church secretary
 * working in Chinese downloads a Chinese template, fills it in and uploads it
 * again, and that has to work. The dictionaries are read here rather than
 * copied, so a renamed label can never drift from what the importer accepts —
 * and `members-import.test.ts` asserts exactly that.
 */
export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { field: 'full_name', labelKey: 'import.field.fullName', required: true, maxLength: 80, extra: ['name', '姓名', '中文名', 'nama'] },
  { field: 'english_name', labelKey: 'import.field.englishName', maxLength: 80, extra: ['englishname', '英文姓名'] },
  { field: 'phone', labelKey: 'import.field.phone', maxLength: 40, extra: ['hp', 'handphone', 'notelefon', '手机', '联系电话'] },
  { field: 'email', labelKey: 'import.field.email', maxLength: 160, extra: ['emel', '电邮', '邮箱'] },
  // What you would write on an envelope, so it is allowed to be a sentence.
  { field: 'address', labelKey: 'import.field.address', maxLength: 300, extra: ['住址'] },
  // A NAME, resolved to a member below — a spreadsheet has no ids in it.
  { field: 'referred_by', labelKey: 'import.field.referrer', maxLength: 160, extra: ['referrer', 'referredby', '推荐', '介绍人'] },
  { field: 'gender', labelKey: 'import.field.gender', maxLength: 20, extra: ['sex'] },
  { field: 'date_of_birth', labelKey: 'import.field.birthday', maxLength: 20, extra: ['dob', 'birthday', '出生日期', 'tarikhlahir'] },
  { field: 'joined_at', labelKey: 'import.field.joined', maxLength: 20, extra: ['joined', '加入教会日期'] },
  { field: 'church_role', labelKey: 'import.field.churchRole', maxLength: 30, extra: ['role', '身份'] },
  { field: 'status', labelKey: 'import.field.status', maxLength: 30, extra: [] },
  { field: 'hall', labelKey: 'import.field.hall', maxLength: 60, extra: ['堂会', 'kongregasi'] },
  { field: 'group', labelKey: 'import.field.group', maxLength: 60, extra: ['小组', 'kumpulan'] },
  // One cell, several ministries — see SERVING_SEPARATORS below. Longer than
  // the other free-text columns because it holds a list rather than a value.
  { field: 'serving_roles', labelKey: 'import.field.serving', maxLength: 200, extra: ['serving', '服侍', '服事', 'pelayanan'] },
];

/**
 * What separates two items inside ONE cell — and, in the browser, what ends one
 * chip in the shared `TagsInput`.
 *
 * A church typing 服侍岗位 into a spreadsheet writes `敬拜、音响`, `敬拜,音响`,
 * `敬拜，音响`, `敬拜; 音响` or `敬拜/音响` depending on which keyboard is in
 * front of them, and being told the whole thing is one ministry called
 * "敬拜、音响" would be incomprehensible. So all of them are accepted, each
 * piece is trimmed and the empties are dropped — a trailing separator is a
 * typo, not a nameless ministry. An EMPTY cell is still "nothing to say" and
 * supplies no column at all, so a sparse re-import cannot clear the ministries
 * the church recorded.
 *
 * One definition, because the spreadsheet and the tag field ask the same
 * question: where does this item end (rule G4)?
 */
export const LIST_SEPARATORS = /[,，、;；/／]+/;

/** The items one cell names, in the order they were written, deduplicated. */
export function parseList(raw: string): string[] {
  const seen = new Set<string>();
  for (const piece of tidy(raw).split(LIST_SEPARATORS)) {
    const value = tidy(piece);
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * Is this single keypress one of those separators? The tag field asks per
 * keystroke, and a regex meant for splitting a cell would happily say yes to a
 * whole pasted string, so the length check is the question it actually means.
 */
export function isListSeparatorKey(key: string): boolean {
  return key.length === 1 && LIST_SEPARATORS.test(key);
}

/** The label a preview / a template shows for a column. */
export function importFieldKey(field: ImportField): MessageKey {
  return (IMPORT_COLUMNS.find((c) => c.field === field) ?? IMPORT_COLUMNS[0]).labelKey;
}

/**
 * A file bigger than this is refused rather than half-applied.
 *
 * Every row is a database round trip, and the whole import is one HTTP request
 * that must finish inside a Worker's request lifetime. A church of this size
 * splitting a file in two is a mild annoyance; a request that dies at row 800
 * having written 799 is not.
 */
export const MAX_IMPORT_ROWS = 300;

/* -------------------------------------------------------------------------
 * Normalising what a spreadsheet actually contains
 * ---------------------------------------------------------------------- */

/**
 * A cell value as it will be STORED: NFKC-folded, every kind of space turned
 * into an ordinary one, runs collapsed, ends trimmed.
 *
 * This has to happen before the value reaches the database, not only before it
 * is compared: Postgres `btrim(x)` trims ASCII spaces only, so a name pasted
 * with a full-width space (U+3000) or a non-breaking one would sit in the table
 * carrying whitespace the unique index cannot see — and the same person could
 * then be inserted twice. NFKC also folds full-width digits and Latin letters
 * ("０１２" / "Ｊｏｈｎ"), which is exactly how a phone number pasted out of a
 * Chinese-locale spreadsheet arrives.
 */
export function tidy(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s 　]+/g, ' ')
    .trim();
}

/**
 * The identity of a member: `lower(btrim(full_name))` + `lower(btrim(coalesce(
 * english_name,'')))`, which is what `members_name_pair_key` indexes. Both
 * halves go through `tidy` first, so the key here and the key Postgres computes
 * agree on a value this app is about to write.
 */
export function pairKey(fullName: string, englishName: string | null | undefined): string {
  return `${tidy(fullName).toLowerCase()} ${tidy(englishName).toLowerCase()}`;
}

/** One half of a pair, folded exactly the way `pairKey` folds it. */
const nameKey = (value: string | null | undefined) => tidy(value).toLowerCase();

/**
 * Every way ONE CELL may write this person as a 推荐人, LOOSEST FIRST: their
 * Chinese name, and — when they have one — the pair with the English name after
 * it. The LAST entry is therefore always the exact written form of the pair.
 *
 * A spreadsheet holds names, not ids, so 推荐人 has to be resolved by name; and
 * a name has to be folded the way `pairKey` folds one, or the file and the
 * unique index would disagree about who somebody is. The Chinese name alone is
 * offered as well as the pair because that is what a church actually types —
 * and when two people answer to it, the row is REFUSED rather than guessed at,
 * which is the whole reason this returns the keys instead of one.
 */
export function referrerKeys(fullName: string, englishName?: string | null): string[] {
  const chinese = nameKey(fullName);
  const english = nameKey(englishName);
  return english ? [chinese, `${chinese} ${english}`] : [chinese];
}

/** A header / enum value reduced to something two spellings can be compared by. */
function matchKey(value: string): string {
  return tidy(value)
    .toLowerCase()
    .replace(/[\s_*·./:：()（）-]/g, '');
}

const DICTIONARIES = [en, zh, ms] as const;

/** Every spelling of one column's header this importer answers to. */
function headerAliases(column: ImportColumn): Set<string> {
  const set = new Set<string>([matchKey(column.field)]);
  for (const dict of DICTIONARIES) set.add(matchKey(dict[column.labelKey]));
  for (const extra of column.extra ?? []) set.add(matchKey(extra));
  return set;
}

const HEADER_ALIASES: Array<{ field: ImportField; aliases: Set<string> }> = IMPORT_COLUMNS.map(
  (column) => ({ field: column.field, aliases: headerAliases(column) }),
);

/** Which column a header cell names, or null when it names nothing we import. */
export function matchImportColumn(header: string): ImportField | null {
  const key = matchKey(header);
  if (!key) return null;
  return HEADER_ALIASES.find((c) => c.aliases.has(key))?.field ?? null;
}

/**
 * An enum value in any of the three languages, or its stored code.
 *
 * The file may say `female`, `女`, `Perempuan` or `Female` — all four are the
 * same value, and the church types whichever its interface is in. Built from
 * the dictionaries for the same reason the headers are.
 */
function enumAliases<T extends string>(
  values: readonly T[],
  keyOf: (value: T) => MessageKey,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) {
    map.set(matchKey(value), value);
    for (const dict of DICTIONARIES) map.set(matchKey(dict[keyOf(value)]), value);
  }
  return map;
}

const GENDERS = enumAliases(
  [Gender.Male, Gender.Female, Gender.Other],
  (g) => `gender.${g}` as MessageKey,
);
const STATUSES = enumAliases(
  [MemberStatus.Active, MemberStatus.Inactive],
  (s) => `memberStatus.${s}` as MessageKey,
);
// EVERY church role, 访客 and BEST included (0031). A spreadsheet of people
// the church met is exactly what a file being imported often is, and the two
// roles that are now kept on pages of their own are still one column's worth
// of value here — the 教会身份 cell decides which list a row lands on, which is
// the whole point of it being a column. Read from `Object.values` rather than
// listed by hand: this table used to name four of the five roles the enum
// shipped, so 访客 was silently unimportable for as long as it existed, and a
// hand-written list is what let that happen.
const CHURCH_ROLES = enumAliases(
  Object.values(ChurchRole),
  (r) => `churchRole.${r}` as MessageKey,
);

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * A date as `YYYY-MM-DD`, or null when the cell is not one.
 *
 * Year-first only, deliberately: `03/04/2026` is the 3rd of April to half the
 * congregation and the 4th of March to the other half, and a birthday quietly
 * imported on the wrong day is worse than a row the file's owner has to fix.
 * The template's own column is `YYYY-MM-DD`, and the modal turns a real Excel
 * date cell into that form before it ever gets here.
 *
 * No `Date` is constructed: `new Date('2026-02-30')` is a valid instant in
 * March, and every `Date` accessor reads the runtime's zone (rule G6a).
 */
export function parseImportDate(raw: string): string | null {
  const value = tidy(raw);
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return null;
  const leap = month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
  if (day < 1 || day > DAYS_IN_MONTH[month - 1] + (leap ? 1 : 0)) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The civil date `days` after the Unix epoch, as `YYYY-MM-DD`.
 *
 * Hinnant's days-to-civil, in integer arithmetic. Deliberately not a `Date`:
 * every `Date` accessor reads the RUNTIME's zone (rule G6a), so the same
 * spreadsheet cell would become two different birthdays depending on whose
 * browser opened the file.
 */
function civilFromUnixDays(days: number): string {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A date CELL in a spreadsheet, which is a number: days since 1899-12-30.
 *
 * A person types 4/5/1990 into Excel and the file stores 32997 — so a birthday
 * column arrives as numbers, and reading it as text would show the church a
 * serial number rather than a date. Converted here (not with SheetJS's own
 * formatter, whose export differs between that package's CJS and ESM builds,
 * and not through `Date`, see above).
 *
 * Serial 60 is the 29th of February 1900 — a day that never happened, kept by
 * Excel for compatibility with Lotus 1-2-3 — so anything at or below it is
 * refused rather than guessed at, which also rules out a plain small number
 * that landed in a date column by accident.
 */
export function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const days = Math.floor(serial);
  if (days < 61 || days > 2958465) return null; // 1900-03-01 … 9999-12-31
  return civilFromUnixDays(days - 25569); // 25569 = 1970-01-01
}

/** An address the church could actually write to. Deliberately loose. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/**
 * A number somebody could ring: digits, and the punctuation Malaysians write
 * them with. A cell holding a name or a note is what this is here to catch,
 * not to police how a 012 number is spaced.
 */
export function looksLikePhone(value: string): boolean {
  if (!/^[0-9+()\-\s]+$/.test(value)) return false;
  return (value.match(/\d/g) ?? []).length >= 6;
}

/**
 * Which existing member a PUBLIC self-registration (`/join`) refers to, if
 * any — a different question from `pairKey`'s exact composite match. A
 * registrant does not reliably know or retype the exact English-name
 * spelling the church already has on file, so the Chinese name alone is the
 * anchor: it names exactly one person in the ordinary case, and that person
 * is the match regardless of what (if anything) they typed as an English
 * name. When it names SEVERAL people — two members who happen to share a
 * Chinese name — the phone number is what tells them apart: one exact match
 * settles it, and anything else (none, or more than one, which should not
 * happen since phone numbers are effectively unique) means this is
 * genuinely a new person, never a guess at an existing one.
 */
export function matchRegistrant<T extends { full_name: string; phone: string | null }>(
  fullName: string,
  phone: string,
  existing: readonly T[],
): T | null {
  const key = nameKey(fullName);
  const byName = existing.filter((m) => nameKey(m.full_name) === key);
  if (byName.length === 0) return null;
  if (byName.length === 1) return byName[0];
  const phoneKey = tidy(phone);
  if (!phoneKey) return null;
  const byPhone = byName.filter((m) => tidy(m.phone ?? '') === phoneKey);
  return byPhone.length === 1 ? byPhone[0] : null;
}

/* -------------------------------------------------------------------------
 * The plan
 * ---------------------------------------------------------------------- */

/** Why a row will not be imported. Rendered through `importIssueKey` (G8). */
export type ImportIssue =
  | 'name_missing'
  | 'too_long'
  | 'duplicate_in_file'
  | 'unknown_hall'
  | 'unknown_group'
  | 'unknown_role'
  | 'unknown_referrer'
  | 'ambiguous_referrer'
  | 'self_referrer'
  | 'unknown_gender'
  | 'unknown_status'
  | 'bad_date'
  | 'bad_email'
  | 'bad_phone'
  | 'no_hall'
  | 'other_hall'
  | 'group_other_hall'
  | 'best_in_group';

/** One row of the file, already reduced to strings by whoever read it. */
export type ImportRow = { row: number } & Partial<Record<ImportField, string>>;

export type PlannedRow = {
  /** The row NUMBER in the spreadsheet — this is a file a person will fix. */
  row: number;
  action: 'create' | 'update' | 'skip';
  issue?: ImportIssue;
  /** The offending value, or the row it duplicates. Data, shown as it came. */
  detail?: string;
  /** Which column the issue is about, when it is about one. */
  field?: ImportField;
  full_name: string;
  english_name: string | null;
  /** The member this row updates; absent on a create. */
  member_id?: string;
  /**
   * Exactly the columns the file supplied, normalised and resolved. A value is
   * a string for every column but 服侍岗位, which is the `text[]` one cell can
   * hold several of.
   */
  values: Record<string, string | string[] | null>;
  /** Which columns those were, for the preview's "updating: …" line. */
  fields: ImportField[];
};

export type ImportPlan = {
  rows: PlannedRow[];
  created: number;
  updated: number;
  skipped: number;
};

/** What the church looked like when the plan was made. */
export type ImportContext = {
  halls: readonly { id: string; name: string }[];
  groups: readonly { id: string; name: string; hall_id: string }[];
  /** EVERY member, church-wide — the name pair is unique across congregations. */
  existing: readonly {
    id: string;
    full_name: string;
    english_name: string | null;
    hall_id: string;
    group_position: string | null;
    /**
     * What the member is to the church TODAY. Read to answer one question a
     * row cannot answer on its own: a file that adds a life group to somebody
     * who is already a BEST names no 教会身份 at all, and the pairing the
     * database refuses (0032) has to be caught before it fails the import.
     * Optional for the same reason `group_id` is — the browser's own preview
     * is free to pass the narrower shape, and then simply never refuses on
     * this ground while the server, which always reads it, still does (G2).
     */
    church_role?: string | null;
    /**
     * The member's group BEFORE this import — read only by the server's own
     * `applyImport` (to feed `syncGroupLeaderAccount`'s `previousGroupId`),
     * never by `planImport` itself. Optional so the browser's own preview
     * (which never needs it) can keep passing the narrower shape it always
     * has.
     */
    group_id?: string | null;
  }[];
  /** The account's own congregation; null = 全堂权限. */
  hallScope: string | null;
  /** Where a row that names no congregation lands (the viewed / only hall). */
  defaultHallId: string | null;
};

/**
 * What an import WILL do, row by row — nothing here writes anything.
 *
 * The rules, in the order they bite:
 *  1. A row with no Chinese name is not a member.
 *  2. The same pair twice in one file is the file's mistake, not two people:
 *     the second occurrence is skipped naming the row it repeats, because
 *     applying both would leave whichever came last silently winning.
 *  3. A pair already on the roll is an UPDATE of that person — and only of the
 *     columns the file actually filled in, so a sparse re-import cannot blank
 *     out the phone number the church already had. A blank cell is "nothing to
 *     say", never "clear this".
 *  4. Anything the church does not recognise — a congregation, a life group, a
 *     role, a date — stops that row and says which value it choked on. One bad
 *     cell never takes the rest of the file with it.
 *  5. The congregation rules are the same ones every other member write obeys:
 *     a hall-scoped account may not touch another congregation's row, and a
 *     life group belongs to its own congregation (rule G2). The SERVER decides
 *     this again for real; the copy the browser runs is only what the preview
 *     is drawn from.
 */
export function planImport(rows: readonly ImportRow[], ctx: ImportContext): ImportPlan {
  const hallByName = new Map(ctx.halls.map((h) => [matchKey(h.name), h]));
  const groupByName = new Map(ctx.groups.map((g) => [matchKey(g.name), g]));
  const byPair = new Map(ctx.existing.map((m) => [pairKey(m.full_name, m.english_name), m]));
  /**
   * Who answers to a name a 推荐人 cell might write — in two passes, for the
   * same reason a row's own name is matched as a PAIR.
   *
   * `exact` is the whole written pair (「张伟 David」, or just 「张伟」 for
   * somebody who has no English name — "no English name" is a value, not a
   * gap). `loose` is the Chinese name alone, which is what a church actually
   * types. Exact wins, so a cell saying 「张伟」 names the 张伟 with no English
   * name even while a 张伟 David is on the roll — exactly as that same cell
   * would in the 中文名 column. Both hold LISTS: when two people genuinely
   * answer to what was written, the row is refused rather than filed against
   * whichever of them happened to sort first.
   */
  const exactReferrer = new Map<string, typeof ctx.existing[number][]>();
  const looseReferrer = new Map<string, typeof ctx.existing[number][]>();
  for (const m of ctx.existing) {
    const keys = referrerKeys(m.full_name, m.english_name);
    for (const [map, key] of [
      [looseReferrer, keys[0]],
      [exactReferrer, keys[keys.length - 1]],
    ] as const) {
      const found = map.get(key);
      if (found) found.push(m);
      else map.set(key, [m]);
    }
  }
  /** Pair → the row that already claimed it, for rule 2 above. */
  const seen = new Map<string, number>();

  const planned: PlannedRow[] = rows.map((row) => {
    const fullName = tidy(row.full_name);
    const englishName = tidy(row.english_name);
    const base = {
      row: row.row,
      full_name: fullName,
      english_name: englishName || null,
      values: {} as Record<string, string | string[] | null>,
      fields: [] as ImportField[],
    };
    const skip = (issue: ImportIssue, field?: ImportField, detail?: string): PlannedRow => ({
      ...base,
      action: 'skip',
      issue,
      field,
      detail,
    });

    if (!fullName) return skip('name_missing', 'full_name');
    for (const column of IMPORT_COLUMNS) {
      const value = tidy(row[column.field]);
      if (value.length > column.maxLength) return skip('too_long', column.field, value.slice(0, 40));
    }

    const key = pairKey(fullName, englishName);
    const twin = seen.get(key);
    if (twin !== undefined) return skip('duplicate_in_file', 'full_name', String(twin));
    seen.set(key, row.row);

    const existing = byPair.get(key);

    // ---- congregation ------------------------------------------------------
    // A row may name one; otherwise the member keeps the one they have, and a
    // new member lands in the congregation the importer is looking at.
    let hallId: string | null = existing?.hall_id ?? ctx.defaultHallId;
    const hallName = tidy(row.hall);
    if (hallName) {
      const hall = hallByName.get(matchKey(hallName));
      if (!hall) return skip('unknown_hall', 'hall', hallName);
      hallId = hall.id;
    }
    if (!hallId) return skip('no_hall', 'hall');
    // The same rule `withHall` / `assertOwnsRow` enforce on every other member
    // write: a hall-scoped account may not create into, nor move a person into
    // or out of, a congregation that is not its own. Said out loud rather than
    // silently rewritten to its own hall — an import that quietly moved 英文堂
    // people into 中文堂 would be worse than one that refused them.
    if (ctx.hallScope && (hallId !== ctx.hallScope || (existing && existing.hall_id !== ctx.hallScope)))
      return skip('other_hall', 'hall');

    const values: Record<string, string | string[] | null> = { full_name: fullName };
    const fields: ImportField[] = ['full_name'];
    const supply = (field: ImportField, column: string, value: string | string[] | null) => {
      values[column] = value;
      fields.push(field);
    };

    if (englishName) supply('english_name', 'english_name', englishName);
    if (hallName || !existing) values.hall_id = hallId;
    if (hallName) fields.push('hall');

    const phone = tidy(row.phone);
    if (phone) {
      if (!looksLikePhone(phone)) return skip('bad_phone', 'phone', phone);
      supply('phone', 'phone', phone);
    }
    const email = tidy(row.email);
    if (email) {
      if (!looksLikeEmail(email)) return skip('bad_email', 'email', email);
      // Sign-in matches on a lower-cased address, so stored emails are too.
      supply('email', 'email', email.toLowerCase());
    }
    const gender = tidy(row.gender);
    if (gender) {
      const code = GENDERS.get(matchKey(gender));
      if (!code) return skip('unknown_gender', 'gender', gender);
      supply('gender', 'gender', code);
    }
    const status = tidy(row.status);
    if (status) {
      const code = STATUSES.get(matchKey(status));
      if (!code) return skip('unknown_status', 'status', status);
      supply('status', 'status', code);
    }
    const address = tidy(row.address);
    if (address) supply('address', 'address', address);
    // 推荐人 — a name in the file, a member id in the row. Refused rather than
    // guessed at when it names nobody or names two people, because "who brought
    // this person" filed against the wrong 张伟 is worse than a row the file's
    // owner has to spell out.
    const referrer = tidy(row.referred_by);
    if (referrer) {
      const written = nameKey(referrer);
      const exact = exactReferrer.get(written) ?? [];
      const candidates = exact.length > 0 ? exact : looseReferrer.get(written) ?? [];
      if (candidates.length === 0) return skip('unknown_referrer', 'referred_by', referrer);
      if (candidates.length > 1) return skip('ambiguous_referrer', 'referred_by', referrer);
      // The database refuses this outright (`members_referred_by_not_self`),
      // and a row that says nothing is not worth a failed import.
      if (existing && candidates[0].id === existing.id)
        return skip('self_referrer', 'referred_by', referrer);
      supply('referred_by', 'referred_by', candidates[0].id);
    }
    const churchRole = tidy(row.church_role);
    if (churchRole) {
      const code = CHURCH_ROLES.get(matchKey(churchRole));
      if (!code) return skip('unknown_role', 'church_role', churchRole);
      supply('church_role', 'church_role', code);
    }
    for (const [field, column] of [
      ['date_of_birth', 'date_of_birth'],
      ['joined_at', 'joined_at'],
    ] as const) {
      const raw = tidy(row[field]);
      if (!raw) continue;
      const date = parseImportDate(raw);
      if (!date) return skip('bad_date', field, raw);
      supply(field, column, date);
    }
    // Free text by design (migration 0019): a church invents a ministry nobody
    // modelled, so there is no dictionary to refuse a value against — only a
    // cell that names none at all, which supplies nothing.
    const serving = parseList(row.serving_roles ?? '');
    if (serving.length > 0) supply('serving_roles', 'serving_roles', serving);

    const groupName = tidy(row.group);
    if (groupName) {
      const group = groupByName.get(matchKey(groupName));
      if (!group) return skip('unknown_group', 'group', groupName);
      if (group.hall_id !== hallId) return skip('group_other_hall', 'group', groupName);
      // A BEST never carries a life group — the database refuses the pairing
      // outright (`members_best_has_no_life_group`, 0032), and a check
      // constraint tripping mid-import would fail the whole file over one row.
      // Refused HERE instead, naming the spreadsheet row and the value, and
      // leaving every row around it to apply — the same shape every other
      // refusal in this planner has. Read off the role this row will END UP
      // with, so a file that makes somebody a BEST and puts them in a group in
      // the same row is caught as readily as one that adds a group to
      // somebody who is already one.
      const roleAfter = (values.church_role as string | undefined) ?? existing?.church_role;
      if (roleAfter === ChurchRole.Best) return skip('best_in_group', 'group', groupName);
      supply('group', 'group_id', group.id);
      // A member of a group with no position at all reads as 未分组 everywhere
      // (`displayRole`), so joining one starts them where a new face starts.
      // Only when they do not already hold a rank — an import must not demote
      // a group leader by naming their own group again.
      if (!existing?.group_position) values.group_position = GroupPosition.NewMember;
    }

    return existing
      ? { ...base, action: 'update', member_id: existing.id, values, fields }
      : { ...base, action: 'create', values, fields };
  });

  return {
    rows: planned,
    created: planned.filter((r) => r.action === 'create').length,
    updated: planned.filter((r) => r.action === 'update').length,
    skipped: planned.filter((r) => r.action === 'skip').length,
  };
}
