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

export const OPTIONAL_MODULES: readonly OptionalModule[] = [
  // 四十天守望 — the forty-day one-to-one discipleship section. Only some
  // churches run it, which is why it is the first module to become optional.
  { key: MODULE_DISCIPLESHIP, nav: '/discipleship', api: ['discipleship'] },
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
  full_name: string;
  chinese_name: string | null;
  email: string | null;
  phone: string | null;
  gender: Gender | null;
  date_of_birth: string | null;
  church_role: ChurchRole;
  status: MemberStatus;
  group_id: string | null;
  group_position: GroupPosition | null;
  household_id: string | null;
  hall_id: string;
  joined_at: string | null;
  notes: string | null;
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

export interface Training {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  /** 'course' | 'activity' — see TrainingKind. */
  kind: TrainingKind;
  trainer_id: string | null;
  total_sessions: number;
  is_enrollable: boolean;
  starts_on: string | null;
  ends_on: string | null;
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
export const DEFAULT_LANGUAGE: Language = 'en';

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
