import {
  AccountRole,
  AccountStatus,
  AttendanceStatus,
  ChurchRole,
  EnrollmentStatus,
  EventType,
  Gender,
  GroupPosition,
  MemberStatus,
  PairStatus,
  Weekday,
} from '@tog/shared';

/** A hall (堂会) — 中文堂 / 英文堂 / 马来文堂. */
export interface HallRow {
  id: string;
  name: string;
  sort_order: number;
}

/** A member row as returned by the API (joins group + household names). */
export interface MemberRow {
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
  avatar_url: string | null;
  group?: { id: string; name: string } | null;
  household?: { id: string; name: string } | null;
  hall?: { id: string; name: string } | null;
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
    group_position: GroupPosition | null;
    status: MemberStatus;
  }[];
}

export interface GroupMeeting {
  id: string;
  meeting_date: string;
  note: string | null;
}

export interface GroupAttendanceResponse {
  meetings: GroupMeeting[];
  rows: {
    member: { id: string; full_name: string };
    cells: { meeting_id: string; status: AttendanceStatus | null }[];
  }[];
}

export interface EventRow {
  id: string;
  title: string;
  description: string | null;
  event_type: EventType;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  /** null = 全堂 / 联合聚会. */
  hall_id: string | null;
  hall?: { id: string; name: string } | null;
}

export interface EventDetail extends EventRow {
  attendance: {
    id: string;
    member_id: string;
    status: AttendanceStatus;
    member?: { id: string; full_name: string };
  }[];
}

export interface TrainingRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  trainer_id: string | null;
  total_sessions: number;
  is_enrollable: boolean;
  starts_on: string | null;
  ends_on: string | null;
  /** null = 全堂开放. */
  hall_id: string | null;
  trainer?: { id: string; full_name: string } | null;
  hall?: { id: string; name: string } | null;
}

export interface SessionRow {
  id: string;
  training_id: string;
  session_number: number;
  title: string | null;
  scheduled_at: string | null;
  location: string | null;
  notes: string | null;
}

export interface EnrollmentRow {
  id: string;
  training_id: string;
  member_id: string;
  status: EnrollmentStatus;
  progress: number;
  enrolled_at: string;
  completed_at: string | null;
  member?: {
    id: string;
    full_name: string;
    church_role: ChurchRole;
    group_position: GroupPosition | null;
  };
  training?: { id: string; name: string; category: string | null; total_sessions: number };
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
  mentor?: MemberBrief;
  trainee?: MemberBrief;
}

export interface ProgressRow {
  id: string;
  pair_id: string;
  day_number: number;
  entry_date: string | null;
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
  two_factor: boolean;
  language: string;
  notify_discipleship: boolean;
  notify_donation: boolean;
  notify_weekly: boolean;
  last_sign_in_at: string | null;
  member?: {
    id: string;
    full_name: string;
    email: string | null;
    church_role: ChurchRole;
    group_position: GroupPosition | null;
  };
  hall?: { id: string; name: string } | null;
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
