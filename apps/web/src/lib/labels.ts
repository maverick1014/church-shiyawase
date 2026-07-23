import {
  AccountRole,
  ACCOUNT_ROLE_LABELS,
  AccountStatus,
  AttendanceStatus,
  ChurchRole,
  EnrollmentStatus,
  EventType,
  Gender,
  GROUP_POSITION_LABELS,
  GroupPosition,
  MemberStatus,
  PairStatus,
  Weekday,
  displayRoleZh,
} from '@tog/shared';

/* -------------------------------------------------------------------------
 * Members & derived identity
 * ---------------------------------------------------------------------- */

/** Chinese label for a group position (小组长/副组长/…). */
export function positionZh(pos: GroupPosition | string | null): string {
  if (!pos) return '未分组';
  const l = GROUP_POSITION_LABELS[pos as GroupPosition];
  return l ? l.zh : String(pos);
}

/** The role shown for a member: 牧师 if pastor, else their group position. */
export function memberRoleZh(m: {
  church_role: ChurchRole;
  group_position: GroupPosition | null;
}): string {
  return displayRoleZh(m);
}

const CHURCH_ROLE_LABELS: Record<ChurchRole, string> = {
  [ChurchRole.Pastor]: '牧师',
  [ChurchRole.Deacon]: '执事',
  [ChurchRole.CoWorker]: '同工',
  [ChurchRole.Member]: '一般成员',
};

/** The church-wide role only (牧师/执事/同工/一般成员) — never the group position. */
export function churchRoleZh(role: ChurchRole): string {
  return CHURCH_ROLE_LABELS[role] ?? String(role);
}

/** Full display order for the seven ranks, for filter chips + charts. */
export const ROLE_ORDER = [
  '牧师',
  '执事',
  '同工',
  '小组长',
  '副组长',
  '实习组长',
  '核心成员',
  '普通成员',
  '新成员',
] as const;

/** Member-directory filter chips: the seven ranks plus 未分组 (unassigned). */
export const MEMBER_ROLE_FILTERS = [...ROLE_ORDER, '未分组'] as const;

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

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  [Weekday.Sunday]: '周日',
  [Weekday.Monday]: '周一',
  [Weekday.Tuesday]: '周二',
  [Weekday.Wednesday]: '周三',
  [Weekday.Thursday]: '周四',
  [Weekday.Friday]: '周五',
  [Weekday.Saturday]: '周六',
};

export const WEEKDAY_OPTIONS: Weekday[] = [
  Weekday.Sunday,
  Weekday.Monday,
  Weekday.Tuesday,
  Weekday.Wednesday,
  Weekday.Thursday,
  Weekday.Friday,
  Weekday.Saturday,
];

export function weekdayZh(day: Weekday | string | null): string {
  if (!day) return '';
  return WEEKDAY_LABELS[day as Weekday] ?? String(day);
}

/** Postgres `time` comes back as "HH:MM:SS" — trim to "HH:MM" for display. */
export function formatMeetingTime(time: string | null): string {
  return time ? time.slice(0, 5) : '';
}

/** Combined "周二 20:00 · Emily家" summary for lists — blank pieces are skipped. */
export function meetingScheduleZh(g: { meeting_day: Weekday | string | null; meeting_time: string | null; location: string | null }): string {
  const dayTime = [weekdayZh(g.meeting_day), formatMeetingTime(g.meeting_time)].filter(Boolean).join(' ');
  return [dayTime, g.location].filter(Boolean).join(' · ');
}

/**
 * Group health — derived purely from member counts (never stored): whether a
 * group is ready to split into two, could use more people, or is balanced.
 *   可分植 (splittable):    total > 10 and new-member count <= 2
 *   可加人 (needs members): total < 10 and new-member count <= old-member count
 *   刚好 (balanced):        everything else (incl. total === 10 exactly)
 */
export type GroupHealthStatus = 'splittable' | 'need_members' | 'balanced';

export function groupHealthStatus(totalMembers: number, newMembers: number): GroupHealthStatus {
  const oldMembers = totalMembers - newMembers;
  if (totalMembers > 10 && newMembers <= 2) return 'splittable';
  if (totalMembers < 10 && newMembers <= oldMembers) return 'need_members';
  return 'balanced';
}

export const GROUP_HEALTH_LABELS: Record<GroupHealthStatus, string> = {
  splittable: '可分植',
  need_members: '可加人',
  balanced: '刚好',
};

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
 */
export const ROLE_TAG: Record<string, { bg: string; fg: string; dot: string }> = {
  牧师: { bg: '#fbe3e0', fg: '#b3261e', dot: '#d1362b' },
  执事: { bg: '#fde2ef', fg: '#a3266d', dot: '#c93b8d' },
  同工: { bg: '#dcf3ee', fg: '#157866', dot: '#22a087' },
  一般成员: { bg: '#e5e8ec', fg: '#4a5560', dot: '#7c8894' },
  小组长: { bg: '#fce7d4', fg: '#b5650f', dot: '#e0862b' },
  副组长: { bg: '#faf0c6', fg: '#8a6a0d', dot: '#d4a715' },
  实习组长: { bg: '#d7f0df', fg: '#1f7a44', dot: '#2f9e5b' },
  核心成员: { bg: '#dae8fb', fg: '#1d5fb8', dot: '#2f7ad1' },
  普通成员: { bg: '#e5e8ec', fg: '#4a5560', dot: '#7c8894' },
  新成员: { bg: '#eae1f8', fg: '#6b3fa0', dot: '#8b5cc7' },
  访客: { bg: '#ece9e6', fg: '#7a736e', dot: '#b0a49b' },
  未分组: { bg: '#f0eeec', fg: '#9a938f', dot: '#c3bbb6' },
};

/** Inline background/color for a role badge (design roleTag). */
export function roleTagStyle(role: string): { background: string; color: string } {
  const t = ROLE_TAG[role] ?? ROLE_TAG['未分组'];
  return { background: t.bg, color: t.fg };
}

/** Dot colour for a role (design roleDot) — also used by the 身份分布 chart. */
export function roleDot(role: string): string {
  return (ROLE_TAG[role] ?? ROLE_TAG['未分组']).dot;
}

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  [MemberStatus.Active]: '在册',
  [MemberStatus.Inactive]: '停止聚会',
};

export function memberStatusLabel(status: string): string {
  return MEMBER_STATUS_LABELS[status as MemberStatus] ?? status;
}

export function memberStatusClass(status: string): string {
  if (status === MemberStatus.Active) return 'b-good';
  return 'b-gray';
}

export const GENDER_LABELS: Record<string, string> = {
  [Gender.Male]: '男',
  [Gender.Female]: '女',
  [Gender.Other]: '其他',
};

/* -------------------------------------------------------------------------
 * Events & attendance
 * ---------------------------------------------------------------------- */

export const EVENT_TYPE_LABELS: Record<string, string> = {
  [EventType.Service]: '主日崇拜',
  [EventType.Meeting]: '聚会',
  [EventType.Prayer]: '祷告会',
  [EventType.Fellowship]: '团契',
  [EventType.Other]: '其他',
};

export const EVENT_TYPE_OPTIONS = [
  EventType.Service,
  EventType.Meeting,
  EventType.Prayer,
  EventType.Fellowship,
  EventType.Other,
];

export function eventBadgeClass(type: string): string {
  if (type === EventType.Service) return 'b-brand';
  if (type === EventType.Prayer) return 'b-accent';
  if (type === EventType.Fellowship) return 'b-good';
  if (type === EventType.Meeting) return 'b-warn';
  return 'b-gray';
}

export const ATTENDANCE_LABELS: Record<string, string> = {
  [AttendanceStatus.Present]: '出席',
  [AttendanceStatus.Excused]: '请假',
  [AttendanceStatus.Absent]: '缺席',
};

/* -------------------------------------------------------------------------
 * Trainings & enrollment
 * ---------------------------------------------------------------------- */

export const TRAINING_CATEGORIES = ['门徒', '栽培', '事奉'];

/** Training-category tag — the design uses the accent tone for all categories. */
export function categoryBadgeClass(_cat: string | null): string {
  return 'b-accent';
}

export const ENROLLMENT_STATUS_LABELS: Record<string, string> = {
  [EnrollmentStatus.Pending]: '待审核',
  [EnrollmentStatus.Approved]: '已通过',
  [EnrollmentStatus.InProgress]: '进行中',
  [EnrollmentStatus.Completed]: '已完成',
  [EnrollmentStatus.Dropped]: '已退出',
};

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

export const PAIR_STATUS_LABELS: Record<string, string> = {
  [PairStatus.Active]: '进行中',
  [PairStatus.Completed]: '已完成',
  [PairStatus.Paused]: '已暂停',
};

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

export const ACCOUNT_ROLE_ZH = ACCOUNT_ROLE_LABELS;

/** What each permission role can do — shown in 用户管理 for clarity. */
export const ACCOUNT_ROLE_PERMISSIONS: Record<AccountRole, string[]> = {
  [AccountRole.SuperAdmin]: [
    '全部权限',
    '用户与权限管理',
    '系统设置',
    '所有牧养模块的增 / 删 / 改 / 查',
  ],
  [AccountRole.Admin]: [
    '成员 / 小组 / 聚会 / 培训 / 门训 的增 / 删 / 改 / 查',
    '在小组管理中分配身份',
    '不可管理登录账户与权限',
  ],
  [AccountRole.Coworker]: [
    '点名 / 培训出席 / 门训进度',
    '编辑成员基本资料',
    '不可删除记录',
    '不可管理账户或更改身份分配',
  ],
  [AccountRole.ReadOnly]: ['仅查看所有数据', '不可进行任何修改'],
};

export const ACCOUNT_ROLE_OPTIONS = [
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

export function accountStatusLabel(status: string): string {
  return status === AccountStatus.Active ? '启用' : '停用';
}

export function accountStatusClass(status: string): string {
  return status === AccountStatus.Active ? 'b-good' : 'b-gray';
}

/* -------------------------------------------------------------------------
 * Formatting helpers
 * ---------------------------------------------------------------------- */

export function initialOf(name: string | null | undefined): string {
  if (!name) return '?';
  return name.trim().slice(-2);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
  return `${date} ${time}`;
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
