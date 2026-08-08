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
4. Trainings are **fully customizable** (multiple sessions, a trainer, opt-in enrollment, admin-checked attendance, printable/checkable namelist).
5. **40-day discipleship** is a **cascade** the pastor can monitor in real time, and the mentor fills a **daily form via a private link** (no login).

---

## 2. Brand & visual identity

Derived from the church logo (a charcoal **globe** wrapped by a **crimson cross-arrow**, red "GRACE" wordmark).

### Palette (crimson + charcoal on warm white)
| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| brand (crimson) | `#a51f24` | `#d94a4f` | primary actions, active nav, key data |
| brand-2 | `#7f171b` | `#c23c41` | gradients, hover |
| brand-soft | `#f6e3e3` | `#3a2422` | brand-tinted badges |
| accent (charcoal) | `#33302f` | `#cbc6c3` | secondary emphasis, data endpoints |
| rail (sidebar) | `#201d1b` | `#100e0d` | sidebar = the "globe" charcoal |
| paper | `#f6f3f2` | `#141211` | app background |
| surface | `#ffffff` | `#1c1917` | cards |
| border | `#e7e1df` | `#322d2b` | hairlines |
| ink | `#232120` | `#ece7e5` | text |
| muted | `#6f6a68` | `#a29b97` | secondary text |
| semantic good | `#2f8f5b` | `#4bab74` | present/approved/completed |
| semantic warn | `#c9871f` | `#d8a441` | pending/excused/needs-follow-up |
| semantic crit | `#d9482f` | `#e86b52` | absent/dropped (kept distinct from brand crimson) |

- **Brand mark:** a small globe (circle + meridians) with a subtle cross, crimson on white — echoes the logo.
- Semantic colors are **separate** from the brand crimson so "absent/danger" never reads as "brand".

### Typography (system CJK, no webfonts)
The Artifact/CSP blocks font CDNs and CJK webfonts are too large to inline, so use **system CJK fonts**:
- **Headings (display):** Chinese **serif** stack — `"Songti SC","STSong","Noto Serif CJK SC","SimSun",serif` (reverent, scripture-book feel).
- **Body / UI:** Chinese **sans** — `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif`.
- Use `font-variant-numeric: tabular-nums` for figures.

### Rules
- **Light + dark themes**, both first-class (token-driven; a theme toggle stamps `data-theme`).
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
**Every Sunday simply happens — nobody creates one.** The page is a SHEET
(`sunday_attendance`, migration 0013): the congregation's members down the
left, the Sundays of the chosen month across the top, and **two ticks per
Sunday** — 会前 (pre-service prayer) and 主日 (the service). A Sunday nobody was
marked on has no rows at all, which is "not recorded" rather than "everyone was
absent"; unticking both boxes deletes the row rather than storing two falses.
- **One congregation per sheet.** Each hall rolls its own call, including on a
  week the halls meet together — there is no 联合聚会 concept any more, only the
  same date on three sheets with three member lists. On 全部堂会 the page asks
  for a congregation and `GET /attendance/sundays` answers **400** rather than
  merging them. `hall_id` on the row records where the person was counted *that*
  Sunday, so moving them between halls later never rewrites what was taken.
- **Hand-added meetings stay** (`events`): the occasional Wednesday prayer
  meeting. A name, a date and a congregation is all it takes — no type, no
  location, no recurrence — and each keeps its own 出席 / 请假 / 缺席 roll call.
- **循环聚会 (`/events/recurring`)**: schedules for a recurring weeknight
  meeting. Each rule sets 名称/类型/星期/时间/地点/堂会/提前天数 (default 35 ≈ one
  month) and can be paused. `GET /events` fills the window from the active
  rules — generation is **lazy, not a cron job**: the calendar only has to be
  right for whoever is looking at it, and there's no scheduled task to fail
  silently. Forward-only and idempotent, so a meeting deliberately deleted
  (public holiday) is not resurrected. **Deleting a rule keeps its
  already-generated events** (they carry attendance records).
  **Sunday rules are no longer generated**: the sheet holds that attendance, so
  manufacturing a 主日崇拜 row only invented a date the calendar already knew
  about. The weekday dropdown no longer offers Sunday and the generator skips
  any rule left over from before (its past occurrences stay readable).

### 5.4 Donations (奉献管理)
- Fields: 奉献人(可匿名)、金额、币种、类别(十一/主日/建堂/宣教/感恩…)、方式(现金/转账/刷卡/线上)、日期、备注.
- List with filter by member/fund; create/edit/delete.
- **Summary** by fund + total.

### 5.5 Trainings (培训课程) + personal record
- **Catalog:** name, 说明, 类别, **trainer**(讲师), **total_sessions**, **is_enrollable**, start/end dates.
- **Sessions:** a training can have **multiple sessions** (number, title, time, location, notes).
- **Enrollment:** member enrolls → `pending`; **admin approves** and tracks status (待审核/已通过/进行中/已完成/已退出). The 报名审核 progress bar shows each enrollee's **real attendance rate** (attended ÷ total sessions from the namelist).
- **Public self-enrollment link (no login):** `/enroll/[id]` — sharable when the course is 开放报名. A visitor types their **full Chinese name**; the server enrolls them (`pending`) only if it matches **exactly one** existing member. No match / multiple matches → "请联系牧师加入成员系统" (never auto-creates a member, avoiding duplicates). Copy the link from the 培训详情 header (「🔗 报名链接」).
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
- `church(id, name, short_name, description, logo_url, timestamps)` — **one row**, seeded by 0012. The
  church's identity is data, not a hardcoded string: the sidebar brand, the login card and both
  public forms render from it. `GET /api/church` is **public** (the login page has no session);
  every write is super_admin. `logo_url` points at the public `branding` storage bucket, uploaded
  through `POST /api/church/logo` — the same mechanism as a member's avatar.
- `church_modules(church_id→church on delete cascade, module, enabled, timestamps, pk(church_id,module))` —
  which **optional** modules this church runs. The catalog of what CAN be switched lives in code
  (`OPTIONAL_MODULES` in `packages/shared`: a key, the nav href it owns, the API prefixes it owns);
  only the on/off state lives here, and a key outside the registry is a 400. Today the one entry is
  `discipleship` (四十天守望). A missing row counts as ON.
- `halls(id, name, sort_order, created_at)` — 中文堂 / 英文堂 / 马来文堂. One shared database; a hall is a **scope column**, not a separate deployment.
- `groups(id, name, description, meeting_day weekday, meeting_time, location, tags text[], hall_id→halls **NOT NULL**, created_at)` — **no leader columns** (derived); 小组状态 (可分植/可加人/刚好) is also derived, not stored.
- `households(id, name, address, phone, created_at)` — optional family grouping.
- `members(id, full_name, chinese_name, email, phone, gender, date_of_birth, church_role, status, group_id→groups, group_position, household_id→households, hall_id→halls **NOT NULL**, joined_at, notes, timestamps)`
  - `check (group_position is null or group_id is not null)`
  - **partial unique indexes**: one `leader` / one `assistant_leader` / one `intern_leader` per `group_id`.
- `sunday_attendance(id, hall_id→halls **NOT NULL**, service_date date, member_id→members, pre_service, service, updated_at, unique(hall_id,service_date,member_id))` — 主日点名. `check (pre_service or service)` so an all-false row can never be stored (no row already means "not recorded"), and `check (extract(dow from service_date) = 0)` so only Sundays land on the Sunday sheet. Indexed `(hall_id, service_date)` — the sheet is always read as one hall, one month — and `(member_id, service_date desc)` for a member's own history.
- `events(id, title, description, event_type, location, starts_at, ends_at, hall_id→halls **nullable**, recurring_id→recurring_events **nullable, on delete set null**, created_at)` — the meetings someone adds by hand; `hall_id is null` = 全堂. The old `events_unique_sunday_service` index is dropped by 0013: nothing manufactures a 主日崇拜 row any more. `(recurring_id, starts_at)` still keeps the weeknight top-up idempotent.
- `recurring_events(id, title, event_type, weekday, start_time, location, hall_id→halls nullable, lookahead_days default 35, active, created_at)` — 循环聚会 schedules. `GET /events` tops the calendar up from the active rules (lazy, no cron). Deleting a rule **keeps** the events it produced (FK is `on delete set null`); it only stops future generation.
- `event_attendance(id, event_id, member_id, status, checked_in_at, notes, unique(event_id,member_id))`
- `donations(id, member_id?, amount, currency, fund, method, donated_at, notes, created_at)`
- `trainings(id, name, description, category, trainer_id→members, total_sessions, is_enrollable, starts_on, ends_on, hall_id→halls **nullable**, created_at)` — `hall_id is null` = 全堂开放.
- `training_sessions(id, training_id, session_number, title, scheduled_at, location, notes, unique(training_id,session_number))`
- `training_enrollments(id, training_id, member_id, status, progress, enrolled_at, completed_at, notes, unique(training_id,member_id))`
- `training_attendance(id, session_id, member_id, attended, checked_at, notes, unique(session_id,member_id))`
- `discipleship_programs(id, name, description, total_days=40 check ≥ 1, created_at)` — the
  **module** (模块) in the UI; managed from `/discipleship`. It has no `hall_id`, so no hall
  gate applies. Deleting one **cascades** to every pair under it (`program_id` is
  `on delete cascade`) and from there to all their `discipleship_progress` rows, which is why
  the UI's confirmation states the pair count before it calls `DELETE`.
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
| `/groups/[id]` | 小组详情 | create/delete, member allocation (simple list), **铁三角** leader picker (the only identity assignment here) |
| `/events` | 崇拜与祷告会 Services | 主日点名 sheet (members × the month's Sundays, 会前 / 主日 ticks, per-member totals, export) + the month's hand-added meetings with their own **点名** (出席/请假/缺席) |
| `/events/recurring` | 循环聚会 | recurring weeknight schedules (每周X HH:MM) that auto-fill the calendar; pause/edit/delete. Sunday is not scheduled here — it is the sheet |
| `/donations` | 奉献管理 | fund summary tiles + records table + create |
| `/trainings` | 培训课程 | catalog cards + create |
| `/trainings/[id]` | 培训详情 | sessions, enrollment approval, **核对名单** grid, per-session attendance |
| `/discipleship` | 四十天守望 | cascade chain, **牧者总览** (per-pair progress + 复制链接/打开表单), a pair's 40-day grid |
| `/discipleship/pairs/[id]` | 对子进度 | 40-day grid + cascade lineage (pastor view) |
| `/d/[token]` | 每日填写页（独立） | **standalone, mobile-first, no login** mentor daily form |
| `/enroll/[id]` | 培训报名页（独立） | **standalone, mobile-first, no login** self-enrollment — matches full Chinese name to a member |
| `/settings` | 用户管理 | login accounts (super_admin only) |
| `/church` | 教会设置 | the church record (name / short name / description / logo) + the **add-on module catalog** — super_admin only |

---

## 8. API (REST, prefix `/api`)

| Area | Endpoints |
| --- | --- |
| Members | `GET/POST /members`, `GET/PATCH/DELETE /members/:id`, `GET /members/:id/trainings` (filters: `church_role`, `group_position`, `group_id`, `q`) |
| Halls | `GET /halls` — 堂会 list (read-only; a hall-scoped account only sees its own) |
| Groups | `GET/POST /groups`, `GET/PATCH/DELETE /groups/:id` (member positions live on `members`) |
| Households | `GET/POST /households`, `GET/PATCH/DELETE /households/:id` |
| 主日点名 | `GET /attendance/sundays?hall_id&year&month` → `{hall_id, dates[], rows[{member, cells{date:{pre_service,service}}}]}`; `PUT /attendance/sundays` `{hall_id, service_date, member_id, pre_service, service}` — one cell, created / updated / **deleted** (both false) by the same call. 400 on a non-Sunday date and on an unnarrowed (all-congregations) read |
| Events | `GET/POST /events`, `GET/PATCH/DELETE /events/:id`, `POST /events/:id/attendance` — the hand-added meetings only |
| Donations | `GET/POST /donations`, `GET /donations/summary`, `PATCH/DELETE /donations/:id` |
| Trainings | `GET/POST /trainings`, `GET/PATCH/DELETE /trainings/:id`, `GET /trainings/:id/namelist`, **public** `GET/POST /trainings/enroll/:id` |
| Sessions | `POST /trainings/:id/sessions`, `PATCH/DELETE /trainings/sessions/:sessionId`, `POST /trainings/sessions/:sessionId/attendance` |
| Enrollment | `POST /trainings/:id/enroll`, `PATCH/DELETE /trainings/enrollments/:enrollmentId` |
| Discipleship | `GET/POST /discipleship/programs`, `GET/PATCH/DELETE /discipleship/programs/:id` (the module — no hall column, so no hall gate), `GET /discipleship/programs/:id/overview`, `GET/POST /discipleship/pairs`, `GET/PATCH/DELETE /discipleship/pairs/:id`, `POST /discipleship/pairs/:id/progress` |
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
Sample training: **门徒训练 101** (讲师 陈约翰, 3 场次: 得救确据 / 祷告 / 读经), enrollments with mixed statuses.
Donations: 十一奉献/主日奉献/建堂/宣教, methods 现金/转账/线上; monthly total ~ RM 8,650.

---

## 10. Open questions & current defaults

| # | Question | Current default (change if needed) |
| --- | --- | --- |
| 1 | Currency | **RM (MYR)** |
| 2 | Households module needed? | Modeled but optional; can hide in v1 |
| 3 | Training categories preset | 门徒 / 栽培 / 事奉 (free text otherwise) |
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
