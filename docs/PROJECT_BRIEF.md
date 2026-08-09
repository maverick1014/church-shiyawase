# TOG · Church Management System — Master Brief

> **单一交接文档 / Single hand-off document.**
> Give this file to **Claude (design)** to produce the visual design, then give the
> design + this file to **Claude Code** to build it. Everything needed is here.
>
> Project repo: `maverick1014/tog` · Working branch: `claude/church-management-system-872rok`
> Reference prototype (already built): `docs/prototype.html`
> Full Chinese spec: `docs/需求规格说明书.md`

---

## 0. How to use this document

**Phase 1 — Design (Claude / "Claude Design"):**
Use §2 (Brand), §3 (Identity model), §5 (Modules), §7 (Screens) and §9 (Personas) to
design every screen. Deliver high-fidelity, **all-Chinese** mockups (light + dark,
mobile-first). A working reference prototype already exists at `docs/prototype.html` —
match or improve on its structure and brand. Do **not** change the data model or the
identity rules in §3; design *around* them.

**Phase 2 — Build (Claude Code):**
Implement the approved design against the architecture in §4, the data model in §6, and
the API in §8. The database schema in `supabase/migrations/0001_init.sql` is the source of
truth. UI copy is **multilingual**: every string comes from the dictionaries in
`apps/web/src/lib/i18n/` (English / 简体中文 / Bahasa Melayu), never from a
literal in a component.

---

## 1. Project overview

A web app to manage a church's **people, gatherings, giving, training, and discipleship**,
with a distinctive **40-day one-on-one discipleship (四十天一对一守望)** program.

- **Church:** Tabernacle of Grace (中文名用「恩典会幕」). Tagline: *Discipling the Church to Disciple the World*（门训教会，广传世界）.
- **Users:** pastor (牧师), group leaders (小组长), assistant/intern leaders, admins/co-workers.
- **UI language:** **three languages — English (default), 简体中文, Bahasa
  Melayu** — chosen per login account in 用户管理 and applied across the whole
  interface. Member/group/course names are data and are never translated.
- **Auth:** **None yet** (open app). Design/build must leave room to add Supabase Auth + role-based permissions later.

### Core goals
1. One system for **人 / 聚会 / 奉献 / 培训 / 门训**.
2. Every member's **rank/身份** comes from a single place (the group setup page) — no double maintenance.
3. Every member has a **personal training record** (what they attended + progress).
4. Trainings are **fully customizable** (multiple sessions, a named PIC with a contact, an optional 报名费 with payment instructions and a receipt, opt-in enrollment, admin-checked attendance, printable/checkable namelist).
5. **40-day discipleship** is a **cascade** the pastor can monitor in real time, and the mentor fills a **daily form via a private link** (no login).

---

## 2. Brand & visual identity

Derived from the church logo (a charcoal **globe** wrapped by a **crimson cross-arrow**, red "GRACE" wordmark).

### Palette — the church's two colours, on warm white

**A theme is two colours** and they are **data**, on the `church` row (migration
0017), chosen in 教会设置 → 主题颜色. The default pair is this church's own
(crimson + charcoal), so the table below is what an unthemed deployment looks
like — not a constant.

| Token | Value | Source | Use |
| --- | --- | --- | --- |
| **rail** | `#201d1b` | `church.theme_rail` | the sidebar — the "globe" charcoal |
| **brand** | `#a51f24` | `church.theme_brand` | primary actions, active nav, key data |
| brand-2 | `#80181c` | `color-mix(in srgb, var(--brand) 78%, #000)` | gradients, hover |
| brand-soft | `#f4e4e5` | `color-mix(in srgb, var(--brand) 12%, #fff)` | brand-tinted badges, focus rings |
| accent | `#312f2d` | `color-mix(in srgb, var(--rail) 92%, #fff)` | secondary emphasis on a light surface |
| accent-soft | `#e8e8e8` | `color-mix(in srgb, var(--rail) 10%, #fff)` | accent badges, skeleton tint |
| rail-ink | `#fff` | — | the sidebar's brightest text |
| rail-text / -muted / -faint / -dim | — | `color-mix(in srgb, #fff 88/74/62/50%, var(--rail))` | sidebar body text → section labels |
| paper | `#f6f3f2` | independent | app background |
| surface | `#ffffff` | independent | cards |
| border | `#e7e1df` | independent | hairlines |
| ink | `#232120` | independent | text |
| muted | `#6f6a68` | independent | secondary text |
| semantic good | `#2f8f5b` | independent | present/approved/completed |
| semantic warn | `#c9871f` | independent | pending/excused/needs-follow-up |
| semantic crit | `#d9482f` | independent | absent/dropped (kept distinct from the brand) |

- **Brand mark:** a small globe (circle + meridians) with a subtle cross, crimson on white — echoes the logo.
- Semantic colors and the warm neutrals are **independent of the theme**: "absent/danger" must not
  become the brand colour because a church picked a red one. `ROLE_TAG` (the member-role palette) is
  not themed either.
- Everything that IS a shade of the two chosen colours is `color-mix()`'d from them in `globals.css`,
  so there is one source per colour. The sidebar's foregrounds are mixes of white **towards the
  rail** rather than fixed greys, which is what lets the rail be any dark colour — and the API
  refuses a rail (≥ 8:1 against white) or a brand (≥ 4.5:1) too pale to carry the light text on it.
- **Presets** ship in code (`THEME_PRESETS` in `packages/shared`): charcoal/crimson (the default),
  ink, forest, plum, amber. The chosen pair is stored **alongside** the preset key, so editing a
  preset in a later release cannot restyle a church that picked it.

### Typography (system CJK, no webfonts)
The Artifact/CSP blocks font CDNs and CJK webfonts are too large to inline, so use **system CJK fonts**:
- **Headings (display):** Chinese **serif** stack — `"Songti SC","STSong","Noto Serif CJK SC","SimSun",serif` (reverent, scripture-book feel).
- **Body / UI:** Chinese **sans** — `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif`.
- Use `font-variant-numeric: tabular-nums` for figures.

### Rules
- **Light only** (this was originally specced as light + dark; the app ships light, rule G7). The
  church's theme changes the two colours the light theme is built from — it is not a dark mode, and
  there is no `data-theme` / `prefers-color-scheme` branch anywhere.
- **Mobile-first / fully responsive.** Sidebar collapses into a slide-in drawer (☰) on ≤820px; grids stack; wide tables scroll inside their own container.
- Classic admin shell: charcoal left nav, top bar (title + actions), summary-before-detail content.

---

## 3. Identity / role model (CRITICAL — do not change)

There are **two layers** of identity:

### 3.1 Church-level role (stored on the member)
- `pastor` (牧师) — church leadership; not tied to a group.
- `member` (一般成员) — everyone else; their real rank is derived from their group position.

### 3.2 In-group position (assigned per member in the **group setup page**)
The six ranks below are **NOT** free-standing member attributes. They are assigned to each
member **inside a group**, and that is the single source of truth:

`leader` 小组长 · `assistant_leader` 副组长 · `intern_leader` 实习组长 · `core_member` 核心成员 · `regular_member` 普通成员 · `new_member` 新成员

**Rules (enforce in UI + data):**
1. **Single source:** a member has at most one group and one in-group position. The role shown anywhere = `牧师` if pastor, else the group position, else `未分组`.
2. **One leader per position per group:** each group has at most one 小组长, one 副组长, one 实习组长. Assigning a new one auto-demotes the previous holder to 核心成员.
3. **Must be core first:** only a `核心成员` can be promoted to 小组长/副组长/实习组长. In the UI, leadership options are disabled until the person is 核心成员.
4. **Leadership team is derived** (never stored on the group) — computed from members' `group_position`.

> The member directory's "身份" column is **read-only / derived**. All rank editing happens in the group page.

---

## 4. Tech stack & architecture

| Layer | Tech |
| --- | --- |
| Web frontend | **Next.js** (App Router, React 19), all-Chinese UI |
| Backend API | **NestJS** (REST, prefix `/api`) |
| Database | **Supabase / PostgreSQL** — schema is the source of truth, managed via SQL migrations |
| Repo | **Monorepo** (npm workspaces): `apps/web`, `apps/api`, `packages/shared`, `supabase/` |

- Data access: NestJS uses `@supabase/supabase-js` (service-role, server-side). No end-user auth yet.
- Shared TypeScript types/enums in `packages/shared` keep frontend + backend in sync.
- Currency default (mock): **RM (MYR)** — confirm in §10.

### Repo layout
```
tog/
├── apps/web/        # Next.js (Chinese UI)
├── apps/api/        # NestJS API
├── packages/shared/ # shared types & enums
├── supabase/        # migrations/0001_init.sql (source of truth) + seed.sql
└── docs/            # this brief, the Chinese spec, prototype.html
```

---

## 5. Modules & features

### 5.1 Members directory (成员目录)
- Fields: 姓名(中/英)、邮箱、电话、性别、出生日期、**church_role**(牧师/一般成员)、状态(在册/慕道/停止聚会)、所属小组、加入日期、备注.
- List with **filter by 身份 (derived)** and **by 小组**, search by name.
- Create / edit / delete.
- **Member detail** = profile + **personal training record** (5.5) + discipleship pairs they're in.
- The 身份 shown is **derived** (see §3); it is not edited here.

### 5.2 Groups (小组管理) — listing + detail
- `/groups` lists every group (leader name, group name, member count, **新成员人数**, **小组状态**, meeting day/time/location); click a row → `/groups/[id]`.
- **Filters:** search (name/leader), 标签 (custom tag), 星期几 (meeting day).
- **Custom tags:** each group can carry free-form admin-defined tags (e.g. 年轻人/职青/老年人/晚上/早上) — set on the create/edit form, shown as chips under the group name, filterable from the listing page.
- **小组状态 (derived, never stored):** computed from member counts —
  **可分植** when total > 10 and new-member count ≤ 2; **可加人** when total < 10 and new-member count ≤ old-member count; otherwise **刚好**.
- Detail page: **create / delete** the group, **allocate members** into / out of it.
- **铁三角 (leadership team)**: pick who holds 小组长/副组长/实习组长 directly here (rules 2 & 3 enforced — one holder per slot, auto-demote the incumbent). This is the only identity assignment on this page.
- The member list itself is a simple name + remove list — no per-member position dropdown; 核心成员/普通成员/新成员 are set on the member's own profile page instead.

### 5.3 Services & attendance (崇拜与祷告会 · `/events`)
**Every Sunday simply happens — nobody creates one.** The page is ONE SHEET for
the month: the members down the left, and across the top that month's Sundays
followed, in date order, by every meeting someone added for it.
- **A Sunday column** (`sunday_attendance`, migration 0013) carries the two
  ticks a Sunday has — 会前 (pre-service prayer) and 主日 (the service). A
  Sunday nobody was marked on has no rows at all, which is "not recorded"
  rather than "everyone was absent"; unticking both deletes the row rather than
  storing two falses.
- **A meeting column** (`events` / `event_attendance`) is one hand-added
  occasion — a 31 August night prayer meeting — sorted into place among the
  Sundays with exactly ONE tick (到场). There is no 会前 to invent for it.
  Adding / editing one asks for a name and a date only (plus the congregation,
  forced server-side for a hall-scoped account); its own name in the column
  header is the edit affordance. Deleting it takes its ticks with it
  (`event_attendance` cascades), so it goes through the danger confirmation.
- **One grid, two tables, and the page knows about neither.** Each column
  carries an opaque `key` (`sunday:YYYY-MM-DD` / `meeting:<id>`);
  `PUT /attendance/sheet` quotes it back and the server resolves which table the
  tick lands in (`lib/sheet.ts`). Column ORDER is a pure function of the
  calendar and the meetings, unit-tested under a non-Malaysia `TZ`.
- **Congregations.** Narrowing with the switcher narrows the member list and
  the meeting columns together (a meeting with `hall_id is null` is 全堂开放 and
  shows for everyone). On 全部堂会 the sheet simply lists **every** member — it
  used to refuse with a 400, which is gone. A tick is still filed under the
  member's OWN congregation, so what was recorded never loses its hall, and a
  client-sent `hall_id` is never trusted.
- **循环聚会 is gone** (migration 0015 drops `recurring_events` and
  `events.recurring_id`). It existed only to manufacture rows for dates the
  calendar already knew about; with the sheet supplying its own columns there is
  nothing left for a schedule to pre-create.

### 5.4 Donations (奉献管理)
- Fields: 奉献人(可匿名)、金额、币种、类别(十一/主日/建堂/宣教/感恩…)、方式(现金/转账/刷卡/线上)、日期、备注.
- List with filter by member/fund; create/edit/delete.
- **Summary** by fund + total.

### 5.5 Trainings & Activities (培训&活动) + personal record
- **Two shapes, one catalog** (`kind`, migration 0014): a **course** runs over several sessions; an **activity** (兄弟团爬山, 姐妹团做蛋糕) is ONE occasion people sign up for and get ticked off at. Everything else — sign-ups, the roll call, the public link, the hall rule — is shared, so they are the same record and the same pages. An activity's single occasion is the one `training_sessions` row the API creates with it (it is what the roll call ticks); its **date, time and meeting point** are the record's own `starts_on`/`ends_on`, `start_time` and `location` (0016), and `total_sessions` is forced to 1 server-side.
- **The shape is convertible** (0016). course → activity keeps only the FIRST session and deletes the rest **with their attendance**, behind a `useConfirm({ danger: true })` that names how many sessions and how many ticks go; activity → course simply lets the single session become session 1. The invariant lives in `ensureSingleSession` on the server, so a stale client can never leave a four-session activity behind.
- **Catalog:** name, 说明, **kind**, **pic + pic_contact** (负责人 and a number to ring — free text since 0016, because the person in charge is often an outsider), **total_sessions**, **is_enrollable**, start/end dates, an activity's time + place, and the 报名费 block. 类别 is **gone** (0016): it was a display tag that described none of an activity. The catalog lists both shapes together — no kind filter, since every card carries its own shape badge. On screen the `course` shape is a **培训 / Training**; `kind` keeps the `course` code on the wire.
- **报名费 (0016):** `fee` null/0 = free and nothing below appears. A fee carries `payment_instructions` (free text — bank account, TnG number, a note; ONE column, because a church invents methods nobody modelled) and an optional uploaded `payment_qr_url`. Sign-ups then carry `training_enrollments.payment_slip_url` — the receipt, uploaded **with** the sign-up and opened by the admin **from the review row, beside Approve**, because approving a paid sign-up means somebody checked that the money arrived.
- **Sessions:** a course can have **multiple sessions** (number, title, time, location, notes); an activity shows no session list at all.
- **Enrollment:** member enrolls → `pending`; **admin approves** and tracks status (待审核/已通过/进行中/已完成/已退出). The 报名审核 progress bar shows each enrollee's **real attendance rate** (attended ÷ total sessions from the namelist).
- **Public self-enrollment link (no login):** `/enroll/[id]` — sharable when the course **or activity** is 开放报名; the public payload is an allow-list carrying `kind`, the date/time/place, the PIC and their contact, and the fee block, so an activity reads as "On <date> <time> at <place>" instead of "1 sessions" and a payer can see what to pay and where. On a PAID one the form shows the amount, the instructions and the QR **above a required receipt upload** (image or PDF, 5MB), and the receipt is posted as one multipart request WITH the sign-up — nothing reaches storage until the name has matched exactly one member, so the app's only unauthenticated upload path cannot be used as file storage. A visitor types their **full Chinese name**; the server enrolls them (`pending`) only if it matches **exactly one** existing member. No match / multiple matches → "请联系牧师加入成员系统" (never auto-creates a member, avoiding duplicates). Copy the link from the 培训详情 header (「🔗 报名链接」).
- **Attendance / namelist:** admin marks attended per session; system **generates a checking namelist** (members × sessions grid with ✓).
- **Personal training record:** on each member's detail page — every training they enrolled in + status + progress.

### 5.6 40-day one-on-one discipleship (四十天一对一守望) — flagship
- **Program:** e.g. "四十天一对一守望", total_days = 40.
- **Cascade:** pastor mentors a group leader → that leader mentors the assistant → each trained person mentors the next, until everyone has done it. Lineage tracked by `parent_pair_id`.
- **Pair:** `mentor → trainee` (one-to-one). A mentor may have multiple trainees (multiple pairs). One position per pair.
- **Pastor overview:** all pairs with % complete (days done / 40), status; real-time (DB view `discipleship_pair_summary`).
- **Cascade view:** a visual chain (第1棒 → 第2棒 → …) with each person's progress.
- **Daily form (standalone, private link — IMPORTANT):**
  - Each pair has an unguessable `form_token`. The mentor opens a **dedicated, mobile-first form page** at `/d/<token>` — **no login**.
  - The pastor-overview and the pair page provide **复制链接 / 打开表单** for each pair.
  - Form shows: pair info (带领者 ➜ 被带领者), progress bar, 40-day mini grid, and today's entry: **第几天 / 是否完成 / 反馈备注 / 提交**; then a thank-you state.
  - One `(pair, day_number)` is unique; re-submitting updates (idempotent).

---

## 6. Data model (PostgreSQL — source of truth)

Enums: `church_role(pastor,member)`, `group_position(leader,assistant_leader,intern_leader,core_member,regular_member,new_member)`, `member_status(active,inactive)`, `gender_type`, `event_type`, `attendance_status(present,absent,excused)`, `donation_method`, `enrollment_status(pending,approved,in_progress,completed,dropped)`, `pair_status(active,completed,paused)`.

Tables:
- `church(id, name, short_name, description, logo_url, theme_preset, theme_rail, theme_brand, timestamps)` —
  **one row**, seeded by 0012. The church's identity is data, not a hardcoded string: the sidebar
  brand, the login card and both public forms render from it. `GET /api/church` is **public** (the
  login page has no session) and carries the theme, since those pages are painted in it before
  anyone signs in; every write is super_admin. `logo_url` points at the public `branding` storage
  bucket, uploaded through `POST /api/church/logo` — the same mechanism as a member's avatar.
  The theme columns (0017) are the two colours plus the preset key they came from (null = custom);
  both colours are `check`ed as `^#[0-9a-fA-F]{6}$` in the database as well as in the API, because
  they end up inside a CSS custom property.
- `church_modules(church_id→church on delete cascade, module, enabled, timestamps, pk(church_id,module))` —
  which **optional** modules this church runs. The catalog of what CAN be switched lives in code
  (`OPTIONAL_MODULES` in `packages/shared`: a key, the nav href it owns, the API prefixes it owns);
  only the on/off state lives here, and a key outside the registry is a 400. Today the one entry is
  `discipleship` (四十天守望). A missing row counts as ON.
- `halls(id, name, sort_order, created_at)` — 中文堂 / 英文堂 / 马来文堂. One shared database; a hall is a **scope column**, not a separate deployment.
- `groups(id, name, description, meeting_day weekday, meeting_time, location, tags text[], hall_id→halls **NOT NULL**, created_at)` — **no leader columns** (derived); 小组状态 (可分植/可加人/刚好) is also derived, not stored.
- `households(id, name, address, phone, created_at)` — optional family grouping.
- `members(id, full_name, **english_name**, email, phone, gender, date_of_birth, church_role, status, group_id→groups, group_position, household_id→households, hall_id→halls **NOT NULL**, joined_at, notes, timestamps)` — `full_name` is the CHINESE name; `english_name` (0018, renamed from the mislabelled `chinese_name`) is the English one and may be null.
  - `check (group_position is null or group_id is not null)`
  - **partial unique indexes**: one `leader` / one `assistant_leader` / one `intern_leader` per `group_id`.
  - **`members_name_pair_key` (0018)**: unique on `(lower(btrim(full_name)), lower(btrim(coalesce(english_name,''))))` — the PAIR of names is the identity of a person, compared case- and whitespace-insensitively, with "no English name" counting as a value of its own. A second 张伟 with no English name is refused; the API turns the 23505 into a **409** naming the conflict (`unwrap` in `lib/server/db.ts`).
- `sunday_attendance(id, hall_id→halls **NOT NULL**, service_date date, member_id→members, pre_service, service, updated_at, unique(hall_id,service_date,member_id))` — 主日点名. `check (pre_service or service)` so an all-false row can never be stored (no row already means "not recorded"), and `check (extract(dow from service_date) = 0)` so only Sundays land on the Sunday sheet. Indexed `(hall_id, service_date)` — the sheet is always read as one hall, one month — and `(member_id, service_date desc)` for a member's own history.
- `events(id, title, description, event_type, location, starts_at, ends_at, hall_id→halls **nullable**, created_at)` — the meetings someone adds by hand, each a dated column on the roll-call sheet; `hall_id is null` = 全堂. The old `events_unique_sunday_service` index went with 0013 (nothing manufactures a 主日崇拜 row any more) and `recurring_id` with 0015.
- ~~`recurring_events`~~ — **dropped by 0015**, together with `events.recurring_id`. The schedules only ever pre-created event rows for dates the calendar already had; the roll-call sheet builds its own columns, so nothing needed them.
- `event_attendance(id, event_id, member_id, status, checked_in_at, notes, unique(event_id,member_id))`
- `donations(id, member_id?, amount, currency, fund, method, donated_at, notes, created_at)`
- `trainings(id, name, description, **kind** `course|activity` check, default `course`, **pic**, **pic_contact**, total_sessions, is_enrollable, starts_on, ends_on, **start_time**, **location**, **fee** numeric ≥ 0, **payment_instructions**, **payment_qr_url**, hall_id→halls **nullable**, created_at)` — `hall_id is null` = 全堂开放. `kind` (0014) is the only thing that tells a course from a one-off activity; the catalog of shapes is `TrainingKind` in `packages/shared`. 0016 dropped `category` and replaced `trainer_id→members` with free-text `pic` (+ its contact), copying each linked member's name forward first.
- `training_sessions(id, training_id, session_number, title, scheduled_at, location, notes, unique(training_id,session_number))` — an ACTIVITY's single row is plumbing for the roll call: its `scheduled_at`/`location` stay null, because the occasion's time and place live on the training row.
- `training_enrollments(id, training_id, member_id, status, progress, enrolled_at, completed_at, notes, **payment_slip_url**, unique(training_id,member_id))`
- `training_attendance(id, session_id, member_id, attended, checked_at, notes, unique(session_id,member_id))`
- `discipleship_programs(id, name, description, total_days=40 check ≥ 1, created_at)` — the
  **module** (模块) in the UI. It has no `hall_id`, so no hall gate applies. It is **created
  once and then read**: the app has `GET`/`POST` and `GET /:id` only. There is no edit and no
  delete, on the server or in the UI — a delete here would **cascade** to every pair under it
  (`program_id` is `on delete cascade`) and from there to all their `discipleship_progress`
  rows, and the manager that offered one was a misreading of what the church calls a "module"
  (they meant the add-on switches on `/church`). The create path is kept for exactly one
  case: a church with no module at all, whose 四十天守望 page would otherwise be
  unrecoverable from the UI.
- `discipleship_pairs(id, program_id, mentor_id→members, trainee_id→members, parent_pair_id?, status, start_date, form_token uuid unique, created_at, unique(program_id,trainee_id), check mentor≠trainee)`
- `discipleship_progress(id, pair_id, day_number, entry_date, completed, notes, timestamps, unique(pair_id,day_number))`
- View `discipleship_pair_summary` — per-pair days_completed + percent_complete for the pastor overview.

---

## 7. Screens (all Chinese)

| Route | Screen | Must show / do |
| --- | --- | --- |
| `/` | 仪表盘 Dashboard | KPIs (成员总数/在册/即将聚会/本月奉献/门训进行中), 身份分布图, 奉献趋势, upcoming events, discipleship progress |
| `/members` | 成员目录 | filter chips by 身份(derived) + 小组, search, table, create |
| `/members/[id]` | 成员详情 | profile + **个人培训档案** + 门训对子 |
| `/groups` | 小组管理 · 列表 | table of all groups (小组名称+标签, 组长, 组员人数, 新成员人数, 小组状态, 聚会时间地点), sortable, filter by 标签/星期几, click a row → detail |
| `/groups/[id]` | 小组详情 | create/delete, member allocation (simple list), **铁三角** leader picker (the only identity assignment here), roll-call card for the group's OWN meetings (year/month, then export at the end of its toolbar; each week column has a check-all in its header) |
| `/events` | 崇拜与祷告会 Services | ONE 聚会点名 sheet: members × (the month's Sundays with 会前 / 主日 ticks + each hand-added meeting as a dated 到场 column), a check-all per sub-column, per-tick totals, export; ＋新增聚会, edit/delete from a meeting's column header |
| `/donations` | 奉献管理 | fund summary tiles + records table + create |
| `/trainings` | 培训&活动 | catalog cards for both shapes, no filter, ＋新增培训 / ＋新增活动 |
| `/trainings/[id]` | 培训 / 活动详情 | a course: sessions, enrolment approval, **核对名单** grid, per-session attendance. An activity: no session list, one 「到场」 column |
| `/discipleship` | 四十天守望 | cascade chain, **牧者总览** (per-pair progress + 复制链接/打开表单), a pair's 40-day grid |
| `/discipleship/pairs/[id]` | 对子进度 | 40-day grid + cascade lineage (pastor view) |
| `/d/[token]` | 每日填写页（独立） | **standalone, mobile-first, no login** mentor daily form |
| `/enroll/[id]` | 报名页（独立） | **standalone, mobile-first, no login** self-enrollment for a course or an activity — matches full Chinese name to a member |
| `/settings` | 用户管理 | login accounts (super_admin only) |
| `/church` | 教会设置 | the church record (name / short name / description / logo), its **theme colours** (a preset or a custom pair) + the **add-on module catalog** — super_admin only |

---

## 8. API (REST, prefix `/api`)

| Area | Endpoints |
| --- | --- |
| Members | `GET/POST /members`, `GET/PATCH/DELETE /members/:id`, `GET /members/:id/trainings` (filters: `church_role`, `group_position`, `group_id`, `q`) |
| Halls | `GET /halls` — 堂会 list (read-only; a hall-scoped account only sees its own) |
| Groups | `GET/POST /groups`, `GET/PATCH/DELETE /groups/:id` (member positions live on `members`), `GET /groups/:id/attendance`, `POST /groups/:id/meetings`, `DELETE /groups/meetings/:meetingId`, `POST /groups/meetings/:meetingId/attendance` `{records[{member_id,status}]}` — one tick or a whole column in the same call; a group meeting's hall is its **group's** hall, checked server-side |
| Households | `GET/POST /households`, `GET/PATCH/DELETE /households/:id` |
| 聚会点名 | `GET /attendance/sheet?year&month[&hall_id]` → `{hall_id, columns[{key, kind, date, ticks[], meeting}], rows[{member, cells{key:{…ticks}}}]}` — no `hall_id` means every congregation's members; `PUT /attendance/sheet` `{column, member_ids[], …ticks}` → `{column, member_ids[], count, …ticks}` — the cells of **one or many** members in one call (`member_id` is the singular alias), created / updated / **deleted** (every tick false) by the same call, in `sunday_attendance` or `event_attendance` depending on the column. A list is the general shape so the column check-all cannot drift from a single tick: same gate, same hall rule (each row filed under **that member's own** hall), same delete-instead-of-false. 400 on a non-Sunday `sunday:` column, a column key the server never handed out, an empty list, or an id that is not a member (refused whole — never half-applied) |
| Events | `GET/POST /events`, `GET/PATCH/DELETE /events/:id` — the hand-added meetings; their attendance is a column on the sheet above |
| Donations | `GET/POST /donations`, `GET /donations/summary`, `PATCH/DELETE /donations/:id` |
| Trainings & Activities | `GET/POST /trainings`, `GET/PATCH/DELETE /trainings/:id`, `GET /trainings/:id/namelist`, `POST /trainings/:id/payment-qr` (image upload), **public** `GET/POST /trainings/enroll/:id` (JSON, or multipart when a receipt rides along). `kind` is validated server-side (400 on anything but `course`/`activity`); creating **or converting to** an `activity` forces `total_sessions: 1`, `ends_on = starts_on` and exactly one session; `fee` must be a number ≥ 0; a paid sign-up with no receipt is a 400 in words |
| Sessions | `POST /trainings/:id/sessions`, `PATCH/DELETE /trainings/sessions/:sessionId`, `POST /trainings/sessions/:sessionId/attendance` |
| Enrollment | `POST /trainings/:id/enroll`, `PATCH/DELETE /trainings/enrollments/:enrollmentId` |
| Discipleship | `GET/POST /discipleship/programs`, **`GET` only** on `/discipleship/programs/:id` (the module — no hall column, so no hall gate; PATCH and DELETE were removed with the module manager and now 404), `GET /discipleship/programs/:id/overview`, `GET/POST /discipleship/pairs`, `GET/PATCH/DELETE /discipleship/pairs/:id`, `POST /discipleship/pairs/:id/progress` |
| **Private form** | `GET /discipleship/form/:token`, `POST /discipleship/form/:token/progress` (no login) |

---

## 9. Personas / seed data (for realistic mockups)

Church: 恩典会幕. Pastor: **陈约翰 (牧师)**.
Groups: **恩典小组** (周六 15:00), **青年小组** (周五 20:00), **迦南小组** (周日 14:00).

| Name | Group | In-group position |
| --- | --- | --- |
| 陈约翰 | — | 牧师 (church-level) |
| 林玛丽 | 恩典小组 | 小组长 |
| 黄彼得 | 恩典小组 | 副组长 |
| 陈路得 | 恩典小组 | 核心成员 |
| 吴恩慈 | 青年小组 | 实习组长 |
| 王但以理 | 青年小组 | 核心成员 |
| 李撒母耳 | 青年小组 | 新成员 |
| 刘信实 | 迦南小组 | 小组长 |
| 张恩典 | 迦南小组 | 普通成员 |
| 郑喜乐 | 迦南小组 | 新成员 (慕道) |

Discipleship cascade (program 四十天一对一守望): 陈约翰→林玛丽 (31/40) → 林玛丽→黄彼得 (22/40) → 黄彼得→吴恩慈 (12/40) → 吴恩慈→王但以理 (5/40) → 王但以理→陈路得 (0/40).
Sample training: **门徒训练 101** (负责人 陈约翰 · 012-345 6789, 3 场次: 得救确据 / 祷告 / 读经), enrollments with mixed statuses; **事奉训练营** carries a RM 80 报名费 with bank/TnG instructions.
Donations: 十一奉献/主日奉献/建堂/宣教, methods 现金/转账/线上; monthly total ~ RM 8,650.

---

## 10. Open questions & current defaults

| # | Question | Current default (change if needed) |
| --- | --- | --- |
| 1 | Currency | **RM (MYR)** |
| 2 | Households module needed? | Modeled but optional; can hide in v1 |
| 3 | ~~Training categories preset~~ | **Removed (0016)** — the tag described none of an activity and nobody filtered on it |
| 4 | Donation fund presets | 十一奉献 / 主日奉献 / 建堂 / 宣教 / 感恩 |
| 5 | Mentor can have multiple trainees? | **Yes** (multiple pairs) |
| 6 | Auth now? | **No** — add Supabase Auth + role permissions later |
| 7 | Traditional Chinese / English toggle? | **Done** — English / 简体中文 / Bahasa Melayu, per account, English by default |
| 8 | Discipleship link: expiry / reset? | Long-lived; token resettable — **confirm** |
| 9 | Daily form: view/back-fill past days? | Prototype allows "再填一天"; confirm history/back-fill |

---

## 11. What already exists (starting point)

- `docs/prototype.html` — self-contained, clickable, **all-Chinese**, brand-correct, mobile-responsive prototype covering all screens above (incl. group allocation, namelist, cascade, 40-day grid, and the standalone `#/form/<pair>` daily form). **Use as the design reference.**
- `docs/需求规格说明书.md` — full Chinese requirements spec.
- `supabase/migrations/0001_init.sql` + `supabase/seed.sql` — schema (source of truth) + demo data.
- `apps/api` (NestJS) + `apps/web` (Next.js foundation) + `packages/shared` — scaffold consistent with the model above. Web UI still needs full build-out and Chinese localization.

---

## 12. Deliverables

**Design phase (Claude):** high-fidelity, all-Chinese mockups for every screen in §7, light + dark, mobile + desktop, using §2 brand and §3 rules. Keep the model in §3/§6 intact.

**Build phase (Claude Code):** implement the approved design in `apps/web` (Next.js, Chinese UI) against `apps/api` (NestJS) and the Supabase schema; wire the private discipleship form (`/d/[token]`); keep `packages/shared` types in sync; ensure responsive + dark mode. No auth in v1.
