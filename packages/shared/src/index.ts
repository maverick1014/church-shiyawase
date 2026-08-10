/**
 * Shared domain types & enums for the Church Management System (tog).
 * Mirrors the Supabase schema in /supabase/migrations.
 */

// ---------------------------------------------------------------------------
// The church record & its add-on modules
// ---------------------------------------------------------------------------

/**
 * The one church this deployment serves (`church` table, 0012). Its name is
 * DATA, not a translation — a church is called the same thing in every
 * interface language — so nothing user-facing hardcodes it any more.
 */
export interface Church {
  id: string;
  name: string;
  /** Short form for tight chrome; null = use `name`. */
  short_name: string | null;
  description: string | null;
  /** Public URL of the uploaded logo; null = the bundled default mark. */
  logo_url: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * An OPTIONAL module: a whole section of the product a church may or may not
 * run. The catalog lives here in code; only the on/off state lives in the
 * database (`church_modules`), so a row can never enable a feature that does
 * not exist, and a module can never be half-registered.
 *
 * Core surfaces — dashboard, members, groups, events, trainings, accounts,
 * profile — are deliberately NOT in here: they are not switchable.
 */
export interface OptionalModule {
  /** Stored in `church_modules.module`; also the i18n key suffix. */
  readonly key: string;
  /** The single nav entry this module owns, hidden while it is off. */
  readonly nav: string;
  /**
   * The API path prefixes it owns, WITHOUT the `/api` prefix. Every request
   * whose path starts with one of these is refused while the module is off
   * (the server-side half of rule G2 — hiding the nav entry is not enough).
   */
  readonly api: readonly string[];
}

/**
 * The catalog of switchable modules.
 *
 * ADDING ONE is a single entry here — the nav hides it, the API gate refuses
 * its paths and the module catalog page grows a row automatically. The only
 * other things a second entry needs are its dictionary strings
 * (`module.<key>.name`, `.desc`, `.dataKept` in en/zh/ms) and a seed row in a
 * migration, exactly like `discipleship` in 0012.
 */
/** The 四十天守望 add-on. Named so call sites don't retype a magic string. */
export const MODULE_DISCIPLESHIP = 'discipleship';
/**
 * The 幸福小组 add-on (migration 0022). The key MUST stay exactly `'happiness'`
 * — a church's `church_modules` row is seeded with that string, and a
 * mismatch here would orphan it (the row would name a module this code never
 * registers, so the switch on `/church` could never turn it back on).
 */
export const MODULE_HAPPINESS = 'happiness';

export const OPTIONAL_MODULES: readonly OptionalModule[] = [
  // 四十天守望 — the forty-day one-to-one discipleship section. Only some
  // churches run it, which is why it is the first module to become optional.
  { key: MODULE_DISCIPLESHIP, nav: '/discipleship', api: ['discipleship'] },
  // 幸福小组 — term-based small groups: 期 (term) → group → roster + weekly
  // roll call. Staff/leader-only, no public form (unlike 守望's mentor link).
  { key: MODULE_HAPPINESS, nav: '/happiness', api: ['happiness'] },
];

/** Every registered module key, in catalog order. */
export const OPTIONAL_MODULE_KEYS: readonly string[] = OPTIONAL_MODULES.map((m) => m.key);

/** Is this a module the app actually ships? Guards writes against junk keys. */
export function isOptionalModule(key: string | null | undefined): boolean {
  return OPTIONAL_MODULE_KEYS.includes(String(key));
}

/** Path segments, from either `['a','b']` or `'/a/b'` / `'a/b'`. */
function segmentsOf(path: string[] | string): string[] {
  return (Array.isArray(path) ? path : path.split('/')).filter((s) => s !== '');
}

/**
 * Which module owns an API path (`['discipleship','pairs']` → `'discipleship'`),
 * or null when the path belongs to a core surface and can never be gated.
 * The API gate and the tests both read this, so "which paths a module owns" is
 * answered in exactly one place.
 */
export function moduleForApiPath(path: string[] | string): string | null {
  const segments = segmentsOf(path);
  for (const mod of OPTIONAL_MODULES) {
    for (const prefix of mod.api) {
      const want = segmentsOf(prefix);
      if (want.length && want.every((s, i) => segments[i] === s)) return mod.key;
    }
  }
  return null;
}

/**
 * Which module owns a nav href, or null for a core page. `/discipleship` and
 * anything under it belong to the same module, so a deep link is gated too.
 */
export function moduleForNavHref(href: string): string | null {
  const segments = segmentsOf(href);
  for (const mod of OPTIONAL_MODULES) {
    const want = segmentsOf(mod.nav);
    if (want.length && want.every((s, i) => segments[i] === s)) return mod.key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The church's theme — two colours, and the presets to choose them from
// ---------------------------------------------------------------------------

/**
 * A theme is exactly TWO colours:
 *
 *   rail  — the dark sidebar (`--rail`)
 *   brand — the accent everything active is painted in (`--brand`)
 *
 * Every other colour the design system needs is DERIVED from these in
 * `globals.css` with `color-mix()` (`--brand-2` a shade down, `--brand-soft` a
 * tint, `--accent` / `--accent-soft` and the sidebar's own foregrounds off the
 * rail), so there is one source per colour and the shades cannot drift apart
 * from it. The independent families — `--good` / `--warn` / `--crit` and the
 * warm neutrals — are NOT part of a theme: "absent" must not turn into the
 * brand colour because a church picked a red one.
 *
 * It belongs to the CHURCH, not to an account: it is branding, so one set does
 * the whole congregation (stored on the `church` row, migration 0017).
 */
export interface ChurchTheme {
  /** The preset this came from, or null when the two colours were picked by hand. */
  preset: string | null;
  /** The sidebar colour, `#rrggbb`. */
  rail: string;
  /** The brand colour, `#rrggbb`. */
  brand: string;
}

/** One entry in the shipped catalogue. The colours are code, not data. */
export interface ThemePresetDef {
  /** Stored in `church.theme_preset`; also the i18n key suffix. */
  readonly key: string;
  readonly rail: string;
  readonly brand: string;
}

/**
 * The shipped presets.
 *
 * The FIRST is exactly today's palette, so applying migration 0017 and this
 * build changes nothing visible. The rest are a considered set rather than a
 * rainbow: every one is a near-black rail tinted towards its own brand's hue
 * (so the sidebar and the accent read as one pair rather than two decisions),
 * and every brand is dark enough to carry white text — which is what `.btn`,
 * `.chip.on`, `.nav-link.active` and `.day-cell.done` all do with it.
 *
 * The colours are stored on the church row as well as the key, so editing a
 * preset here can never silently restyle a church that picked it — they keep
 * the pair they chose until they choose another.
 *
 * ADDING ONE is a single entry here plus its dictionary name
 * (`theme.preset.<key>` in en/zh/ms) — `lib/__tests__/theme.test.ts` fails the
 * build if the name is missing or the pair is unreadable.
 */
export const THEME_PRESETS: readonly ThemePresetDef[] = [
  // Crimson on charcoal — the church logo's own pair, and the app's default.
  { key: 'charcoal', rail: '#201d1b', brand: '#a51f24' },
  // Harbour blue on slate ink.
  { key: 'ink', rail: '#1a2130', brand: '#2f6690' },
  // Pine on forest.
  { key: 'forest', rail: '#182320', brand: '#276b48' },
  // Mulberry on aubergine.
  { key: 'plum', rail: '#221a26', brand: '#8a3f6d' },
  // Burnt amber on coffee.
  { key: 'amber', rail: '#231e18', brand: '#a35d1b' },
];

/** Every preset key, in catalogue order. */
export const THEME_PRESET_KEYS: readonly string[] = THEME_PRESETS.map((p) => p.key);

/**
 * The palette a church has until it chooses otherwise — and the fallback for
 * every place that must render before the record arrives (the CSS defaults in
 * `globals.css`, the pre-paint script in `app/layout.tsx`).
 */
export const DEFAULT_THEME: ChurchTheme = {
  preset: THEME_PRESETS[0].key,
  rail: THEME_PRESETS[0].rail,
  brand: THEME_PRESETS[0].brand,
};

/** One preset by key, or null if this build does not ship it. */
export function themePreset(key: string | null | undefined): ThemePresetDef | null {
  return THEME_PRESETS.find((p) => p.key === key) ?? null;
}

/**
 * A STRICT six-digit hex colour, `#rrggbb`.
 *
 * Deliberately narrow: this string is interpolated into a CSS custom property,
 * so `red`, `var(--x)`, `#abc`, `rgb(…)` and anything carrying a `;` or a `}`
 * are all refused rather than normalised. Three-digit shorthand is valid CSS
 * but is refused too — one shape in the database beats two, and every colour
 * this app writes comes from a preset or an `<input type="color">`, both of
 * which produce the long form.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/** The colour in one canonical shape (lowercase), or null if it is not one. */
export function normalizeHexColor(value: unknown): string | null {
  return isHexColor(value) ? value.toLowerCase() : null;
}

/** WCAG relative luminance of a `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio of a colour against white — 1 (white) … 21 (black). */
export function contrastWithWhite(hex: string): number {
  if (!isHexColor(hex)) return 0;
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

/**
 * How dark the two colours have to be, and why there is a floor at all.
 *
 * The sidebar is light-on-dark by construction: its text, its section labels
 * and its active row are white or a mix of white towards the rail. A pale rail
 * does not make it "a light theme", it makes it unreadable — so a pale rail is
 * refused rather than half-supported. 8:1 lets anything down to roughly #4d4d4d
 * through, which still carries the faintest label (a 50% white mix) legibly.
 *
 * The brand carries white text wherever it is a background (every `.btn`, the
 * active nav row, a ticked day cell), so it needs the normal AA ratio of 4.5.
 */
export const MIN_RAIL_CONTRAST = 8;
export const MIN_BRAND_CONTRAST = 4.5;

/** Is this dark enough to be a sidebar? */
export function isUsableRail(hex: unknown): boolean {
  return isHexColor(hex) && contrastWithWhite(hex) >= MIN_RAIL_CONTRAST;
}

/** Is this dark enough to carry the white text every button puts on it? */
export function isUsableBrand(hex: unknown): boolean {
  return isHexColor(hex) && contrastWithWhite(hex) >= MIN_BRAND_CONTRAST;
}

// ---------------------------------------------------------------------------
// Members & roles
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Halls (堂会) — 中文堂 / 英文堂 / 马来文堂
// ---------------------------------------------------------------------------

/**
 * A congregation within the same church, sharing one database. Members and
 * groups always belong to exactly one hall; trainings and events may leave it
 * null to mean "open to every hall"; an account with a null hall has
 * full (all-hall) access.
 */
export interface Hall {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

/**
 * Church-level standing, stored on the member. Independent of any group.
 */
export enum ChurchRole {
  Pastor = 'pastor', // 牧师
  Deacon = 'deacon', // 执事
  CoWorker = 'co_worker', // 同工
  Member = 'member', // 一般成员 (real rank derived from group position)
  /**
   * 访客 — somebody who comes but has not joined (migration 0021). A church
   * ROLE rather than a status: "visitor" is what they are to the church, not
   * whether their record is active, so a visitor who stops coming is an
   * inactive visitor and both facts survive.
   */
  Visitor = 'visitor',
}

/**
 * A member's classification within their group. This is where the ranks
 * (minus 牧师) come from — allocated per member in the group setup page.
 */
export enum GroupPosition {
  Leader = 'leader', // 小组长
  AssistantLeader = 'assistant_leader', // 副组长
  InternLeader = 'intern_leader', // 实习组长
  CoreMember = 'core_member', // 核心成员
  RegularMember = 'regular_member', // 普通成员
  NewMember = 'new_member', // 新成员
}

/** Positions that count as group leadership (one holder per group each). */
export const LEADERSHIP_POSITIONS: GroupPosition[] = [
  GroupPosition.Leader,
  GroupPosition.AssistantLeader,
  GroupPosition.InternLeader,
];

/**
 * The single rank shown for a member in the directory, badges and charts. It is
 * a language-independent code (never a translated label) so it can key colour
 * palettes, filters and sort orders without breaking when the UI language
 * changes — the label comes from the i18n dictionary at render time.
 */
export enum DisplayRole {
  Pastor = 'pastor',
  Deacon = 'deacon',
  CoWorker = 'co_worker',
  Leader = 'leader',
  AssistantLeader = 'assistant_leader',
  InternLeader = 'intern_leader',
  CoreMember = 'core_member',
  RegularMember = 'regular_member',
  NewMember = 'new_member',
  Visitor = 'visitor',
  Ungrouped = 'ungrouped',
}

/** Full display order for the ranks (church-wide roles first, then group positions). */
export const DISPLAY_ROLE_ORDER: DisplayRole[] = [
  DisplayRole.Pastor,
  DisplayRole.Deacon,
  DisplayRole.CoWorker,
  DisplayRole.Leader,
  DisplayRole.AssistantLeader,
  DisplayRole.InternLeader,
  DisplayRole.CoreMember,
  DisplayRole.RegularMember,
  DisplayRole.NewMember,
  // Last, because it is where somebody starts: a visitor holds no rank in a
  // group, and reading the list top to bottom is reading it from the pulpit
  // to the door.
  DisplayRole.Visitor,
];

/** A group position maps 1:1 onto the display role of the same rank. */
const POSITION_DISPLAY_ROLE: Record<GroupPosition, DisplayRole> = {
  [GroupPosition.Leader]: DisplayRole.Leader,
  [GroupPosition.AssistantLeader]: DisplayRole.AssistantLeader,
  [GroupPosition.InternLeader]: DisplayRole.InternLeader,
  [GroupPosition.CoreMember]: DisplayRole.CoreMember,
  [GroupPosition.RegularMember]: DisplayRole.RegularMember,
  [GroupPosition.NewMember]: DisplayRole.NewMember,
};

/** The role shown in the directory: the church-wide role if set, else the group position. */
export function displayRole(m: {
  church_role: ChurchRole;
  group_position: GroupPosition | null;
}): DisplayRole {
  if (m.church_role === ChurchRole.Pastor) return DisplayRole.Pastor;
  if (m.church_role === ChurchRole.Deacon) return DisplayRole.Deacon;
  if (m.church_role === ChurchRole.CoWorker) return DisplayRole.CoWorker;
  // Before the group position, like every other church-wide role: a visitor
  // sitting in on a life group is still a visitor, which is the whole reason
  // this is a role rather than a status.
  if (m.church_role === ChurchRole.Visitor) return DisplayRole.Visitor;
  if (m.group_position) return POSITION_DISPLAY_ROLE[m.group_position];
  return DisplayRole.Ungrouped;
}

/** Only a core member may be promoted to a leadership position. */
export function canPromoteToLeadership(pos: GroupPosition | null): boolean {
  return (
    pos === GroupPosition.CoreMember ||
    (pos != null && LEADERSHIP_POSITIONS.includes(pos))
  );
}

export enum MemberStatus {
  Active = 'active',
  Inactive = 'inactive',
}

export enum Gender {
  Male = 'male',
  Female = 'female',
  Other = 'other',
}

export interface Member {
  id: string;
  /** The CHINESE name — what the church types and what every list is sorted by. */
  full_name: string;
  /**
   * The English name (migration 0018), null when the person has none. Together
   * with `full_name` it is the identity of a member: the database refuses a
   * second row with the same pair, so two people who share a Chinese name are
   * told apart here.
   */
  english_name: string | null;
  email: string | null;
  phone: string | null;
  /**
   * Free text, as you would write it on an envelope (migration 0021).
   * Deliberately not street / unit / postcode / state: every attempt to model
   * a Malaysian address that way leaves half the rows working around it.
   */
  address: string | null;
  /**
   * 推荐人 — the member who brought this person, or null for the ordinary case
   * of nobody (migration 0021). The church's record of how somebody arrived,
   * which is why it is the church's to write and not the person's.
   */
  referred_by: string | null;
  gender: Gender | null;
  date_of_birth: string | null;
  church_role: ChurchRole;
  status: MemberStatus;
  group_id: string | null;
  group_position: GroupPosition | null;
  hall_id: string;
  /** 来访日期 — when this person first came (label only; the column is unchanged). */
  joined_at: string | null;
  /**
   * 加入小组日期 — when they joined their CURRENT group (migration 0023). A
   * separate fact from `joined_at`: a person can join the church years before
   * joining a group, or the other way round. Nullable and excluded from any
   * report built on it, the same as `joined_at`.
   */
  group_joined_at: string | null;
  notes: string | null;
  /**
   * 服侍岗位 — the ministries this person serves in (migration 0019). Free text,
   * several per person, `groups.tags`'s own shape. Empty = serves nowhere,
   * which is a fact rather than a missing value; never null (defaults to `{}`).
   */
  serving_roles: string[];
  /** Public URL of the uploaded avatar photo; null = none. */
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Groups (小组) & households
// ---------------------------------------------------------------------------

export enum Weekday {
  Sunday = 'sunday',
  Monday = 'monday',
  Tuesday = 'tuesday',
  Wednesday = 'wednesday',
  Thursday = 'thursday',
  Friday = 'friday',
  Saturday = 'saturday',
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  meeting_day: Weekday | null;
  meeting_time: string | null; // "HH:MM:SS" (Postgres `time`)
  location: string | null;
  tags: string[]; // free-form, admin-defined (e.g. 年轻人/职青/晚上)
  hall_id: string;
  created_at: string;
  // Leadership is derived from members.group_position, not stored here.
}

export interface Household {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Events & attendance
// ---------------------------------------------------------------------------

export enum EventType {
  Service = 'service', // 主日崇拜
  Meeting = 'meeting', // 聚会
  Prayer = 'prayer', // 祷告会
  Fellowship = 'fellowship', // 团契
  Other = 'other',
}

export interface ChurchEvent {
  id: string;
  title: string;
  description: string | null;
  event_type: EventType;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  /** null = 全堂开放 / 联合聚会. */
  hall_id: string | null;
  created_at: string;
}

export enum AttendanceStatus {
  Present = 'present',
  Absent = 'absent',
  Excused = 'excused',
}

export interface EventAttendance {
  id: string;
  event_id: string;
  member_id: string;
  status: AttendanceStatus;
  checked_in_at: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Donations
// ---------------------------------------------------------------------------

export enum DonationMethod {
  Cash = 'cash',
  BankTransfer = 'bank_transfer',
  Card = 'card',
  Online = 'online',
  Other = 'other',
}

export interface Donation {
  id: string;
  member_id: string | null; // null = anonymous
  amount: number;
  currency: string;
  fund: string; // e.g. tithe, offering, building, mission
  method: DonationMethod;
  donated_at: string;
  notes: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 培训&活动 — the catalog, its sessions, enrollment & attendance
// ---------------------------------------------------------------------------

/**
 * Which shape a `trainings` row is (`kind`, migration 0014). Both take
 * sign-ups and both get ticked off; only the shape differs.
 *
 * A stored code, never a label — the UI branches on it and the catalog filters
 * by it, so it has to survive a language switch (rule G8).
 */
export enum TrainingKind {
  /** Several sessions on several dates, ticked session by session. */
  Course = 'course',
  /** ONE occasion: people sign up, you tick who came (兄弟团爬山…). */
  Activity = 'activity',
}

export const TRAINING_KINDS: readonly TrainingKind[] = [
  TrainingKind.Course,
  TrainingKind.Activity,
];

/** Is this a shape the app ships? Guards a write against a junk `kind`. */
export function isTrainingKind(value: unknown): value is TrainingKind {
  return (TRAINING_KINDS as readonly string[]).includes(String(value));
}

/**
 * 活动分类 — an ACTIVITY's own category (never a course's), so a pastor can
 * see over a year how many of each kind of activity the church actually
 * ran. A fixed, short list on purpose: free text would never roll up into
 * a dashboard summary two people would describe the same way (migration
 * 0027).
 */
export enum TrainingCategory {
  Evangelism = 'evangelism',
  Fellowship = 'fellowship',
  Visitation = 'visitation',
  Charity = 'charity',
  Volunteer = 'volunteer',
  Recreation = 'recreation',
}

export const TRAINING_CATEGORIES: readonly TrainingCategory[] = [
  TrainingCategory.Evangelism,
  TrainingCategory.Fellowship,
  TrainingCategory.Visitation,
  TrainingCategory.Charity,
  TrainingCategory.Volunteer,
  TrainingCategory.Recreation,
];

/** Is this a category the app ships? Guards a write against junk text. */
export function isTrainingCategory(value: unknown): value is TrainingCategory {
  return (TRAINING_CATEGORIES as readonly string[]).includes(String(value));
}

export interface Training {
  id: string;
  name: string;
  description: string | null;
  /** 'course' | 'activity' — see TrainingKind. */
  kind: TrainingKind;
  /** 负责人 — free text: the person in charge is often not a member (0016). */
  pic: string | null;
  /** How to reach them — a phone number, usually. People ring before signing up. */
  pic_contact: string | null;
  total_sessions: number;
  is_enrollable: boolean;
  starts_on: string | null;
  ends_on: string | null;
  /** An ACTIVITY's start time, "HH:MM:SS" (Postgres `time`) — Malaysia, always. */
  start_time: string | null;
  /** An ACTIVITY's meeting point. A course's places live on its sessions. */
  location: string | null;
  /** 报名费. null (or 0) = free, and the payment fields below stay hidden. */
  fee: string | number | null;
  /** Free text: bank account, TnG number, "pay the treasurer on the day". */
  payment_instructions: string | null;
  /** Public URL of an uploaded payment QR image; null = none. */
  payment_qr_url: string | null;
  /** null = 全堂开放（任何堂的成员都可报名）. */
  hall_id: string | null;
  created_at: string;
}

export interface TrainingSession {
  id: string;
  training_id: string;
  session_number: number;
  title: string | null;
  scheduled_at: string | null;
  location: string | null;
  notes: string | null;
}

export enum EnrollmentStatus {
  Pending = 'pending', // requested, awaiting admin approval
  Approved = 'approved', // admin approved / enrolled
  InProgress = 'in_progress',
  Completed = 'completed',
  Dropped = 'dropped',
}

export interface TrainingEnrollment {
  id: string;
  training_id: string;
  member_id: string;
  status: EnrollmentStatus;
  progress: number; // 0-100
  enrolled_at: string;
  completed_at: string | null;
  notes: string | null;
  /**
   * The receipt uploaded with a sign-up for a course that charges a 报名费
   * (0016). Null on a free one. The admin opens it BEFORE approving — that is
   * what approval means on a paid course.
   */
  payment_slip_url: string | null;
}

export interface TrainingAttendance {
  id: string;
  session_id: string;
  member_id: string;
  attended: boolean;
  checked_at: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Discipleship: 四十天一对一守望 (Forty Days one-on-one)
// ---------------------------------------------------------------------------

export interface DiscipleshipProgram {
  id: string;
  name: string;
  description: string | null;
  total_days: number; // default 40
  created_at: string;
}

export enum PairStatus {
  Active = 'active',
  Completed = 'completed',
  Paused = 'paused',
}

/**
 * A one-to-one mentoring pair inside a program. The cascade is captured by
 * parent_pair_id: a trainee of one pair becomes the mentor of the next.
 */
export interface DiscipleshipPair {
  id: string;
  program_id: string;
  mentor_id: string;
  trainee_id: string;
  parent_pair_id: string | null;
  status: PairStatus;
  start_date: string | null;
  /** Unguessable token for the mentor's private daily-form link. */
  form_token: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 幸福小组 (Happiness Groups): 期 (term) → group → roster + weekly attendance
// (migration 0022)
// ---------------------------------------------------------------------------

/**
 * 期 — a term of 幸福小组. Church-wide, not per-congregation: several terms
 * may overlap (an old one finishing while the next begins is normal), and
 * every group inside one runs the same `weeks` — which is what makes "week 5"
 * mean one thing across the term's groups and what makes one term comparable
 * against the last.
 */
export interface HappinessTerm {
  id: string;
  term_no: number;
  name: string | null;
  /** How many weeks every group in this term runs. 1..52, default 8. */
  weeks: number;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
}

/**
 * One 幸福小组 inside a term. `hall_id` is a direct, required column — exactly
 * like `groups` — because a 幸福小组 meets somewhere and belongs to a
 * congregation (the hall gate reads it, rule G2); its LENGTH, unlike a life
 * group's, comes from the term rather than being its own. `leader_id` is set
 * null (never cascaded) if that member is deleted, so losing the leader's
 * name never deletes the group and its roster with it.
 */
export interface HappinessGroup {
  id: string;
  term_id: string;
  name: string;
  hall_id: string;
  leader_id: string | null;
  meeting_day: Weekday | null;
  meeting_time: string | null; // "HH:MM:SS" (Postgres `time`)
  location: string | null;
  created_at: string;
}

/**
 * The roster: who is in a 幸福小组 — 教会成员 and 福友 alike. A 福友 is simply a
 * `members` row carrying the 访客 church role (0021), so this is an ordinary
 * join table rather than a second list of names.
 */
export interface HappinessGroupMember {
  id: string;
  group_id: string;
  member_id: string;
  created_at: string;
}

/**
 * One week's roll call, PRESENCE-ONLY: a row means "present that week" — there
 * is no boolean to flip. Marking present INSERTs; marking absent DELETES the
 * row. This is the opposite convention from `DiscipleshipProgress` (which
 * upserts a `completed` boolean) — do not copy that shape here.
 *
 * `week_number` is checked 1..52 by the database; the API additionally
 * refuses a week beyond the TERM's own `weeks`, a bound the check constraint
 * cannot reach. Weeks are counted by NUMBER, not by calendar date — the one
 * roll call in the app that is not date-based.
 */
export interface HappinessAttendance {
  id: string;
  group_id: string;
  member_id: string;
  week_number: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// App users / login accounts (用户管理)
// ---------------------------------------------------------------------------

/**
 * Permission role for a login account — what the person may DO in the app.
 * Distinct from their church/group identity (which is derived on the member).
 */
export enum AccountRole {
  SuperAdmin = 'super_admin', // 超级管理员
  Admin = 'admin', // 管理员
  Coworker = 'coworker', // 同工
  /**
   * 小组长's auto-provisioned login (migration 0023/0026) — granted and
   * revoked by the server itself (`syncGroupLeaderAccount`) whenever a
   * member's `group_position` becomes or stops being `leader`, never created
   * by hand through the accounts page. Scoped to exactly ONE group
   * (`app_users.group_id`), which is narrower than every other role's
   * hall-wide reach — a deliberate exception, not an oversight. Sits between
   * `coworker` and `readonly` in the database enum (0023): real writes, but
   * only inside its own group.
   */
  GroupLeader = 'group_leader', // 小组长（自动开通）
  ReadOnly = 'readonly', // 只读
}

export enum AccountStatus {
  Active = 'active',
  Disabled = 'disabled',
}

/**
 * Interface languages. English is the default and the fallback: it is the base
 * dictionary every other language is type-checked against.
 */
export const LANGUAGES = ['en', 'zh', 'ms'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'zh';

/** Coerce a stored/browser language tag (`zh-CN`, `en-US`, …) to a supported one. */
export function normalizeLanguage(value: string | null | undefined): Language {
  const base = String(value ?? '').toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(base)
    ? (base as Language)
    : DEFAULT_LANGUAGE;
}

/** A login account, tied one-to-one to a member profile. */
export interface AppUser {
  id: string;
  member_id: string;
  email: string;
  account_role: AccountRole;
  /** null = 全堂权限; a value scopes this account to a single hall. */
  hall_id: string | null;
  status: AccountStatus;
  two_factor: boolean;
  /** Interface language for this account — 'en' | 'zh' | 'ms'. */
  language: Language;
  notify_discipleship: boolean;
  notify_donation: boolean;
  notify_weekly: boolean;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One daily form entry filled in by the mentor for a pair. */
export interface DiscipleshipProgress {
  id: string;
  pair_id: string;
  day_number: number; // 1..total_days
  entry_date: string | null;
  completed: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
