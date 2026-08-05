/**
 * Shared domain types & enums for the Church Management System (tog).
 * Mirrors the Supabase schema in /supabase/migrations.
 */

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

export const GROUP_POSITION_LABELS: Record<GroupPosition, { en: string; zh: string }> = {
  [GroupPosition.Leader]: { en: 'Group Leader', zh: '小组长' },
  [GroupPosition.AssistantLeader]: { en: 'Assistant Leader', zh: '副组长' },
  [GroupPosition.InternLeader]: { en: 'Intern Leader', zh: '实习组长' },
  [GroupPosition.CoreMember]: { en: 'Core Member', zh: '核心成员' },
  [GroupPosition.RegularMember]: { en: 'Regular Member', zh: '普通成员' },
  [GroupPosition.NewMember]: { en: 'New Member', zh: '新成员' },
};

/** Full display order for the ranks (church-wide roles first, then group positions). */
export const DISPLAY_ROLE_ORDER: string[] = [
  '牧师',
  '执事',
  '同工',
  '小组长',
  '副组长',
  '实习组长',
  '核心成员',
  '普通成员',
  '新成员',
];

/** The role shown in the directory: the church-wide role if set, else the group position. */
export function displayRoleZh(m: {
  church_role: ChurchRole;
  group_position: GroupPosition | null;
}): string {
  if (m.church_role === ChurchRole.Pastor) return '牧师';
  if (m.church_role === ChurchRole.Deacon) return '执事';
  if (m.church_role === ChurchRole.CoWorker) return '同工';
  if (m.group_position) return GROUP_POSITION_LABELS[m.group_position].zh;
  return '未分组';
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
  /** Set when this event was generated by a 循环聚会 rule. */
  recurring_id: string | null;
  created_at: string;
}

/**
 * A 循环聚会 schedule — e.g. 每周日 10:00 主日崇拜. The calendar is topped up
 * from these rules (`lookahead_days` ahead) instead of anyone adding the same
 * service by hand every week.
 *
 * Deleting a rule keeps the events it already produced; they just lose the
 * link back to it.
 */
export interface RecurringEvent {
  id: string;
  title: string;
  event_type: EventType;
  weekday: Weekday;
  start_time: string; // "HH:MM:SS" (Postgres `time`)
  location: string | null;
  /** null = 全堂 / 联合聚会. */
  hall_id: string | null;
  lookahead_days: number;
  active: boolean;
  /**
   * Last date this rule generated. Generation only looks past it, so a
   * deleted occurrence stays deleted and editing the weekday/time doesn't
   * regenerate the window already filled at the old time.
   */
  generated_through: string | null;
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
// Training catalog, sessions, enrollment & attendance
// ---------------------------------------------------------------------------

export interface Training {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
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

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  [AccountRole.SuperAdmin]: '超级管理员',
  [AccountRole.Admin]: '管理员',
  [AccountRole.Coworker]: '同工',
  [AccountRole.ReadOnly]: '只读',
};

export enum AccountStatus {
  Active = 'active',
  Disabled = 'disabled',
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
  language: string;
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
