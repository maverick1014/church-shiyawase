import {
  AccountRole,
  AccountStatus,
  AttendanceStatus,
  ChurchRole,
  DisplayRole,
  DISPLAY_ROLE_ORDER,
  EnrollmentStatus,
  EventType,
  Gender,
  GroupPosition,
  MemberStatus,
  PairStatus,
  Weekday,
  displayRole,
} from '@tog/shared';
import type { MessageKey } from './i18n/en';
import { churchParts } from './time';

const pad2 = (n: number) => String(n).padStart(2, '0');

/*
 * This module never returns a translated string — it returns the *key* the
 * caller renders through `t()`. That keeps one dictionary as the single source
 * of wording (G4) and keeps palettes/filters keyed by stable codes so they
 * survive a language switch.
 */

/* -------------------------------------------------------------------------
 * Members & derived identity
 * ---------------------------------------------------------------------- */

/** Message key for a group position (小组长/副组长/…) — falls back to 未分组. */
export function positionKey(pos: GroupPosition | string | null): MessageKey {
  if (!pos) return 'role.ungrouped';
  return `role.${pos}` as MessageKey;
}

/** Message key for a display role code. */
export function roleKey(role: DisplayRole | string): MessageKey {
  return `role.${role}` as MessageKey;
}

/** The role shown for a member: 牧师 if pastor, else their group position. */
export function memberRole(m: {
  church_role: ChurchRole;
  group_position: GroupPosition | null;
}): DisplayRole {
  return displayRole(m);
}

/** The church-wide role only — never the group position. */
export function churchRoleKey(role: ChurchRole | string): MessageKey {
  return `churchRole.${role}` as MessageKey;
}

/**
 * The badge palette is keyed by DisplayRole, so a church role has to be mapped
 * onto its equivalent rank before it can be rendered with `RoleBadge`.
 */
const CHURCH_DISPLAY_ROLE: Record<ChurchRole, DisplayRole> = {
  [ChurchRole.Pastor]: DisplayRole.Pastor,
  [ChurchRole.Deacon]: DisplayRole.Deacon,
  [ChurchRole.CoWorker]: DisplayRole.CoWorker,
  [ChurchRole.Member]: DisplayRole.RegularMember,
};

export function churchDisplayRole(role: ChurchRole | string): DisplayRole {
  return CHURCH_DISPLAY_ROLE[role as ChurchRole] ?? DisplayRole.Ungrouped;
}

export const CHURCH_ROLE_OPTIONS: ChurchRole[] = [
  ChurchRole.Pastor,
  ChurchRole.Deacon,
  ChurchRole.CoWorker,
  ChurchRole.Member,
];

/** Full display order for the ranks, for filter dropdowns + charts. */
export const ROLE_ORDER = DISPLAY_ROLE_ORDER;

/** Member-directory filters: the ranks plus 未分组 (unassigned). */
export const MEMBER_ROLE_FILTERS: DisplayRole[] = [...ROLE_ORDER, DisplayRole.Ungrouped];

/**
 * The six in-group ranks, in promotion order — shared by 小组管理's position
 * dropdown and the member-profile edit modal so both offer the same options
 * with the same leadership rule (see `canPromoteToLeadership`).
 */
export const GROUP_POSITION_OPTIONS: GroupPosition[] = [
  GroupPosition.Leader,
  GroupPosition.AssistantLeader,
  GroupPosition.InternLeader,
  GroupPosition.CoreMember,
  GroupPosition.RegularMember,
  GroupPosition.NewMember,
];

/* -------------------------------------------------------------------------
 * Groups — meeting schedule
 * ---------------------------------------------------------------------- */

export const WEEKDAY_OPTIONS: Weekday[] = [
  Weekday.Sunday,
  Weekday.Monday,
  Weekday.Tuesday,
  Weekday.Wednesday,
  Weekday.Thursday,
  Weekday.Friday,
  Weekday.Saturday,
];

export function weekdayKey(day: Weekday | string): MessageKey {
  return `weekday.${day}` as MessageKey;
}

/**
 * The JavaScript day number (0 = Sunday) for a stored weekday.
 *
 * WEEKDAY_OPTIONS is already in that order, so the lookup is the list itself
 * rather than a second table that could drift from it. An unrecognised value
 * falls back to Sunday, which is what a group with no meeting day shows.
 */
export function weekdayIndex(day: Weekday | string | null): number {
  const i = WEEKDAY_OPTIONS.indexOf(day as Weekday);
  return i < 0 ? 0 : i;
}

/** Postgres `time` comes back as "HH:MM:SS" — trim to "HH:MM" for display. */
export function formatMeetingTime(time: string | null): string {
  return time ? time.slice(0, 5) : '';
}

/** Combined "周二 20:00 · Emily家" summary for lists — blank pieces are skipped. */
export function meetingSchedule(
  g: { meeting_day: Weekday | string | null; meeting_time: string | null; location: string | null },
  t: (key: MessageKey) => string,
): string {
  const day = g.meeting_day ? t(weekdayKey(g.meeting_day)) : '';
  const dayTime = [day, formatMeetingTime(g.meeting_time)].filter(Boolean).join(' ');
  return [dayTime, g.location].filter(Boolean).join(' · ');
}

/**
 * Group health — derived purely from member counts (never stored): whether a
 * group is ready to split into two, could use more people, or is balanced.
 *   splittable:    total > 10 and new-member count <= 2
 *   need_members:  total < 10 and new-member count <= old-member count
 *   balanced:      everything else (incl. total === 10 exactly)
 */
export type GroupHealthStatus = 'splittable' | 'need_members' | 'balanced';

export function groupHealthStatus(totalMembers: number, newMembers: number): GroupHealthStatus {
  const oldMembers = totalMembers - newMembers;
  if (totalMembers > 10 && newMembers <= 2) return 'splittable';
  if (totalMembers < 10 && newMembers <= oldMembers) return 'need_members';
  return 'balanced';
}

export function groupHealthKey(status: GroupHealthStatus): MessageKey {
  return `groupHealth.${status}` as MessageKey;
}

export function groupHealthClass(status: GroupHealthStatus): string {
  switch (status) {
    case 'splittable':
      return 'b-good';
    case 'need_members':
      return 'b-warn';
    default:
      return 'b-gray';
  }
}

/**
 * Per-role tag palette — matches the Claude Design `roleTags` exactly. Each
 * derived role gets its own colour family (bg / fg / dot), not a shared tone.
 * Keyed by the DisplayRole code so the colours survive a language switch.
 */
export const ROLE_TAG: Record<string, { bg: string; fg: string; dot: string }> = {
  [DisplayRole.Pastor]: { bg: '#fbe3e0', fg: '#b3261e', dot: '#d1362b' },
  [DisplayRole.Deacon]: { bg: '#fde2ef', fg: '#a3266d', dot: '#c93b8d' },
  [DisplayRole.CoWorker]: { bg: '#dcf3ee', fg: '#157866', dot: '#22a087' },
  [DisplayRole.Leader]: { bg: '#fce7d4', fg: '#b5650f', dot: '#e0862b' },
  [DisplayRole.AssistantLeader]: { bg: '#faf0c6', fg: '#8a6a0d', dot: '#d4a715' },
  [DisplayRole.InternLeader]: { bg: '#d7f0df', fg: '#1f7a44', dot: '#2f9e5b' },
  [DisplayRole.CoreMember]: { bg: '#dae8fb', fg: '#1d5fb8', dot: '#2f7ad1' },
  [DisplayRole.RegularMember]: { bg: '#e5e8ec', fg: '#4a5560', dot: '#7c8894' },
  [DisplayRole.NewMember]: { bg: '#eae1f8', fg: '#6b3fa0', dot: '#8b5cc7' },
  [DisplayRole.Visitor]: { bg: '#ece9e6', fg: '#7a736e', dot: '#b0a49b' },
  [DisplayRole.Ungrouped]: { bg: '#f0eeec', fg: '#9a938f', dot: '#c3bbb6' },
};

/** Inline background/color for a role badge (design roleTag). */
export function roleTagStyle(role: string): { background: string; color: string } {
  const t = ROLE_TAG[role] ?? ROLE_TAG[DisplayRole.Ungrouped];
  return { background: t.bg, color: t.fg };
}

/** Dot colour for a role (design roleDot) — also used by the identity chart. */
export function roleDot(role: string): string {
  return (ROLE_TAG[role] ?? ROLE_TAG[DisplayRole.Ungrouped]).dot;
}

export const MEMBER_STATUS_OPTIONS: MemberStatus[] = [
  MemberStatus.Active,
  MemberStatus.Inactive,
];

export function memberStatusKey(status: string): MessageKey {
  return `memberStatus.${status}` as MessageKey;
}

export function memberStatusClass(status: string): string {
  if (status === MemberStatus.Active) return 'b-good';
  return 'b-gray';
}

export const GENDER_OPTIONS: Gender[] = [Gender.Male, Gender.Female, Gender.Other];

export function genderKey(gender: string): MessageKey {
  return `gender.${gender}` as MessageKey;
}

/* -------------------------------------------------------------------------
 * Events & attendance
 * ---------------------------------------------------------------------- */

export const EVENT_TYPE_OPTIONS: EventType[] = [
  EventType.Service,
  EventType.Meeting,
  EventType.Prayer,
  EventType.Fellowship,
  EventType.Other,
];

export function eventTypeKey(type: string): MessageKey {
  return `eventType.${type}` as MessageKey;
}

export function eventBadgeClass(type: string): string {
  if (type === EventType.Service) return 'b-brand';
  if (type === EventType.Prayer) return 'b-accent';
  if (type === EventType.Fellowship) return 'b-good';
  if (type === EventType.Meeting) return 'b-warn';
  return 'b-gray';
}

export const ATTENDANCE_OPTIONS: AttendanceStatus[] = [
  AttendanceStatus.Present,
  AttendanceStatus.Excused,
  AttendanceStatus.Absent,
];

export function attendanceKey(status: string): MessageKey {
  return `attendance.${status}` as MessageKey;
}

/* -------------------------------------------------------------------------
 * Trainings & enrollment
 * ---------------------------------------------------------------------- */

/**
 * Category is a free-text column, so the three seeded values are stored as the
 * original Chinese words. They are mapped to a dictionary key for display; any
 * other value a church types in is shown verbatim.
 */
const TRAINING_CATEGORY_KEYS: Record<string, MessageKey> = {
  门徒: 'trainingCategory.discipleship',
  栽培: 'trainingCategory.nurture',
  事奉: 'trainingCategory.service',
};

export const TRAINING_CATEGORIES = Object.keys(TRAINING_CATEGORY_KEYS);

export function trainingCategoryLabel(
  category: string | null,
  t: (key: MessageKey) => string,
): string {
  if (!category) return '';
  const key = TRAINING_CATEGORY_KEYS[category];
  return key ? t(key) : category;
}

/** Training-category tag — the design uses the accent tone for all categories. */
export function categoryBadgeClass(_cat: string | null): string {
  return 'b-accent';
}

export function enrollmentStatusKey(status: string): MessageKey {
  return `enrollment.${status}` as MessageKey;
}

export function enrollmentStatusClass(status: string): string {
  switch (status) {
    case EnrollmentStatus.Completed:
    case EnrollmentStatus.Approved:
      return 'b-good';
    case EnrollmentStatus.InProgress:
      return 'b-warn';
    case EnrollmentStatus.Dropped:
      return 'b-crit';
    default:
      return 'b-gray';
  }
}

/* -------------------------------------------------------------------------
 * Discipleship
 * ---------------------------------------------------------------------- */

export function pairStatusKey(status: string): MessageKey {
  return `pairStatus.${status}` as MessageKey;
}

export function pairStatusClass(status: string): string {
  switch (status) {
    case PairStatus.Completed:
      return 'b-good';
    case PairStatus.Paused:
      return 'b-gray';
    default:
      return 'b-warn';
  }
}

/* -------------------------------------------------------------------------
 * Accounts (用户管理)
 * ---------------------------------------------------------------------- */

/** The bare role name — badges, table cells and sort keys. */
export function accountRoleKey(role: AccountRole | string): MessageKey {
  return `accountRole.${role}` as MessageKey;
}

/**
 * The role name plus a one-line summary of what it may do — for the 权限角色
 * `<option>`s only, so the meaning is on screen at the moment the role is
 * picked. Deliberately a *separate* key from `accountRoleKey`: reusing that one
 * would grow every role badge into a sentence.
 */
export function accountRoleOptionKey(role: AccountRole | string): MessageKey {
  return `accountRole.${role}.option` as MessageKey;
}

export const ACCOUNT_ROLE_OPTIONS: AccountRole[] = [
  AccountRole.SuperAdmin,
  AccountRole.Admin,
  AccountRole.Coworker,
  AccountRole.ReadOnly,
];

export function accountRoleClass(role: string): string {
  switch (role) {
    case AccountRole.SuperAdmin:
      return 'b-brand';
    case AccountRole.Admin:
      return 'b-accent';
    case AccountRole.Coworker:
      return 'b-good';
    default:
      return 'b-gray';
  }
}

export function accountStatusKey(status: string): MessageKey {
  return status === AccountStatus.Active ? 'accountStatus.active' : 'accountStatus.disabled';
}

export function accountStatusClass(status: string): string {
  return status === AccountStatus.Active ? 'b-good' : 'b-gray';
}

/* -------------------------------------------------------------------------
 * Formatting helpers
 * ---------------------------------------------------------------------- */

export function initialOf(name: string | null | undefined): string {
  if (!name) return '?';
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // CJK names read best as the last two characters; Latin ones as the initial.
  return /[\u3400-\u9fff]/.test(trimmed)
    ? trimmed.slice(-2)
    : trimmed.slice(0, 1).toUpperCase();
}

// Both read in Malaysia time (lib/time.ts), never the runtime's zone — the
// Worker runs in UTC, so `getHours()` here rendered a 10:00 service as 02:00.
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = churchParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = churchParts(d);
  return `${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function formatMoney(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return n.toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatMoneyShort(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return n.toLocaleString('en-MY');
}
