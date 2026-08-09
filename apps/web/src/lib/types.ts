import {
  AccountRole,
  AccountStatus,
  AttendanceStatus,
  ChurchRole,
  EnrollmentStatus,
  EventType,
  Gender,
  GroupPosition,
  Language,
  MemberStatus,
  PairStatus,
  TrainingKind,
  Weekday,
} from '@tog/shared';

/**
 * The church itself, as `GET /api/church` returns it — the public fields only
 * (that endpoint answers without a session). The name is data, not a
 * translation, so nothing renders a hardcoded church name any more; the theme
 * rides along for the same reason, since the login card and both public forms
 * have to be painted in the church's colours before anyone has signed in.
 */
export interface ChurchProfile {
  name: string;
  short_name: string | null;
  description: string | null;
  logo_url: string | null;
  /** The preset key this pair came from; null = picked by hand (0017). */
  theme_preset: string | null;
  /** The sidebar colour, `#rrggbb`. */
  theme_rail: string;
  /** The brand colour, `#rrggbb`. */
  theme_brand: string;
}

/** One row of `GET /api/church/modules` — an optional module and its state. */
export interface ModuleStateRow {
  key: string;
  enabled: boolean;
}

/** A hall (堂会) — 中文堂 / 英文堂 / 马来文堂. */
export interface HallRow {
  id: string;
  name: string;
  sort_order: number;
}

/**
 * A member row as returned by the API (joins the group and hall names).
 *
 * The two names together are the person (migration 0018): `full_name` is the
 * CHINESE name, `english_name` the English one — nullable, because plenty of
 * people have none. Every list renders both through `<MemberName />`, and the
 * database refuses a second row carrying the same pair.
 */
export interface MemberRow {
  id: string;
  full_name: string;
  english_name: string | null;
  email: string | null;
  phone: string | null;
  /** Free text, as you would write it on an envelope (migration 0021). */
  address: string | null;
  /** 推荐人 — the member who brought them; null = 无推荐人, the ordinary case. */
  referred_by: string | null;
  gender: Gender | null;
  date_of_birth: string | null;
  church_role: ChurchRole;
  status: MemberStatus;
  group_id: string | null;
  group_position: GroupPosition | null;
  hall_id: string;
  /** 来访日期 — display label only; the column and its meaning are unchanged. */
  joined_at: string | null;
  /**
   * 加入小组日期 — when this member joined their CURRENT life group (migration
   * 0023). A separate fact from `joined_at` (when they joined the church):
   * nullable, and excluded from any report built on it, same as `joined_at`.
   */
  group_joined_at: string | null;
  notes: string | null;
  /**
   * 服侍岗位 — the ministries this person serves in (migration 0019). Free text
   * and several per person, the same shape `groups.tags` has, so the UI enters
   * them with the same `TagsInput`. Empty = serves nowhere, which is a fact
   * rather than a missing value; never null (the column defaults to `{}`).
   */
  serving_roles: string[];
  avatar_url: string | null;
  group?: { id: string; name: string } | null;
  hall?: { id: string; name: string } | null;
  /**
   * The person `referred_by` points at, embedded by the API. Null whenever
   * nobody referred them — which is most people — so every reader guards it.
   */
  referrer?: { id: string; full_name: string; english_name: string | null } | null;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  meeting_day: Weekday | null;
  meeting_time: string | null;
  location: string | null;
  tags: string[];
  hall_id: string;
  hall?: { id: string; name: string } | null;
}

export interface GroupDetail extends GroupRow {
  members: {
    id: string;
    full_name: string;
    english_name: string | null;
    group_position: GroupPosition | null;
    status: MemberStatus;
  }[];
}

export interface GroupMeeting {
  id: string;
  meeting_date: string;
}

export interface GroupAttendanceResponse {
  meetings: GroupMeeting[];
  rows: {
    member: { id: string; full_name: string; english_name: string | null };
    cells: { meeting_id: string; status: AttendanceStatus | null }[];
  }[];
}

/* -------------------------------------------------------------------------
 * 聚会点名 — the roll-call sheet (`GET`/`PUT /api/attendance/sheet`)
 *
 * ONE grid per month, whose columns are that month's Sundays
 * (`sunday_attendance`, migration 0013) and the meetings someone added for it
 * (`events` / `event_attendance`), in date order. A Sunday carries the two
 * ticks a Sunday has; a hand-added meeting is one occasion and carries one.
 *
 * Nothing here says which table a column reads: the column's `key` is opaque
 * to the page and the server resolves it (see `lib/sheet.ts`). A cell with no
 * entry was never recorded — that is "nothing happened", not "absent".
 * ---------------------------------------------------------------------- */

/** The ticks a sheet cell can carry: 会前 / 主日 for a Sunday, 到场 for a meeting. */
export type SheetTickName = 'pre_service' | 'service' | 'attended';

/** The hand-added meeting behind a meeting column — enough to edit it. */
export interface SheetMeeting {
  id: string;
  title: string;
  starts_at: string;
  /** Where it meets; null = not said. */
  location: string | null;
  /** null = 全堂开放. */
  hall_id: string | null;
}

export interface SheetColumn {
  /** Opaque to the page; quoted back on a write so the server picks the table. */
  key: string;
  kind: 'sunday' | 'meeting';
  /** `YYYY-MM-DD` in Malaysia. */
  date: string;
  /** The ticks this column carries, in the order they are drawn. */
  ticks: SheetTickName[];
  /** The meeting a `meeting` column stands for; null for a Sunday. */
  meeting: SheetMeeting | null;
}

/** A cell only carries the ticks its column has. */
export type SheetCell = Partial<Record<SheetTickName, boolean>>;

export interface RollCallSheetRow {
  member: {
    id: string;
    full_name: string;
    english_name: string | null;
    church_role: ChurchRole;
    group_position: GroupPosition | null;
  };
  /** Keyed by `SheetColumn.key`; a column with no entry was never recorded. */
  cells: Record<string, SheetCell>;
}

/** `GET /api/attendance/sheet` — one month, one view of the congregations. */
export interface RollCallSheet {
  /** The congregation the sheet is narrowed to; null = 全部堂会 (every member). */
  hall_id: string | null;
  columns: SheetColumn[];
  rows: RollCallSheetRow[];
}

/** A hand-added meeting: a title, a date, a congregation and where to go. */
export interface EventRow {
  id: string;
  title: string;
  event_type: EventType;
  starts_at: string;
  /** Where it meets. Shown on the dashboard beside the date; null = not said. */
  location: string | null;
  /** null = 全堂 / 联合聚会. */
  hall_id: string | null;
  hall?: { id: string; name: string } | null;
}

export interface TrainingRow {
  id: string;
  name: string;
  description: string | null;
  /** 课程 or 活动 — which shape this row is (migration 0014), FIXED at creation (0024). */
  kind: TrainingKind;
  /** 负责人 — free text (0016): the person in charge is often not a member. */
  pic: string | null;
  /** How to reach them; people ring the PIC before signing up. */
  pic_contact: string | null;
  total_sessions: number;
  is_enrollable: boolean;
  starts_on: string | null;
  ends_on: string | null;
  /** An ACTIVITY's start time, "HH:MM:SS" — Malaysia, like every other time. */
  start_time: string | null;
  /** An ACTIVITY's meeting point. A course's places live on its sessions. */
  location: string | null;
  /** null = open to everyone; else restricted to that gender (migration 0024). */
  gender: Gender | null;
  /** 报名费. null / 0 = free, and the payment fields below stay hidden. */
  fee: string | number | null;
  /** How to pay: bank account, TnG number, a note. One field, any method. */
  payment_instructions: string | null;
  /** Public URL of the uploaded payment QR; null = none. */
  payment_qr_url: string | null;
  /** null = 全堂开放. */
  hall_id: string | null;
  hall?: { id: string; name: string } | null;
}

export interface SessionRow {
  id: string;
  training_id: string;
  session_number: number;
  title: string | null;
  scheduled_at: string | null;
  location: string | null;
}

export interface EnrollmentRow {
  id: string;
  training_id: string;
  member_id: string;
  status: EnrollmentStatus;
  progress: number;
  enrolled_at: string;
  completed_at: string | null;
  /**
   * The receipt uploaded with a paid sign-up (0016); null on a free one. The
   * admin opens it from the review row and only then approves — that is what
   * approving a paid sign-up means.
   */
  payment_slip_url: string | null;
  member?: {
    id: string;
    full_name: string;
    english_name: string | null;
    church_role: ChurchRole;
    group_position: GroupPosition | null;
  };
  training?: { id: string; name: string; total_sessions: number };
}

export interface TrainingDetail extends TrainingRow {
  sessions: SessionRow[];
  enrollments: EnrollmentRow[];
}

export interface NamelistResponse {
  sessions: { id: string; session_number: number; title: string | null }[];
  rows: {
    member: {
      id: string;
      full_name: string;
      english_name: string | null;
      church_role: ChurchRole;
      group_position: GroupPosition | null;
    };
    attendance: { session_id: string; session_number: number; attended: boolean }[];
  }[];
}

export interface ProgramRow {
  id: string;
  name: string;
  description: string | null;
  total_days: number;
}

interface MemberBrief {
  id: string;
  full_name: string;
  english_name: string | null;
  church_role: ChurchRole;
  group_position: GroupPosition | null;
}

export interface PairRow {
  id: string;
  program_id: string;
  mentor_id: string;
  trainee_id: string;
  parent_pair_id: string | null;
  status: PairStatus;
  start_date: string | null;
  form_token: string;
  /** Free text, staff's own note about the pair (migration 0024); null = none. */
  remark: string | null;
  mentor?: MemberBrief;
  trainee?: MemberBrief;
}

export interface ProgressRow {
  id: string;
  pair_id: string;
  day_number: number;
  entry_date: string | null;
  /** "HH:MM:SS" (Postgres `time`), alongside entry_date (migration 0024). */
  entry_time: string | null;
  completed: boolean;
  notes: string | null;
}

export interface PairDetail extends PairRow {
  program?: { id: string; name: string; total_days: number };
  progress: ProgressRow[];
}

export interface AccountRow {
  id: string;
  member_id: string;
  email: string;
  account_role: AccountRole;
  /** null = 全堂权限. */
  hall_id: string | null;
  status: AccountStatus;
  language: string;
  last_sign_in_at: string | null;
  member?: {
    id: string;
    full_name: string;
    english_name: string | null;
    email: string | null;
    church_role: ChurchRole;
    group_position: GroupPosition | null;
  };
  hall?: { id: string; name: string } | null;
}

/**
 * The signed-in account's own record — `GET`/`PATCH /auth/me/profile`.
 *
 * Same account columns as `AccountRow`, but carrying the FULL linked member so
 * the profile page can show and edit the member fields inline. The permission
 * role, congregation and status are here to be displayed, never to be sent
 * back: the server refuses them on this path (rule G2).
 */
export interface SelfProfile {
  id: string;
  member_id: string | null;
  email: string;
  account_role: AccountRole;
  /** null = 全堂权限. */
  hall_id: string | null;
  status: AccountStatus;
  language: Language;
  last_sign_in_at: string | null;
  hall?: { id: string; name: string } | null;
  member: MemberRow | null;
}

/* -------------------------------------------------------------------------
 * 幸福小组 (Happiness Groups) — 期 (term) → group → roster + weekly attendance
 *
 * `GET /api/happiness/attendance` on a group is presence-only, by WEEK
 * NUMBER rather than by date (the one roll call in the app that isn't
 * date-based): `records` is the flat list of `{ week_number, member_id }`
 * pairs that exist — a pair present means "was there that week", and there is
 * nothing to read for a week nobody marked. The page builds its own
 * member × week matrix from `weeks` (the term's length) and this list.
 * ---------------------------------------------------------------------- */

/** `GET /api/happiness/terms` — one term, plus how many groups run inside it. */
export interface HappinessTermRow {
  id: string;
  term_no: number;
  name: string | null;
  weeks: number;
  starts_on: string | null;
  ends_on: string | null;
  /** Server-computed (one extra query for the whole list, never N+1) — so the
   *  term list and its delete confirmation both read a real count. */
  group_count: number;
}

export interface HappinessGroupRow {
  id: string;
  term_id: string;
  name: string;
  hall_id: string;
  leader_id: string | null;
  meeting_day: Weekday | null;
  meeting_time: string | null;
  location: string | null;
  hall?: { id: string; name: string } | null;
  leader?: { id: string; full_name: string; english_name: string | null } | null;
  term?: { id: string; term_no: number; name: string | null; weeks: number } | null;
  /** Server-computed roster size, for the group list and its delete confirmation. */
  roster_count: number;
}

export interface HappinessGroupDetail extends HappinessGroupRow {
  members: {
    id: string;
    full_name: string;
    english_name: string | null;
    church_role: ChurchRole;
    group_position: GroupPosition | null;
  }[];
}

/** `GET /api/happiness/groups/:id/attendance` — one group's whole roll call. */
export interface HappinessAttendanceResponse {
  /** The term's own length — every week column the sheet should draw. */
  weeks: number;
  /** Every recorded presence; absence of a pair means "not marked". */
  records: { week_number: number; member_id: string }[];
}

export interface OverviewRow {
  pair_id: string;
  program_id: string;
  total_days: number;
  mentor_id: string;
  mentor_name: string;
  trainee_id: string;
  trainee_name: string;
  status: PairStatus;
  days_completed: number;
  percent_complete: number;
}
