# TOG（主恩堂）Codebase Guide & Golden Rules

Church-management app. Next.js 15 (App Router, React 19) + Supabase, deployed to
Cloudflare Workers via OpenNext. The UI ships in three languages (English /
简体中文 / Bahasa Melayu, chosen per login account, English by default); light
theme only; mobile-first. The API is a single catch-all route handler at
`apps/web/src/app/api/[...path]/route.ts`; auth is a signed HMAC cookie
(`lib/server/auth.ts`).

Run before every push: `npm run --workspace @tog/web -s build` (or in
`apps/web`: `npx tsc --noEmit && npm test && npm run build`). Deploys are gated
on unit tests + a post-deploy smoke test (`.github/workflows/deploy.yml`).

Testing layers (in `apps/web`):
- `npm test` — Vitest unit tests (labels, rules, perms, i18n dictionaries).
- `npm run test:api-e2e` — API end-to-end against the live Worker (auth, role
  matrix, full CRUD, public form).
- `npm run test:ui-e2e` — **browser UI end-to-end**: drives the real site in
  Chromium and asserts each interaction's expected outcome (login, search,
  filters, modals, weekly attendance, discipleship day-notes, an
  interface-language round-trip, a create→delete member write-cycle). It
  restores anything it changes. It runs a tiny in-process reverse proxy so the browser
  works even behind an egress proxy. `UI_E2E_PASSWORD` is required (never
  hardcode a real password); `UI_E2E_URL` / `UI_E2E_EMAIL` are optional. In this
  sandbox run it as:
  `NODE_USE_ENV_PROXY=1 PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome UI_E2E_PASSWORD=… npm run test:ui-e2e`.
  When you add/rename a page or a key interaction, add a matching check to
  `scripts/ui-e2e.mjs`.
  **This script is only valid against the build it was checked out from.** The
  site has one shared URL, and `deploy.yml` only ever runs on feature branches,
  so an old script pointed at a newer deploy reports moved selectors as
  "failures". CI therefore pins the checkout to the deployed SHA
  (`ref: github.event.workflow_run.head_sha`) and passes
  `UI_E2E_EXPECT_BUILD`; the script waits for `/api/version` to report that
  build and **skips with exit 0** if a newer deploy overtook it. Never "fix" a
  red automatic run by loosening a selector before checking which build it
  actually tested.
- `npm run ui:shots` — **screenshot sweep**: captures every list page at a phone
  and a desktop viewport into `$OUT` (default `/tmp/shots`; `WIDE=1` for
  desktop). ui-e2e proves the pages *work*; it cannot see that two pages lay
  their header out differently. After any layout change, run this and **look at
  the images** — a green ui-e2e is not evidence the UI is consistent.

---

## GOLDEN RULES — every auditor / code reviewer MUST check these

These are hard requirements for this codebase. A change that breaks one is a
review finding, not a preference. Cite the rule number in the finding.

### G1 — CRUD completeness on every management page
Every entity page (成员、小组、聚会、培训、四十天守望配对、账户) must offer the
full set its users need: **Create, Read, Update, Delete**. If the API supports an
operation, the UI must expose it (or the omission must be a deliberate,
documented decision). A page that can only create + list is incomplete.

### G2 — Access control is enforced server-side AND reflected in the UI
- **Hall scope (多堂会):** the session carries `hall` (null = 全堂权限). In
  `route.ts`, a hall-scoped account's reads are filtered to its own hall and its
  writes are **forced** onto that hall server-side — never trust a client-sent
  `hall_id`. Nullable-hall entities (培训 / 聚会) additionally expose their
  全堂开放 (`hall_id is null`) rows to every hall. `members`/`groups` always
  carry a hall. New hall-scoped queries must go through the same gate helpers
  (`withHall` / `assertHallWritable` / `assertOwnsRow`) rather than re-rolling
  the check.
- **Server (authoritative):** every non-public API path goes through the gate in
  `route.ts`. Writes are denied for `readonly`; account management
  (`/accounts*`, both **read and write**) is `super_admin` only; `DELETE` is
  `super_admin`/`admin` only. Sensitive reads (account emails/roles) must be
  role-gated too — never rely on "GET is harmless".
- **Client (UX):** never render an action a user's role cannot perform. Fetch the
  session role (`/api/auth/me`) and hide/disable nav items, buttons, and whole
  pages the role isn't allowed to use. A button that only ever returns 403 is a
  bug. The public exceptions (no session) are the mentor daily form under
  `/api/discipleship/form/*`, the training self-enrollment form under
  `/api/trainings/enroll/*` (+ `/api/auth/*`) — each a narrow, specific handler.

### G3 — Every destructive action shows a confirmation
Any delete/remove/detach/irreversible action (`api.delete(...)`, or a mutation
like 移除/清空/重置 that discards data) MUST go through the shared
`useConfirm()` dialog (`components/ui.tsx`) with `danger: true`. Native
`window.confirm` is not allowed. No silent destructive taps.

### G4 — One mechanism, not per-page reimplementations (altitude)
Reuse the shared primitives instead of re-rolling them per page:
`Modal`, `Field`, `PasswordInput`, `useConfirm`, `useToast`, `RoleBadge`,
`Avatar`, `PairProgressModal`, `exportRows`/`exportMatrix` (`lib/export.ts`),
`api` (`lib/api.ts`), and the label/style helpers in `lib/labels.ts`
(`roleTagStyle`, `roleDot`, `memberRoleZh`, `positionZh`, status/category
classes). New code that duplicates one of these is a finding — name the helper
to call instead. Colours come from CSS tokens / `ROLE_TAG`, never hard-coded hex
in components.

### G5 — Data fetch/derive once; simplify state
Don't map the same collection twice (e.g. desktop table + mobile tiles) with the
logic duplicated — compute the row model once and feed both, or use one
presentational component. Don't keep state you can derive from props/fetch.
Prefer `useFetch` + `useMemo` over manual effect/loading bookkeeping.

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

### G7a — One page-chrome shape for every page
The header is **title only** (no subtitles). Every list page's top row is one
shared `<PageBar filters actions />`: the page's filters on the left, **all of
its buttons in the right corner**, collapsing to a stacked filters-then-actions
column below 640px. A page never renders a second bar, never puts a `<select>`
in the actions half, and never gives an action an ad-hoc width — page actions
are content-sized like every other control. Filter order inside the bar is
search → dropdowns → export/info.

Shell-level controls (the congregation switcher) belong to the shell, not to a
page: top right of the header on desktop, in the nav drawer above 首页 on
phones. They use the same `--control-h` as every other control — no `sm`
variant, no inline width.
List tables size their columns to their own content (`table-layout: auto` +
`white-space: nowrap` on cells). Never hand-type a column width: one tuned to
two CJK glyphs clips the moment the same label is English.

### G6a — Every date and time is Malaysia time
The church is in one place, so a 10:00 service reads 10:00 on every screen.
All date/time work goes through `lib/time.ts` (`churchParts`,
`churchInstant`, `startOfChurchDay`, `addChurchDays`, `churchDayOfWeek`,
`churchDateKey`, `toChurchInput` / `fromChurchInput`, `endOfChurchDate`).
Never call `getHours` / `setHours` / `getFullYear` / `getMonth` / `getDate` /
`getTimezoneOffset` on a `Date` in app code — they read the *runtime's* zone,
which is UTC inside the Worker and the viewer's own zone in the browser, so
the same row rendered two different times. A `datetime-local` value is a bare
wall-clock reading and always means Malaysia. A stored `DATE` covers its whole
Malaysian day — compare against `endOfChurchDate`, not `new Date(dateOnly)`,
or it expires at 08:00 that morning. Unit tests must pass under a non-Malaysia
`TZ` (`TZ=America/New_York npm test`).

### G7 — Mobile-first & theme
Tables become list tiles on small screens (`.only-desktop` / `.only-mobile`
helpers). Two-column layouts collapse to a single full-width column on tablet
and below. Light theme only — no dark-mode branches or `data-theme` code.

### G8 — Every user-facing string comes from the dictionary
- No literal user-facing text in a component — ever. Render it with
  `useT()` from `lib/i18n` and a key that exists in **all three** dictionaries
  (`lib/i18n/en.ts` is the base and the fallback; `zh.ts` / `ms.ts` are typed
  against its key set, and `lib/__tests__/i18n.test.ts` fails the build on a
  missing key, a blank translation, or a drifted `{placeholder}`).
- Enum labels (roles, statuses, weekdays, categories…) live in the dictionary
  too. `lib/labels.ts` returns **message keys**, never text; call sites do
  `t(memberStatusKey(s))`. A label map that returns a translated string is a
  finding.
- Never key data structures — colour palettes, filter values, sort orders — by
  a translated label. Use the stored code (e.g. `DisplayRole`), or the UI breaks
  the moment the language changes.
- The public pages (`/login`, `/d/[token]`, `/enroll/[id]`) have no session and
  so render in the default language; API error messages are English.
- Match surrounding code: functional components, hooks at top, shared `ui.tsx`
  building blocks, no new CSS frameworks.
- Keep `docs/` and this file in sync when a rule or flow changes.

### G9 — Form controls share one size system
- Every single-line control — `input`, `select`, and `.btn` — is sized by the
  shared `--control-h` (small variants by `--control-h-sm`), never by ad-hoc
  per-element padding/height. A `<select>` placed next to a `<button>` (e.g. the
  member-picker + add-member row) must line up in height; a control that doesn't
  use the token is a finding. Don't set custom `height`/vertical `padding` on a
  control to "fix" alignment — fix the token or the class.
- `<select>` uses `appearance: none` with the shared custom chevron (drawn via
  `background-image`, right-aligned padding). Never rely on the native arrow —
  its metrics differ per browser/device and break both height and alignment.
- New controls inherit these by using the base element / `.btn` classes; page
  code should not restyle control geometry inline.

---

## Reviewer output
Report findings most-severe first. Correctness/security (G2, G3, G6) outrank
CRUD gaps (G1) which outrank cleanup/altitude (G4, G5, G8, G9). Every finding
cites a concrete failure scenario and, where applicable, the golden-rule number.
