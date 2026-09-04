# Backend Golden Rules — TOG（主恩堂）

> **这些是这个代码库的硬性要求。违反一条是评审 finding，不是偏好之争。finding 里要写出规则编号。**
>
> **金律的编号是全局的，跨这两份文件不重复也不重排。** 评审引用时写 `G2 违规` 即可。
> 拆成 backend / ui 两份是工作室标准的要求（`docs/studio/REPO_STANDARD.md`），
> **编号一律保持原样** —— 仓库里、PR 里、`scripts/ui-e2e.mjs` 的注释里到处都在引用它们，
> 重排会把每一处引用指向错误的规则。
>
> 通用金律 S0–S9 与工作方式 W1–W4 见 `docs/studio/GOLDEN_RULES_BASE.md` ——
> **这里的 G 规则只能在它之上加严，不能放宽。**

> 本文件收 **G0 · G2 · G6 · G6a**（验证纪律、访问控制、性能与正确性、时区）。
> 其余的 **G1 · G3 · G4 · G5 · G7 · G7a · G8 · G9** 在 `ui.md`。
> 由 `architecture-agent` 拥有。

---

### G0 — Nothing is pushed that has not been verified LOCALLY first
CI is not the place to find out whether a change works. The browser suite no
longer runs automatically at all (`ui-e2e.yml` is manual-dispatch only) because
every automatic run downloaded ~300MB of Chromium to re-check what a laptop can
check for free — so the only thing standing between a broken change and the
church's live site is the person pushing it.

Before **every** push, in `apps/web`, run the checks the change can actually
affect, and READ the output rather than glancing at the exit code:

```
npx tsc --noEmit && npm test && npm run build     # always, no exceptions
NODE_USE_ENV_PROXY=1 \
  PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  UI_E2E_PASSWORD=… npm run test:ui-e2e           # any change to a page,
                                                  # a component or route.ts
```

A push that skips the browser suite after touching the UI is the mistake this
rule exists to stop: the last three times it was skipped, CI found a dropped
length cap on an unauthenticated endpoint (which wrote a 500-character row to
the live database), a test still driving a flow the same commit had changed,
and a suite that had been dead at its first check for two days. All three were
reproducible locally in three minutes.

**`test:ui-e2e` drives the DEPLOYED site, not your working tree.** There is no
local server in this workflow, so the browser suite can only ever see what is
live. That splits its job in two, and conflating them wastes a run:

- **Existing behaviour** — run it BEFORE pushing. That is the regression check,
  and the one this rule is really about: your change is about to become the
  deployed build, so anything the suite catches now is something you were about
  to ship.
- **A NEW page or interaction** — the suite cannot see it until it is deployed.
  Write the check with the change, push once `tsc`/`npm test`/`npm run build`
  are green, then run the suite again against the new build and fix forward.
  A run against the old build "passing" your new check is impossible; a run
  that fails only on the new check, before the deploy, means nothing at all.

Run it only when nothing else is (`deploy.yml`'s own API E2E included) — two
runs at once fight over the same live-database fixtures. It restores everything
it touches, including the church's interface language; if it ever reports
residue it did not clean, that is a FAILED run whatever its assertions said.

### G2 — Access control is enforced server-side AND reflected in the UI
Four independent dimensions, all of them enforced in `route.ts` first and
only then reflected in the UI: the account's **role**, its **hall**, whether
the **module** owning the path is enabled for this church, and — for exactly
one role — its **group**.
- **Module enablement (附加模块):** an add-on module (四十天守望 today) can be
  switched off in 教会设置. A request for a path a disabled module owns is
  refused **404** by the gate — including the public mentor form, whose links
  must close with the feature. 404 rather than 403 on purpose: no role and no
  hall can reach it, because for this church the feature does not exist.
  Which paths a module owns comes from `moduleForApiPath` / `moduleForNavHref`
  in `packages/shared` — never re-derive it. The UI's half: the shell hides the
  nav entry (`visibleItems`), a page owned by a disabled module skips its
  fetches and renders `<ModuleDisabled />` instead of an error, and
  `/church*` + `/auth*` + every core path can never be gated.
- **Hall scope (多堂会):** the session carries `hall` (null = 全堂权限). In
  `route.ts`, a hall-scoped account's reads are filtered to its own hall and its
  writes are **forced** onto that hall server-side — never trust a client-sent
  `hall_id`. Nullable-hall entities (培训 / 聚会) additionally expose their
  全堂开放 (`hall_id is null`) rows to every hall. `members`/`groups` always
  carry a hall. A pair (守望配对) has no hall column — its hall is its
  **mentor's** hall (`discipleship_pair_summary.hall_id`).
  **A member's hall and their life group's hall are independent**: a 马来文堂
  member sitting in a 中文堂 小组 is a case this church actually has, and
  nothing server-side has ever refused that pairing. So the life-group picker on
  both member forms and on `/join` lists EVERY group, not the congregation
  currently being viewed — `useFetch(path, { allHalls: true })`, which opts a
  single read out of the **switcher only**. A hall-PINNED account is still
  narrowed server-side, because that is the permission gate rather than a view
  preference, and the session's own hall still always wins.
  New hall-scoped queries must go through the same gate helpers rather than
  re-rolling the check: `hallFilter` (which hall a **list** read is narrowed
  to), `withHall` / `assertHallWritable` / `assertOwnsRow` (writes), and
  `assertRowReadable` / `assertPairInHall` (id-addressed detail reads).
- **Congregation switcher:** a 全堂权限 account narrows its view with the
  switcher, which appends `?hall_id=` to every request (`withHallParam`).
  `hallFilter = hallScope ?? q.get('hall_id')` — the **session's own hall always
  wins**, so a hall-pinned account can never widen its view by sending a
  different `hall_id`; that precedence is the security property. Every
  hall-owned list GET (成员/小组/聚会/培训/守望配对/聚会点名 + 牧养总览) reads
  `hallFilter`, so switching congregation moves the whole app — dashboard KPIs
  included — not just some pages. With no narrowing every one of them answers
  for all congregations, 聚会点名 included: it lists every member, and a tick is
  filed under **that member's own hall**, which is read server-side rather than
  taken from the request.
- **Group scope (`group_leader` only):** the fourth dimension, and a
  deliberate exception rather than an oversight — scoped NARROWER than every
  other role's hall-wide reach, to exactly one group. The session carries
  `group` (null for every role but `group_leader`) straight off
  `app_users.group_id`, mirroring `hall` exactly: a stored column, kept in
  sync by the write path (`syncGroupLeaderAccount`, described below) rather
  than derived per-request. Because a `group_leader`'s reach is a narrow
  allowlist rather than "everyone else's reach minus a hall", it gets its OWN
  early gate in `dispatch()`, in the same place and style as the
  module-enablement gate: a request whose path does not start with `members`,
  `groups`, `attendance` or `auth` is refused outright (403) before anything
  else runs, and an account whose group was deleted from under it
  (`app_users.group_id` is `on delete set null`) is refused too rather than
  silently reading as full access. Inside those four prefixes, `groupFilter =
  groupScope ?? q.get('group_id')` — the exact same precedence `hallFilter`
  already has, so a group-pinned account can never widen its view by sending
  a different `group_id`: `GET /members` and `GET /groups` are forced onto
  its one group, `GET`/`PATCH` by id on either table refuse any id outside
  it, and `GET`/`PUT /attendance/sheet` are forced onto that group's own
  Sunday columns — a congregation meeting is refused even by a hand-crafted
  request naming one directly, never merely absent from what the UI offers.
  `PATCH /members/:id` is nuanced rather than "must already match", because
  moving members into and out of a group is the ordinary shape of managing a
  roster: a `group_leader` may touch a member whose CURRENT group is its own
  or whose write is ADMITTING them into it, and the write's own destination
  (if it names one) must be that same group or null — never anywhere else.
  **How the account itself comes to exist** is `syncGroupLeaderAccount`
  (`api/[...path]/route.ts`), called from every write that can change a
  member's `group_position` — `POST /members`, `PATCH /members/:id`, and the
  member import's insert/update loop. Becoming 小组长
  (`GroupPosition.Leader` specifically — never the assistant/intern seats,
  which this mechanism has no opinion about) auto-provisions an `app_users`
  row (`account_role: 'group_leader'`, the GROUP's own hall and id, `status:
  'active'`) when the member has an email and holds no login yet — a random
  password (`generateRandomPassword` in `lib/server/auth.ts`, Web Crypto,
  visually-unambiguous alphabet) is hashed with the same `hashPassword` every
  other login uses and the PLAINTEXT is returned exactly once, merged onto
  the write's own response as an optional `leader_account_event` field
  (`{event:'created', email, password}`) rather than a new envelope, so every
  existing caller that does not check for it is unaffected — never stored,
  never logged (rule G6). A member who already holds ANY login is left
  completely untouched on promotion (this mechanism only ever manages an
  account it would itself have created); one with no email gets a
  `{event:'skipped_no_email'}` instead of a blocked write. Leaving 小组长 —
  demoted, replaced, or removed from the group entirely — auto-**disables**
  a `group_leader` account it finds (`status: 'disabled'`, `group_id: null`,
  never deleted, so it can be re-enabled later) and reports
  `{event:'disabled', email}`; an account of any OTHER role is never touched
  even if its holder stops being a leader. Staying 小组长 but moving to a
  different group updates the existing account's `group_id`/`hall_id` to
  match (`{event:'moved'}`); staying leader of the SAME group is a no-op
  before any database read. The client's half: `MemberEditModal`, the groups
  roster's own leadership picker, and the add-member form all show a
  `created` credential in a MODAL (never a toast, which would disappear
  before anyone could copy a password off it) via the shared
  `useLeaderAccountEvent` hook (`components/LeaderAccountEvent.tsx`); a
  member import surfaces every credential it generated as a small results
  table, the same one-time-only rule. `AppShell`'s nav hides everything a
  `group_leader` has no reach for (`NavItem.hiddenFor`), and a page reached by
  URL anyway renders `<RoleRestricted />` — the role-boundary analogue of
  `<ModuleDisabled />`, same shape, a stated reason instead of a raw 403.
- **Server (authoritative):** every non-public API path goes through the gate in
  `route.ts`. Writes are denied for `readonly`; account management
  (`/accounts*`, both **read and write**) is `super_admin` only; church
  settings (`/church*`) are readable by any signed-in account but **writable
  only by `super_admin`** — changing the church's name or switching a module
  off affects everyone; `DELETE` is `super_admin`/`admin` only, and so is
  **`POST /members/import`** — one request that creates and overwrites people in
  bulk is held to a delete's bar, not a write's. Sensitive reads (account
  emails/roles) must be role-gated too — never rely on "GET is harmless".
- **Client (UX):** never render an action a user's role cannot perform. Fetch the
  session role (`/api/auth/me`) and hide/disable nav items, buttons, and whole
  pages the role isn't allowed to use. A button that only ever returns 403 is a
  bug. The public exceptions (no session) are the mentor daily form under
  `/api/discipleship/form/*`, the training self-enrollment form under
  `/api/trainings/enroll/*`, **`GET`/`POST /api/members/register`** (the member
  self-registration form) and **`GET`/`POST /api/members/welcome`** (the
  first-visit form, which makes 访客 — 0031) — those two exact paths and those
  two methods each, never a prefix, so nothing else under `/members` is opened
  by them, and which ROLE each creates is a property of the handler rather than
  anything in the body, **`GET
  /api/church`** (the login card and the public forms render the church's name
  before anyone signs in; writes stay super_admin) (+ `/api/auth/*`) — each a
  narrow, specific handler reading an allow-list of fields.

### G6 — Performance & correctness hygiene
- Lazy-load heavy libs on use (SheetJS for exports already does this); never add
  them to the initial bundle or to module top-level.
- API route handlers stay dynamic (`export const dynamic = 'force-dynamic'`) so
  the auth gate always runs and GET responses are never statically cached.
- No blocking work in render; run independent awaits together.
- Guard every list access and optional join (`x?.y ?? fallback`); Supabase
  embedded selects can be null.
- Passwords: PBKDF2 hash server-side only, min 8 chars, never stored/logged in
  plaintext; password fields use `PasswordInput` (show/hide) with the right
  `autoComplete`.

### G6a — Every date and time is Malaysia time
The church is in one place, so a 10:00 service reads 10:00 on every screen.
All date/time work goes through `lib/time.ts` (`churchParts`,
`churchInstant`, `startOfChurchDay`, `addChurchDays`, `churchDayOfWeek`,
`churchDateKey`, `toChurchInput` / `fromChurchInput`, `endOfChurchDate`,
and the calendar-label helpers `weekdayDatesOfMonth` / `sundaysOfMonth` /
`isSundayDate` that both attendance sheets take their columns from — the
roll-call sheet's column list and its ordering are built on them in
`lib/sheet.ts`).
Never call `getHours` / `setHours` / `getFullYear` / `getMonth` / `getDate` /
`getTimezoneOffset` on a `Date` in app code — they read the *runtime's* zone,
which is UTC inside the Worker and the viewer's own zone in the browser, so
the same row rendered two different times. A `datetime-local` value is a bare
wall-clock reading and always means Malaysia. A stored `DATE` covers its whole
Malaysian day — compare against `endOfChurchDate`, not `new Date(dateOnly)`,
or it expires at 08:00 that morning. Unit tests must pass under a non-Malaysia
`TZ` (`TZ=America/New_York npm test`).
