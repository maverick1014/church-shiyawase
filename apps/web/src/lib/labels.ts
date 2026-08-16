import {
  AccountRole,
  AccountStatus,
  ChurchRole,
  DisplayRole,
  DISPLAY_ROLE_ORDER,
  EnrollmentStatus,
  EventType,
  Gender,
  GroupPosition,
  MemberStatus,
  PairStatus,
  TrainingCategory,
  TrainingKind,
  Weekday,
  displayRole,
} from '@tog/shared';
import type { ComboOption } from './combobox';
import type { MessageKey } from './i18n/en';
import type { ImportIssue } from './members-import';
import type { SheetTickName } from './types';
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
  [ChurchRole.Visitor]: DisplayRole.Visitor,
  [ChurchRole.Best]: DisplayRole.Best,
};

export function churchDisplayRole(role: ChurchRole | string): DisplayRole {
  return CHURCH_DISPLAY_ROLE[role as ChurchRole] ?? DisplayRole.Ungrouped;
}

/*
 * 教会身份 is offered by THREE forms now, and they own DISJOINT halves of the
 * enum — that split is the whole point of separating 成员 from 访客 (0031).
 * A form that offered the lot would let the 成员 page create a 访客 it then
 * refuses to list, which is exactly the mess the two pages exist to end.
 *
 * The three lists together must still cover every `ChurchRole`, and must not
 * overlap — `labels.test.ts` asserts both, so a role added to the enum and to
 * none of them fails at the point it is cheap to fix.
 */

/** What the MEMBER form may create — the ranks a member of the church holds. */
export const CHURCH_ROLE_OPTIONS: ChurchRole[] = [
  ChurchRole.Pastor,
  ChurchRole.Deacon,
  ChurchRole.CoWorker,
  ChurchRole.Member,
];

/** What the VISITOR page's own form may create — 访客 only. */
export const VISITOR_ROLE_OPTIONS: ChurchRole[] = [ChurchRole.Visitor];

/**
 * What a 幸福小组 roster may create — BEST only. There is no page whose job is
 * making one in the abstract: a BEST is somebody you MET, in a 幸福小组, so the
 * only form that offers the role is the roster's own quick-add.
 */
export const BEST_ROLE_OPTIONS: ChurchRole[] = [ChurchRole.Best];

/**
 * Which of the three a form may offer for somebody who currently holds `role`.
 *
 * A form never lets a person CROSS the split — a 访客 does not become a member
 * by someone reopening a dropdown, they become one through the 转为成员 button,
 * which is a deliberate act with a page of its own. But the `<select>` still
 * has to contain the value it is currently showing, or it renders blank and
 * saving it silently rewrites the role (the same trap `ACCOUNT_ROLE_OPTIONS`
 * documents). So the list follows the row rather than the page.
 */
export function churchRoleOptionsFor(role: ChurchRole | string | null | undefined): ChurchRole[] {
  if (role === ChurchRole.Best) return BEST_ROLE_OPTIONS;
  if (role === ChurchRole.Visitor) return VISITOR_ROLE_OPTIONS;
  return CHURCH_ROLE_OPTIONS;
}

/** Full display order for the ranks, for filter dropdowns + charts. */
export const ROLE_ORDER = DISPLAY_ROLE_ORDER;

/**
 * The display roles somebody who is NOT one of the church's own members reads
 * as — the `DisplayRole` half of `NON_MEMBER_ROLES`. Each has a page of its
 * own now (0031), which is why neither appears in the members-list filter:
 * a dropdown offering 访客 on a list that by definition contains none is a
 * filter that can only ever empty the table.
 */
export const NON_MEMBER_DISPLAY_ROLES: DisplayRole[] = [DisplayRole.Visitor, DisplayRole.Best];

/** Member-directory filters: the ranks a MEMBER can read as, plus 未分组. */
export const MEMBER_ROLE_FILTERS: DisplayRole[] = [
  ...ROLE_ORDER.filter((r) => !NON_MEMBER_DISPLAY_ROLES.includes(r)),
  DisplayRole.Ungrouped,
];

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
  // 访客 — a hue no rank uses, and a muted one: "has come, has not joined" has
  // to be told apart at a glance from 普通成员's cool grey and from 未分组's
  // warm grey, without competing with the colours leadership is painted in.
  [DisplayRole.Visitor]: { bg: '#f0e6db', fg: '#8a5a33', dot: '#b57a49' },
  // BEST — the person a 幸福小组 exists to reach (0031). A teal-leaning green
  // that no rank uses: it has to read as its own kind of person beside 访客's
  // warm sand, not as a shade of it, because the two are followed up by
  // different people for different reasons.
  [DisplayRole.Best]: { bg: '#d9f2ea', fg: '#136b5a', dot: '#1c9b81' },
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

/**
 * Why an imported row will not be applied. The code is decided in
 * `lib/members-import.ts` (which the server runs too); the wording is a
 * dictionary key, like every other enum label (rule G8).
 */
export function importIssueKey(issue: ImportIssue): MessageKey {
  return `import.issue.${issue}` as MessageKey;
}

/** What an imported row will do — the badge on every preview line. */
export function importActionKey(action: 'create' | 'update' | 'skip'): MessageKey {
  return `import.action.${action}` as MessageKey;
}

export function importActionClass(action: 'create' | 'update' | 'skip'): string {
  if (action === 'create') return 'b-good';
  if (action === 'update') return 'b-warn';
  return 'b-gray';
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

export function attendanceKey(status: string): MessageKey {
  return `attendance.${status}` as MessageKey;
}

/**
 * Message key for one tick on the 聚会点名 sheet. A Sunday carries 会前 and
 * 主日; a hand-added meeting carries the single 到场, because one occasion has
 * one thing to record.
 */
export function sheetTickKey(tick: SheetTickName): MessageKey {
  switch (tick) {
    case 'pre_service':
      return 'events.col.preService';
    case 'service':
      return 'events.col.service';
    default:
      return 'events.col.attended';
  }
}

/* -------------------------------------------------------------------------
 * 培训&活动 — the catalog, enrollment & the two shapes
 * ---------------------------------------------------------------------- */

/**
 * Message key for a `kind` (课程 / 活动). Keyed by the stored code, so the
 * catalog's filter and the page's branches survive a language switch.
 */
export function trainingKindKey(kind: TrainingKind | string): MessageKey {
  return `trainingKind.${kind}` as MessageKey;
}

/** The wording a page uses per shape: an activity never says "course". */
export function isActivity(row: { kind?: TrainingKind | string | null } | null | undefined): boolean {
  return row?.kind === TrainingKind.Activity;
}

/** Badge tone for a kind — so the two shapes are told apart at a glance. */
export function trainingKindClass(kind: TrainingKind | string): string {
  return kind === TrainingKind.Activity ? 'b-warn' : 'b-brand';
}

/** Every 活动分类 the form offers, in the order it offers them (0027). */
export const TRAINING_CATEGORY_OPTIONS: TrainingCategory[] = [
  TrainingCategory.Evangelism,
  TrainingCategory.Fellowship,
  TrainingCategory.Visitation,
  TrainingCategory.Charity,
  TrainingCategory.Volunteer,
  TrainingCategory.Recreation,
];

/** Message key for an activity's category — keyed by the stored code, same
 *  shape as `trainingKindKey` (rule G8). */
export function trainingCategoryKey(category: TrainingCategory | string): MessageKey {
  return `trainingCategory.${category}` as MessageKey;
}

/**
 * The one "who and when" line a 培训&活动 row shows — on the catalog card, on
 * the detail header and on the public sign-up page, which is why it is built
 * here once rather than three times (rules G4/G5).
 *
 * Each piece is a translated fragment or a bare date/time/place (data, not
 * copy); the caller joins them with ` · `. Empty pieces are dropped, so a
 * course with no location does not read "… ·  · …".
 *
 * The two shapes differ only in what they have to say: a COURSE runs over N
 * sessions between two dates; an ACTIVITY happens once, at a time, somewhere.
 */
export function trainingMeta(
  row: {
    kind: TrainingKind | string;
    pic: string | null;
    pic_contact: string | null;
    total_sessions: number;
    starts_on: string | null;
    ends_on: string | null;
    start_time: string | null;
    location: string | null;
    gender?: string | null;
    category?: string | null;
  },
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string[][] {
  // TWO lines, not one long one. On a phone the single joined line wrapped
  // mid-date — "日期：2026-" on one row and "09-13 14:30" on the next — which
  // is the one part of it nobody can read broken in half. Who runs the thing
  // and when it happens are separate questions anyway, so they get separate
  // rows and each stays whole. Callers join each group with ' · ' and render
  // one element per row; a group that comes back empty draws nothing.
  const who: string[] = [];
  const when: string[] = [];
  who.push(t('trainings.pic', { name: row.pic || t('common.pending') }));
  if (row.pic_contact) who.push(t('trainings.picContact', { contact: row.pic_contact }));
  // A gender restriction is a hard eligibility rule, so it rides along with
  // who to contact rather than getting a whole line of its own (rule G5).
  if (row.gender) who.push(t('trainings.genderOnly', { gender: t(genderKey(row.gender)) }));
  if (row.kind === TrainingKind.Activity) {
    if (row.category) who.push(t(trainingCategoryKey(row.category)));
    // Date and time are one fact about one occasion, so they read as one:
    // "2026-09-12 09:00". A bare `time` is a Malaysian wall-clock reading.
    const at = [formatDate(row.starts_on), formatMeetingTime(row.start_time)]
      .filter((s) => s && s !== '—')
      .join(' ');
    if (at) when.push(t('trainings.activityWhen', { when: at }));
    if (row.location) when.push(t('trainings.atPlace', { place: row.location }));
  } else {
    who.push(t('trainings.sessions', { n: row.total_sessions }));
    when.push(t('trainings.dateRange', { from: formatDate(row.starts_on), to: formatDate(row.ends_on) }));
  }
  return [who, when].filter((line) => line.length > 0);
}

/**
 * 报名费 — is there one? `numeric` arrives as a string from PostgREST, and a
 * blank field is stored as null, so "free" is one question asked in one place
 * (the server asks the same one before demanding a receipt).
 */
export function hasFee(fee: string | number | null | undefined): boolean {
  return fee !== null && fee !== undefined && String(fee).trim() !== '' && Number(fee) > 0;
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

/**
 * Every role selectable in the 权限角色 dropdown. `group_leader` is INCLUDED —
 * not because a super admin is meant to hand one out by hand (it is only ever
 * granted by `syncGroupLeaderAccount`), but so an already-provisioned
 * group_leader account still renders correctly in this same dropdown when a
 * super admin opens it on the accounts page (e.g. to disable it early, or to
 * demote it into an ordinary role) — an option missing from the list would
 * leave the `<select>` showing nothing selected. Manually setting a role TO
 * group_leader here does not populate `hall_id`/`group_id`; that pairing is
 * this mechanism's job, not the form's.
 */
export const ACCOUNT_ROLE_OPTIONS: AccountRole[] = [
  AccountRole.SuperAdmin,
  AccountRole.Admin,
  AccountRole.Coworker,
  AccountRole.GroupLeader,
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
    case AccountRole.GroupLeader:
      return 'b-warn';
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

// A friendlier range than two full formatDate() calls stapled together: the
// end date drops its year when it shares one with the start, since repeating
// it twice is what made a range like "2026-09-06 – 2026-11-08" read too long.
// Still numeric and year-first throughout (G6a) — never day/month-only, which
// is exactly the ambiguity that rule forbids.
export function formatDateRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start && !end) return '—';
  if (!start) return formatDate(end);
  if (!end) return formatDate(start);
  const sd = new Date(start);
  const ed = new Date(end);
  if (Number.isNaN(sd.getTime()) || Number.isNaN(ed.getTime())) return `${formatDate(start)} – ${formatDate(end)}`;
  const sp = churchParts(sd);
  const ep = churchParts(ed);
  const startStr = `${sp.year}-${pad2(sp.month)}-${pad2(sp.day)}`;
  const endStr = sp.year === ep.year ? `${pad2(ep.month)}-${pad2(ep.day)}` : `${ep.year}-${pad2(ep.month)}-${pad2(ep.day)}`;
  return `${startStr} – ${endStr}`;
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
