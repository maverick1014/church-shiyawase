# UI Golden Rules — TOG（主恩堂）

> **这些是这个代码库的硬性要求。违反一条是评审 finding，不是偏好之争。finding 里要写出规则编号。**
>
> **金律的编号是全局的，跨这两份文件不重复也不重排。** 评审引用时写 `G2 违规` 即可。
> 拆成 backend / ui 两份是工作室标准的要求（`docs/studio/REPO_STANDARD.md`），
> **编号一律保持原样** —— 仓库里、PR 里、`scripts/ui-e2e.mjs` 的注释里到处都在引用它们，
> 重排会把每一处引用指向错误的规则。
>
> 通用金律 S0–S9 与工作方式 W1–W4 见 `docs/studio/GOLDEN_RULES_BASE.md` ——
> **这里的 G 规则只能在它之上加严，不能放宽。**

> 本文件收 **G1 · G3 · G4 · G5 · G7a · G7 · G8 · G9**（CRUD 完整性、破坏性确认、一个机制、
> 取数与状态、页面外框、移动优先与主题、字典、控件尺寸）。
> 其余的 **G0 · G2 · G6 · G6a** 在 `backend.md`。
> 由 `ui-designer-agent` 拥有。

---

### G1 — CRUD completeness on every management page
Every entity page (成员、访客、小组、聚会（点名表上的一列）、培训&活动（培训与活动两种形态）、四十天守望模块与配对、幸福小组的期与小组、账户) must offer
the full set its users need: **Create, Read, Update, Delete**. If the API supports an
operation, the UI must expose it (or the omission must be a deliberate,
documented decision). A page that can only create + list is incomplete.
The documented exception: 教会设置 (`/church`) is read + update only — the
church row is a seeded singleton (one deployment, one church) and the module
catalog is code, so neither can be created or deleted from the UI. 成员 has two
extra CREATE paths beside its form — a spreadsheet import and the public
self-registration link — and both are create-or-update on the name pair rather
than a second way to make duplicates. 访客 is the same table under a second
page (0031): its own CREATE (the form and the public `/welcome` link), its own
list, and Update/Delete through the SHARED member detail page and
`MemberEditModal` — which is why neither is duplicated for it. A BEST has no
list page of its own on purpose: they are created and read on the 幸福小组
roster that met them, and on the term's own BEST 名单.

### G3 — Every destructive action shows a confirmation
Any delete/remove/detach/irreversible action (`api.delete(...)`, or a mutation
like 移除/清空/重置 that discards data) MUST go through the shared
`useConfirm()` dialog (`components/ui.tsx`) with `danger: true`. Native
`window.confirm` is not allowed. No silent destructive taps.

### G4 — One mechanism, not per-page reimplementations (altitude)
Reuse the shared primitives instead of re-rolling them per page:
`Modal`, `Field`, `PasswordInput`, `useConfirm`, `useToast`, `RoleBadge`,
`Avatar`, `MemberName` (**every** rendering of a person's name — one component
draws the ONE name that person's own congregation reads them by (0028), so no
page invents its own shape or re-derives which of the two names to show),
`useMemberOptions` (**every** member picker's options — the same rule as
`MemberName` plus the other name in a searched-but-never-drawn `search` field;
ten pages used to hand-roll `{ label: full_name, sub: english_name }`),
`PairProgressModal`,
`MemberEditModal` (the member-edit form — `/members/[id]` and the roster
`Edit` button on `/groups/[id]` both open the same one), `MonthPicker`/`SheetTick`/`SheetTickAll`/
`SheetTotals` (the pieces the 聚会, 小组 and 培训&活动 namelists share — the
totals `<tfoot>` in particular is written once, so its label, its numbers and
the rule above them cannot drift between three sheets), `Segmented` (every segmented
control), `Combobox` (**every** picker whose options are members — a native
`<select>` is a system wheel with no search on a phone, and the member list only
grows; its matching rules are `lib/combobox.ts`),
`exportRows`/`exportMatrix` (`lib/export.ts`),
`copyText` (`lib/clipboard.ts` — **every** "copy this link" button: the async
Clipboard API is missing in some in-app browsers, where `navigator.clipboard?.…`
silently does nothing at all, so the helper falls back and always returns
whether it worked, and the caller always says so),
`ThemeSwatch` (**every** rendering of a theme — the preset list and the custom
preview are the same split circle),
`PhotoPicker` (**every** "choose a photo of a person" — the add-member modal and
the public /join form; `accept="image/*"` and no `capture`, so the phone offers
the camera and the gallery both),
`planImport`/`pairKey` (`lib/members-import.ts` — the ONE place that decides what
an incoming member row means, run by the browser's preview and by the server),
`api` (`lib/api.ts`), and the label/style helpers in `lib/labels.ts`
(`roleTagStyle`, `roleDot`, `memberRoleZh`, `positionZh`, status/category
classes). New code that duplicates one of these is a finding — name the helper
to call instead. Colours come from CSS tokens / `ROLE_TAG`, never hard-coded hex
in components — and a token that is a *shade* of the church's two chosen
colours is `color-mix()`'d from `--rail` / `--brand` in `globals.css` rather
than written out, including the sidebar's light-on-dark foregrounds. The one
kind of colour that may be inline is a colour that is **data** (a church's own
pair, on its way into `--sw-rail` / `--sw-brand`).

### G5 — Data fetch/derive once; simplify state
Don't map the same collection twice (e.g. desktop table + mobile tiles) with the
logic duplicated — compute the row model once and feed both, or use one
presentational component. Don't keep state you can derive from props/fetch.
Prefer `useFetch` + `useMemo` over manual effect/loading bookkeeping.

### G7a — One page-chrome shape for every page
The header is **title only** (no subtitles). Every list page's top row is one
shared `<PageBar filters actions />`: the page's filters on the left, **all of
its buttons in the right corner**, collapsing to a stacked filters-then-actions
column below 640px. A page never renders a second bar, never puts a `<select>`
in the actions half, and never gives an action an ad-hoc width — page actions
are content-sized like every other control. Filter order inside the bar is
search → dropdowns → export/info.

The content column fills the shell, the same width as the header above it —
there is no reading-measure cap on a page of tables and sheets, and a cap with
no auto margin only produced a band of empty paper on the right. A single-column
FORM page (账户详情, 教会设置) opts into a measure with `.page-narrow`, never an
inline width.

Shell-level controls (the congregation switcher) belong to the shell, not to a
page: top right of the header on desktop, in the nav drawer above 首页 on
phones. They use the same `--control-h` as every other control — no `sm`
variant, no inline width.
List tables size their columns to their own content (`table-layout: auto` +
`white-space: nowrap` on cells). Never hand-type a column width: one tuned to
two CJK glyphs clips the moment the same label is English. The one exception is
the **name column of a roll-call sheet** (`.sheet-table`), whose neighbours are
however many occasions the month had: it carries a `min-width` and refuses to
wrap, so that a sheet too wide for the screen scrolls sideways in its
`.table-wrap` instead of breaking a Chinese name one glyph per line.

### G7 — Mobile-first & theme
Tables become list tiles on small screens (`.only-desktop` / `.only-mobile`
helpers), and **every list tile has the SAME shape** — the members list's, made
canonical: `.mtile-row1` carries what the row *is* (the name) on the left with
its **one** identifying tag pinned right beside the chevron, and every other
fact gets its own `.mtile-line` underneath, one per line. A life group reads
名称 + 健康标签 / 组长 / 组员数; an account reads 姓名 + 账户角色 / 邮箱 / the
rest; a 守望配对 reads the pair + its status / its progress bar. Pages used to
each invent their own: the leader crammed inside the group tile's title, the
health badge halfway down beside the member count, the church-role badge next to
the name on an ACCOUNT list — so the tag a reader scans for sat somewhere
different on every page and a long name pushed the title onto two lines. One
tag, top right, always. Two-column layouts collapse to a single full-width
column on tablet and below. **Light theme only** — no dark-mode branches, no
`data-theme` code,
no `prefers-color-scheme`. The church's 主题颜色 is not a counter-example: it
changes the two colours the light theme is built from (`--rail` / `--brand`),
never the light/dark question, which is why a pale rail is refused rather than
treated as "a light sidebar".

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
  so render in the default language; API error messages are English. The
  church's **name** is the one thing on them that is neither: it is data on the
  `church` record, identical in all three languages, so those pages fetch the
  public `GET /api/church` instead of translating it (`form.privacy` takes it
  as a `{church}` placeholder). The build-time `<title>` (`app/layout.tsx`) and
  the PWA manifest (`app/manifest.ts`) cannot read the database and stay
  per-deployment literals — the only two left.
- A user-facing rename stops at the API boundary. The 四十天守望 **模块 /
  module** is `discipleship_programs` in the database: the table, its columns,
  `program_id` and `/api/discipleship/programs` all keep the "program" name,
  while every dictionary key (`disc.module.*`) and everything on screen says
  module. Renaming the wire too would be a migration's worth of churn for
  nothing visible — but the boundary must stay in one place (the page's fetch),
  not smeared through the file.
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
- Date/time inputs (`date` / `time` / `datetime-local` / `month` / `week`) strip
  WebKit's native box the same way — `appearance: none` plus a `min-height` on
  the token, and `::-webkit-date-and-time-value` reset to left-aligned with no
  UA margin. Without it iOS/iPadOS sizes the field from the system picker and
  paints the value centred, so it sits taller than the `<select>` beside it and
  reads centre while its neighbours read left. It lives in `globals.css` with
  the other shared control rules — never patch one page's date field. A
  `color` input (the theme picker's two) gets the same treatment for the same
  reason: the browser draws a swatch inside a box of its own choosing, so
  `appearance: none` + the height token + a zeroed swatch wrapper is what keeps
  it level with the control beside it.
- New controls inherit these by using the base element / `.btn` classes; page
  code should not restyle control geometry inline.

---

---

## Reviewer output
Report findings most-severe first. Correctness/security (G2, G3, G6) outrank
CRUD gaps (G1) which outrank cleanup/altitude (G4, G5, G8, G9). Every finding
cites a concrete failure scenario and, where applicable, the golden-rule number.
