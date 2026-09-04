# TOG（主恩堂）— 领域主提示 / Master Prompt

> **这份文件是 TOG 的领域知识本体。** 教会身份模型、成员的两个名字、点名表的结构、
> 幸福小组与四十天守望、导入与公开表单、仪表盘 —— 每一条口径背后**为什么是这样、
> 当初排除了什么、踩过什么坑**，全在这里。
>
> 原本这些和金律、测试说明一起挤在 `CLAUDE.md`（1327 行）。按工作室标准
> （`docs/studio/REPO_STANDARD.md`，`CLAUDE.md` ≤ 80 行）拆开 —— **内容一字未删，只是换了地方**：
>
> | 原 `CLAUDE.md` 的部分 | 现在在 |
> |---|---|
> | 领域叙事（本文件） | `docs/MASTER_PROMPT.md` |
> | 金律 G0 · G2 · G6 · G6a | `docs/golden-rules/backend.md` |
> | 金律 G1 · G3 · G4 · G5 · G7 · G7a · G8 · G9 + 评审输出格式 | `docs/golden-rules/ui.md` |
> | 推送前的门 · workflow 说明 · 测试分层 | `docs/PROJECT_PROFILE.md` |
> | 索引 | `CLAUDE.md` |
>
> **金律编号保持原样**（G0–G9，含 G6a/G7a 的乱序）—— 仓库里到处都在引用它们，重排会把每一处
> 引用指向错误的规则。

---


Church-management app. Next.js 15 (App Router, React 19) + Supabase, deployed to
Cloudflare Workers via OpenNext. The UI ships in three languages (English /
简体中文 / Bahasa Melayu, chosen per login account, English by default); light
theme only; mobile-first. The API is a single catch-all route handler at
`apps/web/src/app/api/[...path]/route.ts`; auth is a signed HMAC cookie
(`lib/server/auth.ts`).

The church itself is **data**, not a hardcoded string: one `church` row
(name / short name / description / logo / **theme**) drives the sidebar brand,
the login card and the public forms, and `church_modules` records which
**add-on modules** this church runs. Both are edited on `/church` (教会设置,
super_admin only). The catalog of what is switchable lives in code —
`OPTIONAL_MODULES` in `packages/shared` — where each entry names its key, the
nav href it owns and the API prefixes it owns; today the one entry is
`discipleship` (四十天守望). Core surfaces are not switchable and are not in
the registry.

**A theme is TWO colours** (migration 0017): `theme_rail` (the dark sidebar,
`--rail`) and `theme_brand` (the accent, `--brand`), with `theme_preset`
naming which shipped pair they came from — null when they were picked by hand.
Everything else the design system needs is **derived in `globals.css` with
`color-mix()`** from those two (`--brand-2` a shade down, `--brand-soft` a
tint, `--accent`/`--accent-soft`, and the sidebar's own foregrounds
`--rail-ink`/`--rail-text`/`--rail-muted`/`--rail-faint`/`--rail-dim`), so a
shade can never drift from the colour it is a shade of. `--good`/`--warn`/
`--crit` and the warm neutrals are NOT part of a theme — "absent" must not turn
into the brand colour — and `ROLE_TAG` is not either. The presets live in code
(`THEME_PRESETS` in `packages/shared`, first entry = today's charcoal+crimson,
so nothing changes on deploy) while the **colours are stored as well as the
key**, so editing a preset later cannot restyle a church that chose it. It is
the CHURCH's, not an account's: the login card and the public forms are painted
in it too. Both colours are validated **server-side** — a strict `#rrggbb`
(never interpolate an unvalidated string into CSS) and dark enough to carry the
light text the sidebar and every button put on them (`isUsableRail` /
`isUsableBrand`; a pale rail is refused rather than half-supported, which is
why the sidebar's foregrounds could stop being hardcoded greys). Applying one
is `applyTheme` in `lib/theme.ts`, called from `useChurchProfile` so the shell
and the three shell-less public pages share one mechanism; the last pair is
cached in `localStorage` and re-applied by a few inlined lines in `<head>`
(`THEME_BOOT_SCRIPT`) **before the first paint**, so only the first-ever visit
on a device can flash the default palette. The picker (a split-circle
`ThemeSwatch`, one component for the presets and the custom preview) is its own
card on `/church`.

Not to be confused with a **守望模块** (`discipleship_programs`), which is the
definition a 40-day pair hangs off. That one is **created once and then read**:
`GET`/`POST` and `GET /:id`, no edit and no delete anywhere — the manager that
offered them misread which "module" the church meant, and its delete cascaded
away every pair and every day of their records. The create path survives only
for the empty state: with no module the page has nothing to hang pairs on, and
no way back except SQL.

**A member is TWO names, and the PAIR is who they are** (migration 0018).
`members.full_name` is the CHINESE name — what the church types, what every
list is sorted by, what the public sign-up form matches on — and
`english_name` (the column that used to be called `chinese_name` and was
labelled 昵称, which is the one thing it never held) is the English name,
nullable because plenty of people have none. A unique index on
`(lower(btrim(full_name)), lower(btrim(coalesce(english_name,''))))` makes the
two of them the identity of a person: compared the way a human reads them
(trimmed, case-insensitive) and with "no English name" counting as a value of
its own rather than as "unknown, therefore distinct". That deliberately refuses
a second 张伟 with no English name — two people who share a Chinese name must
be told apart before either can be saved, which is exactly what lets an import
say "same person, update" instead of quietly inserting a twin that then holds
half of somebody's attendance. The violation is a **409 naming the conflict**,
mapped once in `unwrap` (`lib/server/db.ts`) rather than at each call site,
because a duplicate pair is a real user-facing outcome and not a bug.

**But only ONE of the two is ever DRAWN, and the congregation picks which**
(migration 0028). Every list used to render both, the Chinese name with the
English one stacked under it; the church's own feedback is that the second line
is noise on every screen at once. `halls.name_display` (`'chinese'` |
`'english'`) says which name that congregation reads its people by — 中文堂
reads 张伟, 英文堂 and 马来文堂 read David (there is no Malay name column, so a
third value nobody could act on was not invented). It is the HALL's property,
read off the MEMBER's own hall, so 张伟 filed in 中文堂 reads 张伟 on every
screen in the app including one somebody in 英文堂 is looking at — a person
looks the same everywhere, which is the entire reason one component draws them.
A stored code rather than a match on the hall's NAME, per rule G8: renaming
英文堂 must not silently change which name it reads by. **"Either one alone"
beats the preference every time** — an English congregation still shows 张伟 for
the member who has no English name, and that is the ordinary case rather than an
edge. When the hall is unknown (a public page with no session, a payload with no
`hall_id`, a database still waiting on 0028) it falls back to the Chinese name,
which is what every congregation showed before any of this existed.

The rule is `memberDisplayName` / `memberAltName` / `hallNameDisplay`
(`lib/names.ts`, unit-tested), reached through `<MemberName />` and the
`useMemberName` / `useMemberOptions` hooks, which read the halls already in
`HallContext` — so a payload only has to carry `hall_id` for it to work, which
is why `MEMBER_BRIEF` carries it beside both names. **Every** member picker's
options come from `useMemberOptions` now (ten pages used to hand-roll `{ label:
full_name, sub: english_name }`, i.e. ten copies of the naming rule sitting
next to the component that owns it); `referrerOptions` is gone, expressed
through the same hook with a `lead` option.

The pair is still the IDENTITY, and the name NOT shown is still matched: a
search finds EITHER name, case-insensitively — the members list, `GET
/api/members?q=`, and `comboboxFilter` via `ComboOption.search`, a field that is
searched but deliberately **never rendered** (putting the other name in `sub`
would put both names back on screen, which is the thing 0028 removed). Both are
still stored, edited, imported and exported. Only the drawing narrowed — the
same shape as the 来访日期 rename (G8), a display decision that stops at the API
boundary.

Neither roll-call sheet has a search box of its own: 全员到齐 and the totals row
cover everybody on screen, and narrowing what is DRAWN while those two still act
on everybody reads as a contradiction, so both sheets simply list the whole
roster, always.

**教会身份 is SIX values, and the last two are not members** (0021, 0031).
`church_role` runs 牧师 → 执事 → 同工 → 一般成员 → **访客** → **BEST**, in
reading order: from the pulpit to the door. A visitor is a ROLE rather than a
status — "visitor" is what somebody is to the church, not whether their record
is active, so a visitor who stops coming is an *inactive visitor* and both
facts survive; and like every other church-wide role it is read **ahead of**
any group position, because a visitor sitting in on a life group is still a
visitor. Its badge is a warm sand no rank uses, so it cannot be mistaken for
普通成员's cool grey or 未分组's warm grey. The reason 0021 needed a migration at
all is worth remembering: `deacon` and `co_worker` had been in the CODE enum
since the day they shipped while the DATABASE type held neither, so saving a
member as 执事 did not degrade — it failed outright, and nothing noticed,
because the two lists were never compared. They are now: a unit test
(`labels.test.ts`) asserts every `ChurchRole` / `DisplayRole` value has a label
in all three dictionaries, an entry in `ROLE_TAG`, a place in exactly one
form's options and a filter on the page that lists it; and `api-e2e.mjs`
creates a member as **each** role against the live database, which is the half
a unit test cannot reach.

**A BEST is not a 访客 wearing a different word** (migration 0031). The
church's own term: somebody who is **not a Christian yet but is open to
knowing Jesus**, met through a 幸福小组. A 访客 came to the CHURCH and may
perfectly well be a Christian from somewhere else. They are followed up by
different people for different reasons, so it is a role of its own rather than
a label on a roster — and a BEST **never carries a life group**, enforced in
the DATABASE (`members_best_has_no_life_group`, migration 0032) and not only
in the form, because the form is one of three ways a row is written. The API
asks the same question first and answers in a sentence, so a check-constraint
violation is never what a user reads (the same split the duplicate-name 409
uses). *0031 and 0032 are two migrations on purpose: Postgres refuses to USE
an enum value in the transaction that added it.*

**成员 and 访客 are TWO PAGES over ONE table** (0031, church feedback: some
visitors attend once and are never seen again, and they were drowning the
roll). `/members` lists the church's own members; `/visitors` lists 访客; a
BEST is on neither — they live on their 幸福小组's roster, which is where they
were met. It is the SAME `members` table, narrowed **server-side** by
`GET /members?scope=member|visitor|best` (rule G2), which is what makes
**转为成员** a single-column PATCH that keeps every roll-call tick, every
training and every referral the person already carries. Eleven tables point at
`members.id`; a separate `visitors` table would have meant eleven nullable FK
pairs and a conversion that copied history between them. `scope` ABSENT means
everybody, deliberately: every member picker in the app reads this endpoint,
and a picker that quietly stopped offering visitors would be the split leaking
out of the two pages it is about.

Which roles a form may offer is `churchRoleOptionsFor` (`lib/labels.ts`),
and the three lists it chooses between — `CHURCH_ROLE_OPTIONS` (the member
form), `VISITOR_ROLE_OPTIONS` and `BEST_ROLE_OPTIONS` — **partition** the
enum: a unit test asserts they cover it and do not overlap, so a role added to
the enum and to none of them fails at the point it is cheap to fix. The list
follows the ROW's own stored role rather than the page that opened the modal,
so a 访客 is edited as a 访客 wherever it is opened from. When that list has
only ONE entry the field is **not drawn at all** — a one-option `<select>` is a
label pretending to be a control, inviting a change it cannot make — so a 访客
and a BEST see no 教会身份 field, while a member, who has ranks to choose
between, still does. What somebody IS is on screen either way, as the badge in
the header.

**Crossing is a BUTTON, never a field** — a decision the church makes about
somebody, not something anyone corrects — and there are exactly two, both
confirmed, both on the person's own page:

- **转为成员**, offered on any non-member. One column changes; every roll-call
  tick, training, referral and their 来访日期 stay exactly as they are, which
  is the whole argument for one table.
- **转为BEST**, offered on a 访客 only (church feedback: a visitor really does
  turn out to be a BEST weeks later, once a leader knows them, and before this
  they had to be deleted and re-created from the roster). It clears the life
  group in the SAME write, because the database refuses a BEST who has one
  (0032) — and the confirmation NAMES that group rather than removing it
  quietly.

Nothing goes the other way: a BEST does not become a 访客 (they would be
somebody who came to the church, which is a different thing that happened), and
a member does not go backwards at all.

**来访日期 is a VISITOR's field now** (0031). `joined_at` left the member form
and the member `FactGrid` — nobody fills in when they first came about
somebody they have known for years, so it sat empty on every member row —
and is the fact `/visitors` is built around, leading its list and sorting it
newest-first. The COLUMN is untouched: what a member already had is still
stored, imported and exported.

`isMemberRole` / `NON_MEMBER_ROLES` (`packages/shared`) is the ONE place that
decides which side of the line a role is on, and it is not cosmetic — it
decides who the dashboard counts as active and who 需要关怀 rings up. An
unknown role reads as a MEMBER, deliberately: a row written by a future
migration lands on the roll and on the follow-up list, where somebody will
see it, never silently outside both.

The roll-call sheet reads in three **sections** — 成员, then 访客, then BEST
(church feedback). Presentation only: one sheet, one set of columns, one
check-all per column, one totals row, one PUT path. The export is sectioned the
same way, because a printed sheet is the same reading task the page is.

A BEST **is** on it. They were briefly left off, on the reasoning that they are
rolled weekly in their own 幸福小组 — the church's own correction is that a
BEST may perfectly well come to a Sunday service, and a roll call you cannot
tick them on quietly under-counts the people the church is trying hardest to
reach. The two roll calls answer different questions ("who came in week 5" and
"who was at the service"), so being on both is right rather than
double-counting. The sections are keyed by the ROLE's own section rather than
by "member vs not", so the two non-member roles never share a heading that
describes only one of them; an unknown future role lands with the members,
where `isMemberRole` already puts it.

There are now **two public sign-up links, and which one the church hands out
is what decides the role**: `/join` + `POST /members/register` makes MEMBERS
(unchanged), `/welcome` + `POST /members/welcome` makes 访客 and stamps
来访日期 server-side, since somebody filling in a first-visit form is visiting
today. One handler runs both (`registerMember` takes a `PublicRegisterForm`:
an allow-list and a role, and nothing else differs) — every rule that matters
on an unauthenticated path is the same rule because there is one of it. The
`/welcome` allow-list is shorter by `group_id` and `serving_roles`: a life
group and a ministry are what somebody takes on once they belong. An UPDATE
never touches the role either way, so a member who fills in the first-visit
form is not demoted by it. Both are exact-path, two-method entries in
`isPublicForm`, never a prefix. `/welcome` is the **fifth** shell-less page.

**A member also carries an address and who brought them** (0021).
`members.address` is one free-text column — what you would write on an envelope,
deliberately not street / unit / postcode / state, because every attempt to
model a Malaysian address that way leaves half the rows working around the
shape. `members.referred_by` is a nullable self-reference to `members.id`, null
by default: "nobody referred them" is the ordinary case and must not need a
placeholder row to say so. On the form it is the shared `Combobox` (a member
picker is never a `<select>`, G4) whose FIRST option is an explicit **无推荐人**
storing NULL, and which never offers the member themselves — the database
refuses a self-referral (`members_referred_by_not_self`) and a user must not be
walked into that error. The member page draws it as a **link to that person**,
guarded like every optional join (G6): `MEMBER_SELECT` embeds it as
`referrer:members!referred_by(...)`, hinting the FK **column** — a
self-referencing embed has to be told which direction it means, and PostgREST
answers PGRST200 for the constraint name.

The two of them split on **who the fact belongs to**, and that split is the
whole reason each allow-list looks the way it does. An address is a contact
detail the person themselves knows best, so it is writable by `/join`
(`REGISTER_FIELDS`) and by a member's own profile page (`SELF_MEMBER_FIELDS`),
beside their phone and email. A 推荐人 used to be excluded from both for the
same reason as `church_role` — who brought somebody is the CHURCH's record of
how they arrived, not a claim the arriving person makes about themselves — but
church feedback (0128) moved it INTO `REGISTER_FIELDS` specifically: a
brand-new registration is the one moment a person plausibly knows and can
usefully say who invited them, arriving as a member id off the form's own
Combobox rather than a name to resolve. It stays absent from
`SELF_MEMBER_FIELDS`: rewriting who referred you, after the fact, from your
own profile is not the same act. `church_role` and `group_position` remain
absent from **both** — those are the church's own calls regardless of when
the record is touched.

**服侍岗位 is a LIST, and it is the same list `groups.tags` is** (migration
0019). `members.serving_roles` is a `text[]`, NOT NULL DEFAULT `'{}'`: which
ministries a person serves in (敬拜 / 司琴 / 招待 / 音响 / 投影 / 儿童主日学) —
free text rather than an enum, because every church invents one nobody modelled
and an enum turns that into a migration, and several per person because 敬拜 AND
音响 is the normal case. Empty array, never null: "serves nowhere" and "nobody
has said" are the same fact, so no reader needs `?? []` to mean anything. Being
that shape is the point — it is entered with the shared `TagsInput`
autocompleting from the ministries other members already carry (the same
derivation `/groups` builds `allTags` with), never a second way to type a list
of short strings. **What ends a tag in that control is Enter, leaving the field,
or any of the separators a list is written with** — the commit-on-blur is not a
nicety: without it, typing a ministry and going straight to Save left the text
sitting in the input while the form saved an empty array, and on a phone the
on-screen key says 完成 rather than Enter, which made that the ordinary way to
use it. The separators are read from `LIST_SEPARATORS` in
`lib/members-import.ts` rather than listed a second time, so a list is ended the
same way in a form as it is inside a spreadsheet cell; and the chip's own ×
refuses the mousedown, so removing one cannot commit a half-typed draft on its
way out. The same component is 小组标签, so both had the same silent loss. The members list filters by the **stored** string (G8), on a
dropdown that only appears once somebody serves somewhere, and the member page
draws the ministries as badges and **nothing at all** when there are none — an
empty list is a fact about that person, not a value the church has yet to fill
in, which is exactly what the 家庭 tile it replaced got wrong. It is the
church's to hand out: it is writable on `POST`/`PATCH /members`, by the
import, and — church feedback, 0128 — by a fresh self-registration on `/join`
(`REGISTER_FIELDS`), the one public path that now offers it. It stays
deliberately absent from `SELF_MEMBER_FIELDS` (`/auth/me/profile`): a person
already on the roll editing their OWN profile is not the same act as somebody
joining and saying up front where they'd like to serve.

**`joined_at` reads as 来访日期 / Visit Date on screen, and a member now
carries a SECOND date** (migration 0023, `group_joined_at`): when they joined
their CURRENT life group, a fact separate from when they first came to the
church. The rename is display-only, per rule G8 — the column keeps the name
`joined_at` everywhere in code, in every migration, in `Member`/`MemberRow`
and in every API payload; only the field's LABEL changed, on the member edit
form, the member add form and every `FactGrid` that shows it (member detail,
`/profile`). `group_joined_at` is a plain nullable date column with no
server-side allow-list of its own — `PATCH`/`POST /members` are raw
passthroughs — so wiring it in was a client-only change, in both member forms,
right beside where the group is chosen; nullable and excluded from any report
built on it, exactly like `joined_at` already was. The member ADD form also
gained a 备注/notes field — the same textarea the edit form has had since the
very first migration, now on both. The members list traded its own **Joined**
column for a **Remark** one: `notes`, truncated with an ellipsis in a bounded
cell (`.cell-remark`) rather than sized to its content like every other column
here (rule G7a), with the full text still reachable through a native `title`
tooltip.

**A member row arrives three ways, and all three decide what a row MEANS in one
place** — `planImport` in `lib/members-import.ts`, which the browser and the
Worker both run. Typing one into the form is the first; the other two are new:

*成员导入* (`POST /members/import`, super_admin/admin, 300 rows at most) takes a
`.xlsx`/`.csv`. The file is read in the BROWSER (SheetJS lazily, like
`lib/export.ts` — never at module top level), previewed **row by row** —
add / update / skipped-and-why — and only a deliberate press writes anything;
overwriting people the church already has goes through `useConfirm({ danger:
true })` naming how many. The server then plans the SAME file again against the
live database, because a preview is a courtesy and the server is the authority
(G2). Matching is the pair index's own comparison (`pairKey` = `tidy` + lower,
missing English name = empty string), so an existing pair is an **update of only
the columns the file actually supplied** — a blank cell means "nothing to say",
never "clear this", and a sparse re-import cannot blank a phone number the
church already had. Headers and enum values are matched against **all three
dictionaries** (read from them, never copied, with a unit test guarding the
drift), so a Chinese template filled in and sent back reads correctly; the
template itself is `exportRows` over the same column list, and so is the
members page's own export — one definition, so a list exported there can be
edited and uploaded straight back. `IMPORT_COLUMNS` is that definition: 中文名、
英文名、电话、邮箱、**地址**、**推荐人**、性别、生日、加入日期、教会身份、状态、堂会、
小组、**服侍岗位**. 推荐人 is the one column holding a REFERENCE: a spreadsheet
has no ids in it, so it is resolved by name — one cell may write 「张伟」 or
「张伟 David」, folded exactly the way `pairKey` folds a pair (`referrerKeys`),
with the whole written pair beating a bare Chinese name so that 「张伟」 names
the 张伟 who has no English name, exactly as it would in the 中文名 column — and
a name that answers to nobody, to two people, or to the row's own person is a
REFUSED row naming the spreadsheet row and the value, never a guess. A refused row names its own SPREADSHEET row and the value it choked on,
and never stops the rows around it. Dates are year-first only: `03/04/2026` is
two different days depending on who reads it. 服侍岗位 is the one column holding
a LIST in one cell, so it accepts every separator a church might reach for
(`,` `，` `、` `;` `；` `/` `／` — `LIST_SEPARATORS`, shared with the form's own
tag field), trims each piece and drops the empties a trailing separator leaves — and an empty cell still supplies nothing, so a sparse
re-import cannot un-serve the whole church. 教会身份 accepts **every** role the
app ships, 访客 and BEST included (0031) — that cell decides which of the two
pages a row lands on, which is the whole point of it being a column. Its table
is read from `Object.values(ChurchRole)` rather than listed by hand, because a
hand-written list is exactly what left 访客 silently unimportable for as long
as that role existed. A BEST the file puts into a 小组 is a REFUSED row naming
its own row and the group, rather than a check constraint tripping mid-file and
failing everything around it — read off the role the row will END UP with, so
a file that adds a group to somebody already a BEST is caught as readily as one
that does both in the same row.

*自助注册* (`/join` + `GET`/`POST /members/register`) is the public link the
church hands out for MEMBERS — the fourth shell-less page. (`/welcome` +
`GET`/`POST /members/welcome`, the first-visit form that makes 访客, is the
fifth; see the 成员/访客 split above. Those two exact paths are the only public
ones under `/members`.) Its field set now mirrors the staff-facing add-member form
(church feedback: "all field is needed") — names, phone, email, address,
gender, birthday, congregation, 推荐人, a life group, 服侍岗位, notes, photo —
with exactly two holdouts: `church_role` and `group_position` are read from
nowhere, ever, because a RANK and a group SEAT are the church's own calls, not
something a visitor gets to claim walking in the door; every self-registration
is an ordinary member. `referred_by`/`group_id` arrive as ids straight from
the form's own Combobox/select (`GET /members/register` hands the public page
names-only lists to build them from — never phone, email, address or
birthday), never a name to resolve the way an imported spreadsheet row is.

Matching is `matchRegistrant` (`lib/members-import.ts`), deliberately NOT
`planImport`'s own `pairKey` — a different question, and answered in its own
function rather than by bending `planImport` to a second meaning, which would
have put the CSV importer's carefully-tuned identity model at risk for a page
that does not need it. An imported row is trusted to carry the church's exact
spelling of both names; a person typing their own registration is not, so
requiring the English name to match too would file a returning visitor as a
stranger the moment they left it blank a second time. The Chinese name ALONE
is therefore the anchor — it names exactly one person in the ordinary case,
and an exact match on it is enough, whatever (if anything) was typed as an
English name. When it names SEVERAL people, the phone number is the
tie-breaker: one exact match settles it, and anything else (none, or more
than one) means this is a new person, never a guess at an existing one. An
update never re-spells the church's record of a name or moves an existing
member's congregation — only a brand-new row gets `full_name`/`english_name`/
`hall_id` at all — and the answer is one word (`created` / `updated`), the
same shape either way, carrying no member data at all. The photo travels WITH
the registration in one multipart POST, exactly like a paid sign-up's receipt:
nothing reaches storage until the row is accepted, which is what keeps the
unauthenticated upload paths from being file storage.

Both member forms take a photo through the shared `<PhotoPicker />`:
`accept="image/*"` and deliberately **no `capture`** attribute — the OS sheet
then offers the camera AND the gallery, which is the point; `capture` would
force the camera and remove the choice. It previews the pick and lets it be
removed, and never uploads anything itself (the add-member modal posts to
`/members/:id/avatar` once the row exists; `/join` sends the file with the form).

**Every image upload is compressed in the browser before it leaves the
device**, because a phone camera photo routinely exceeds the server's 5MB cap
(`IMAGE_UPLOAD`/`SLIP_UPLOAD`/`PHOTO_UPLOAD` in `route.ts`) while the picker
offers no way to ask for a smaller one. `compressImage` (`lib/imageCompress.ts`)
downscales to at most 1920px on the long edge and re-encodes as JPEG
(PNG stays PNG, to keep transparency — JPEG has no alpha channel and would
flatten it to black), stepping the quality down until it clears a 1.5MB
target or bottoms out. It never enlarges a small file, never returns a result
bigger than what came in, and passes SVG and non-images (a PDF receipt)
through untouched, falling back to the original file on any decode error —
so a compression bug degrades to "uploads the original", never to "the
upload silently vanishes". It runs at every call site that hands a user
a file picker for a photo: `PhotoPicker` itself (member forms, `/join`),
a member's own avatar re-upload, the church logo, a training's payment QR,
and the image half of a training's payment-receipt upload (the PDF half
is untouched).

**培训 became 培训&活动 (Trainings & Activities).** Everything that is neither a
Sunday nor a hand-added meeting lives on `/trainings` now — a brothers' hike, a
sisters' baking afternoon — because an activity is exactly what sign-ups plus a
roll call already are. One column tells the two shapes apart: `trainings.kind`
(`course` | `activity`, migration 0014). On screen the first shape is a
**培训 / training** — the page is 培训&活动, so calling half of it a "course"
was one name too many; `kind` stays `course` on the wire, because a user-facing
rename stops at the API boundary (G8). A **培训** runs over several
sessions; an **activity** is ONE occasion, whose single `training_sessions` row
is created by the API with it and exists only to give the roll call its one
column to tick — its date, **its time and its meeting point** are the record's
own `starts_on`/`ends_on` (the same day twice), `start_time` and `location`
(migration 0016), so there is no second place any of them can be edited. `kind`
is **fixed at creation** (migration 0024 retired the course↔activity
conversion this form used to offer, church feedback: "easier, and will not
confuse"): the segmented shape picker in `TrainingModal.tsx` shows only while
CREATING a row; editing an existing one shows the shape as plain read-only
text, with no control that could change it. The server enforces the same thing
independently (rule G2) — `trainingWrite()`'s `applyKindEffects` option is
`false` on every PATCH, so even a hand-rolled request carrying `kind` has it
deleted before the update runs and never mutates `total_sessions`/`ends_on` on
an edit; `ensureSingleSession` in `route.ts` now runs only once, from the POST
that creates an activity. The public self-sign-up link (`/enroll/[id]`,
matching a full name) serves both shapes, unchanged.

There is no 类别 any more, and no `trainer_id`: who runs a thing is **`pic` +
`pic_contact`**, both plain text, because the person in charge is often an
outside speaker with no member record and what people need is a number to ring
before they sign up. Both show on the catalog card, the detail header and the
public page — one line, built once by `trainingMeta` in `lib/labels.ts`, which
also carries the optional **性别限制** below (0024): `trainings.gender`,
nullable `gender_type` (the same enum `members.gender` uses). The form offers
only 男 / 女 / 不限 — "other" is deliberately not a selectable restriction here,
even though the column itself allows any `gender_type` value, because a
training's restriction is meaningfully binary in this church's actual use
(兄弟团爬山 / 姐妹团做蛋糕). It is enforced **server-side at enrollment**: the
public self-enrollment handler (`POST /trainings/enroll/:id`) refuses a
mismatched member with a 400 after resolving the name, a real business rule
rather than a UI-only hint. The create/edit form pairs its fields differently
per shape now: an activity's meeting point sits beside the congregation/hall
select in one row; a course pairs its session count with the hall select in
one row and its start/end dates in a separate row underneath — the hall select
is rendered branch-locally in each case (same `form.hall_id` state) rather than
once, shared, after both branches. The payment QR can be picked **during
creation** too, not only after the row exists: the file is compressed
client-side and held in the form until the training is created, then chained
onto it with a follow-up `POST /trainings/:id/payment-qr` before the modal
closes — a failed chained upload does not roll back the successful creation,
it toasts a distinct warning naming that the QR needs to be added from Edit.
成员's church-wide role (访客/一般成员/...) no longer shows anywhere on this
page's three role-bearing spots (the enrollee-picker hint, the enrolled-member
row, the printable namelist's role column) — a training reads who signed up,
not what they rank as.

**报名费 (0016).** `trainings.fee` null/0 means free and nothing below it
appears. A fee that IS set carries `payment_instructions` (free text — a bank
account, a TnG number; one column, because a church will invent a method
nobody modelled) and an optional `payment_qr_url` uploaded like every other
image in the app. The public form then shows the amount, the instructions and
the QR **above a required receipt upload**, and the receipt travels *with* the
sign-up (one multipart POST to the same public path) rather than through an
upload endpoint of its own — nothing is written to storage until the name has
matched exactly one member, so the one unauthenticated upload path cannot be
used as file storage. It stores `training_enrollments.payment_slip_url`, which
the admin opens from the **enrolment review row, beside Approve**, because
approving a paid sign-up means a person checked that the money arrived.

**Attendance is ONE sheet with two kinds of column.** A Sunday is not an event:
every Sunday simply happens, so `/events` (崇拜与祷告会) opens on a **sheet**
for the month — the members down the left, and across the top that month's
Sundays followed, in date order, by every meeting someone added for it. A
**Sunday column** carries the two ticks a Sunday has, 会前 and 主日
(`sunday_attendance`, migration 0013); a **meeting column** is one hand-added
occasion (a 31 August night prayer meeting) with the single tick 到场, stored in
`event_attendance` where a meeting's attendance already lived. Nothing creates
a Sunday, a Sunday nobody marked has no rows at all, and unticking deletes
rather than storing falses — in either table.

A hand-added meeting is a **title, a date, a congregation and an optional
地点** — no type, no end time, no description, no recurrence (migration 0020
dropped `events.description` and `events.ends_at`, which no form ever collected
and no page ever drew). 地点 stayed, and the reason is worth remembering: the
dashboard's 近期聚会 line has always rendered `日期 · 地点`, so a grep of
`/events` alone read the column as dead when it was merely **unfillable** — the
missing half was the form's, and the form now asks for it, worded like
培训&活动's own meeting point so one thing does not have two names.

The page knows about neither table: `GET /api/attendance/sheet` hands each
column an opaque `key` (`sunday:YYYY-MM-DD` / `meeting:<id>`) and
`PUT /api/attendance/sheet` quotes it back, so the server decides where a tick
lands. That write takes a **list** — `member_ids` (`member_id` is the singular
alias) — because both sheets carry a **check-all in every column header**
(全员到齐): a single tick is a list of one and a whole column is the list of
everybody, down the same path, through the same gate, under the same hall rule.
The life-group sheet does the same through its own endpoint, whose `records`
was already a list. Filling a column asks nothing; clearing one throws records
away and so goes through `useConfirm({ danger: true })` naming how many ticks
go. The header's three states (`columnTickState` in `lib/sheet.ts`) are drawn
by the shared `SheetTickAll`, an indeterminate checkbox — "some" is shown
honestly, never rounded to on or off. **A roll call totals DOWN a column, not
across a row**: what a church asks of a sheet is how many people came to that
occasion, never how many occasions one person came to, so every namelist in the
app (崇拜与祷告会, a life group's own meetings, a 培训&活动 namelist) ends in a
shared `SheetTotals` `<tfoot>` — one headcount under each column — and none of
them has a trailing per-person tally column any more. The number is the one
`columnTickState` already counted for the check-all, not a second walk over the
rows, and the exports carry the same change: no per-person columns, one totals
row at the bottom of the matrix. Which columns a month has, and in what order, is a pure function in
`lib/sheet.ts` (unit-tested under a non-Malaysia `TZ`). On 全部堂会 the sheet
simply lists **every** member — the old "pick a congregation" 400 is gone —
while a tick is still filed under the member's **own** hall, so what was
recorded never loses its congregation. **循环聚会 is gone entirely** (migration
0015): it only ever manufactured rows for dates the calendar already knew, and
the sheet supplies its own columns. A **life group's** roll-call card
(`/groups/[id]`) is ONE table, one column per Sunday of the month, each
carrying THREE ticks — 小组, 会前, 主日 — rather than two blocks side by side.
会前/主日 are not a second copy of a Sunday — they are the SAME sheet, asked for
one roster (`GET /attendance/sheet?group_id=`), and a tick there quotes back the
same column key and lands in the same `sunday_attendance` row the services sheet
writes, filed under the member's own hall server-side. **One store, two doors**:
a leader may mark their group's Sunday where they already are, and the office
still reads one number — which is the only shape in which a second entry point
is safe. `group_id` narrows the ROWS and nothing else (the columns stay the
Sundays; a congregation meeting is not the group's to roll), the hall rules come
FIRST (it is a read of that group, guarded by `assertRowReadable`, so it cannot
be used to see another congregation's roster), and the PUT is untouched. **小组**
is a group's own tick (`group_meetings` / `group_attendance`, its own endpoint,
its own lazy meeting-on-first-tick) — filed under the SUNDAY of that week
rather than the group's own meeting day, because a group's week and the
church's week are now the same week, whichever evening the group actually met.
There is no longer a per-group "week 1, week 2…" numbering: the date itself is
the column's identity, the same identity the services sheet already used.

**幸福小组 (Happiness Groups) is the one roll call that IS week-numbered** —
the exception the paragraph above just moved life groups away from (migration
0022). 期 (term) → 幸福小组 (group, belongs to one term) → roster (教会成员 ＋
**BEST**) + weekly attendance tracked **by week number, not by calendar date**.
A BEST needs no special handling anywhere: it is simply a member whose
`church_role` is `best` (0031 — it was 访客 until the two were told apart),
so the roster picker is the ordinary member `Combobox` over every member,
unfiltered, and the roster's own "＋ New BEST" quick-add is the ONE form in
the app that writes that role. A roster row's tag reads `!isMemberRole` and
draws the row's OWN role, so a roster filled in before 0031 still says 访客
about the people the church filed as 访客 rather than relabelling them.
The TERM page carries the overall **BEST 名单** for the whole 期
(`GET /happiness/terms/:id/best`) above its group list — a term is run as one
thing, and no single group's page can answer who the term is reaching; one
request, walked server-side past the hall gate, and drawn only when it has
somebody in it. `happiness_terms.weeks` (1–52,
default 8) lives on the TERM, not the group — every group in a term runs the
same length, which is what makes "week 5" comparable across the term's groups
and comparable term to term. Unlike 守望模块, a term is **not** create-once:
`happiness_terms` is a first-class, repeatable entity, and several may overlap
(a new term starting before the last one finishes is the normal case), so full
CRUD applies to both terms and groups. `happiness_groups.hall_id` is a direct,
required column exactly like `groups` (life groups) — a 幸福小组 has its own
congregation rather than deriving one the way a 守望配对 derives its hall from
the mentor — so it walks the same hall gate as `/groups`
(`hallFilter`/`withHall`/`assertHallWritable`/`assertOwnsRow`), never
discipleship's more roundabout pattern. The roster
(`happiness_group_members`) is an ordinary join table, and removing someone
from it does NOT touch their attendance history — the two tables carry no FK
between them, so a week they attended stays on the record even after they
leave the roster. `happiness_attendance` is **presence-only**, the opposite
convention from `discipleship_progress`'s upserted boolean: a row means
"present that week", so marking present INSERTs and marking absent DELETES —
there is no boolean to flip. The database checks `week_number` against a
blanket 1–52; the API additionally refuses a week beyond the TERM's own
`weeks`, a bound a check constraint cannot reach, with a clear 400 rather than
a silent accept. The sheet on `/happiness/group/[groupId]` reuses the exact
same shared `SheetTick`/`SheetTickAll`/`SheetTotals` components the Sunday and
life-group sheets use — one column per week NUMBER instead of per date, same
check-all/clear-confirms-first rules, same totals `<tfoot>`. **活动记录 is the other half of the roll call**, and BOTH kinds of group keep
one (0029 幸福小组, 0030 life group — church feedback asked for the second). The
sheet
answers "who came in week 5"; nothing answered "what did we do", which is the
half a leader wants back at the end of a term — so `happiness_activities` is one
dated record per occasion (`happened_on`, an optional title, free-text notes)
with `photo_urls text[]` on it, reached from a **活动** button at the top right
of the group's own page. Dated rather than week-numbered on purpose: a group
that met twice in one week, or gathered outside the term, would have nowhere to
put the second record, and a photo is remembered by when it was taken. The list
is one column rather than a photos table — the same call `serving_roles` and
`groups.tags` already make, since the app only ever reads and writes the whole
list, and NOT NULL DEFAULT `'{}'` so no reader needs `?? []`. Photos upload to
a `photos` bucket (the fourth of exactly the same kind as `avatars`/`branding`/
`payments`), compressed in the browser first like every other image (G4), and
only ever onto a record that already exists — nothing reaches storage attached
to a row that was never saved. Every route is gated by the GROUP
(`assertRowReadable`/`assertOwnsRow` on the OWNING table) because an activity
has no hall of its own, and `group_id` is taken from the PATH on both insert and
update so a payload can never file a record past its own permission check.

**Two tables, one handler, one page.** `happiness_activities` and
`group_activities` are separate tables because each keeps a real NOT NULL
cascading FK to its own owner, and the app never reads both at once nor moves a
record between them — a shared table would need a pair of nullable FKs and a
check constraint to buy nothing. The duplication stops at the schema:
`activityRoutes` in `route.ts` takes the owning table and the record table as
parameters and is written once, and `<ActivityLog />` (`components/`) is ONE
component taking the API base and the Back href, so the two route files under
`/happiness/group/[groupId]/activities` and `/groups/[id]/activities` are four
lines each. The dictionary keys are `act.*`, not `happy.act.*`, because the
feature is not happiness-specific — a key must not lie about its scope (G8).
Both pages reach it from the shared `BackBar`: Back on the left, 活动 in the
right corner, never buried in a card's head.

Like 守望, it is a
toggleable add-on module (`church_modules`, `MODULE_HAPPINESS` in
`OPTIONAL_MODULES`, 404 when off) — but unlike 守望's `/d/[token]` mentor form,
it has **no public-facing page at all**: roster and roll call are staff/leader
only.

**期号 is server-assigned, not typed** (church feedback: a term just needs a
name). The term form (`happiness/page.tsx`) asks only for 名称 (now required)
and 周数; `POST /happiness/terms` fills `term_no` itself — one past the
highest on record — when the client sends none, so it still sorts the list and
still tells two same-named terms apart. **It is no longer DRAWN anywhere**
(church feedback: 直接按照名称就可以了) — not the catalog card's badge, not the
term detail page's title, which is the term's NAME now, and not a member's own
幸福小组 history. `happy.term.pageTitle` survives for the dictionaries' sake;
nothing renders it. The term detail card dropped 期号 as a fact and no longer
collapses 起止日期 into one string — 开始/结束 are their own rows. Its group
list tile follows the life-group tile exactly (G4/G7) except that it carries NO
tag: a life group's tag is its health status, and a 幸福小组 has no equivalent
worth pinning to the first row, so the roster count reads as a fact on its own
line where the member count sits on a life-group tile.
**Editing and deleting a 幸福小组 now live on the GROUP's own detail page**
(`/happiness/group/[groupId]`), not on the term's list: that list (both the
desktop table and the mobile tile) is nav-only now, matching `/groups`'s own
list exactly (rule G4) — a row/tile opens the group, full stop. The group
page's own top-left card is an editable form (名称/hall/组长/星期/时间/地点)
with its own Save/Delete, replacing the read-only 期号+聚会安排 text it used
to show; the roll-call card moved above it, roll-call-first, the same order
`/groups/[id]` already uses. **A roster row shows one thing about a person: whether they are the 福友**
— `church_role` being 访客 (0021) draws a visitor tag, and everybody else
carries no label at all, because a column of 组员 badges says nothing the roster
does not already say by listing them. The row's own free-text role
(`happiness_group_members.role`, migration 0027) was taken back OUT on church
feedback: the column is still selected and still stored, so whatever a leader
already typed survives, but nothing draws it and nothing writes it (its PATCH
endpoint is gone). A dropped column would have thrown that typing away, which is
why the migration stands. The row instead offers **View beside Remove**, the
same pair — in the same order — that the life-group roster offers (rule G4). **Adding a roster
member can create them on the spot** (church feedback: this — reaching people
who have no record yet — is the actual point of 幸福小组): the roster panel's
"＋ New visitor" form takes just 中文名/英文名/电话, `POST /members` with
`church_role: visitor` and the GROUP's own `hall_id`, then adds the new row to
this roster in the same flow — a leader never has to leave the page to create
a 福友 first. A member's own participation also now reads back on their own
profile: `GET /happiness/members/:memberId` (nested under the `happiness`
prefix, not `/members/:id/happiness`, specifically so `moduleForApiPath` still
gates it — it matches on the FIRST path segment) returns every group/term the
member has served in, drawn on `/members/[id]` as its own section
(`happy.title`, same list-row shape the 四十天守望 pairs list already uses).

**The dashboard (`/`) is four cards about ATTENDANCE, and it is pastoral
rather than analytical** (0130). It used to plot a member-growth curve whose
own code comment admitted it was not a real historical reconstruction (status
and role are only known as of *now*), beside a KPI counting member ROWS — while
ignoring the roll call the whole rest of the app is built on. It now answers
the four questions a church actually asks, in that order:

- **上主日** — last Sunday's 主日 and 会前 counts, how they compare, and the
  Sundays behind them as a sparkline. The comparison deliberately EXCLUDES the
  latest Sunday from its own average (`sundayPulse`): comparing a number
  against a mean it is part of always understates the change, badly so on four
  points. A Sunday nobody marked is a real **0**, not a gap — the sheet stores
  no rows for one, and a church that forgot to take the roll call should see
  that rather than have it smoothed away. Drawn as BARS, not a line: these are
  counts of separate occasions, and a line between two Sundays implies values
  in between that do not exist. Every bar is LABELLED with its own count and
  its date: a bare shape answers "up or down" but not "up or down from what",
  and on a phone there is no hover to fall back on. The average also drops the
  LEADING run of unmarked Sundays — zeroes from before the church ever took a
  roll call are the app not being in use, not empty services, and averaging
  against them told a church two weeks in that they were "+9 on the 7-Sunday
  average". Zeroes in the MIDDLE still count, because those are a real missed
  roll call. `sundayPulse` reports how many Sundays it actually averaged so the
  label states the real number.
- **需要关怀** — active MEMBERS (`NON_MEMBER_ROLES` excluded server-side, so
  neither a 访客 nor a BEST is ever on it: this list is the church chasing its
  own people, and a BEST is followed up by their 幸福小组 leader instead) with
  no 主日 tick across the last **four** Sundays (church's own choice: about a
  month, long enough that a holiday does not flag somebody). Longest-absent
  first, capped, each row opening that member. The one section here that is a to-do rather than a
  report, and the reason the redesign was worth doing. The window is always the
  last four Sundays and NOT the window the chart draws, so widening the chart
  never widens who gets chased; `last_seen` being null means "not in the window
  at all", which is deliberately not the claim "never came".
- **即将举行** — what is on over the next THREE months, not the next seven days:
  a church prepares an event about that far ahead (their words), so a weekly
  window showed an empty card most weeks and hid the thing they were actually
  working on. 聚会 and 培训/活动 share one list sorted by date, each row tagged
  with its kind — to somebody reading this card they answer the same question,
  and split in two they would be two short cards that are usually empty. A
  meeting carries a real timestamp and a 培训/活动 a bare DATE plus its own
  start time, which is why `kind` rides on the row rather than being sniffed
  from the string.
- **小组概况** — the health buckets as chips, keyed by the STORED status code
  (G8) so they are language-independent and land on `/groups`'s own filter.

All four are fed by **one** `GET /api/dashboard`, counted server-side past the
same hall/group gate as every other read. The old page pulled the entire roster
and every event into the browser and counted there; adding attendance that way
would have meant a request per Sunday or shipping the attendance table down.
It also means a `group_leader` gets this same page narrowed to its own group
for free, instead of the special-casing the old one needed to hide a section it
had no reach for. `recentSundays` / `sundayPulse` / `groupHealthRollup` in
`lib/dashboard.ts` are pure and unit-tested (under Malaysia, New York AND
Auckland — a Sunday-walking helper is exactly what breaks either side of the
date line), and `recentSundays` walks days via `addChurchDays` rather than
listing a month's Sundays, because eight Sundays crosses a month boundary.
`monthlyVisitAndActiveTrend` survives in the same file, now unused by any page.

**Member detail is several small `FactGrid`s under section headers, not one
long undifferentiated one.** `FactGrid` itself is unchanged (rule G4) — the
page just calls it more than once (Contact, Church, Ministry, Notes,
Referral), each under its own `.section-label`, the same heading style
培训记录/四十天守望 already use below them; `EntityHeader` at the top is
untouched. 教会身份 is not repeated in a grid since it is already the badge in
the header. Each pair in the 四十天守望 list below it now reads as ONE
sentence — **Leading X** when this member is the mentor, **Led by X** when
they are the trainee — aligned with how `/discipleship` and
`PairProgressModal` already phrase the same relationship (the ➜ arrow,
`disc.progress.direction`), replacing a bare `[Mentor]`/`[Trainee]` badge the
church found confusing. `disc.col.mentor`/`disc.col.trainee` survive
unchanged: `/d/[token]`'s own header still uses them.

**The member-edit form is ONE component, `<MemberEditModal />`**
(`components/MemberEditModal.tsx`) — extracted out of `/members/[id]`, which
used to define it inline and privately, with the same props and the same
leadership auto-demote behaviour (promoting someone into a leadership slot
first demotes the incumbent). `/groups/[id]`'s own roster table offers an
**Edit** button beside **Remove** now (same `perms.write` gate) that opens
this same shared modal for that row's member — reloading the group's own
member fetch on save, rather than a second, roster-only copy of the form.

---

## 运维现实：推送门、部署触发、以及数据库为什么会睡着

> 从 `CLAUDE.md` 原样搬来。命令与总表在 `docs/PROJECT_PROFILE.md`，
> 门的执行归 `docs/golden-rules/backend.md` 的 G0。

Run before every push: `npx tsc --noEmit && npm test && npm run build`, plus
`npm run test:ui-e2e` whenever a page, a component or `route.ts` changed —
this is **golden rule G0**, and it is the only gate the browser suite has left
now that `ui-e2e.yml` never fires on its own. Deploys are gated
on unit tests + a post-deploy smoke test + the API E2E
(`.github/workflows/deploy.yml`).
**`deploy.yml` fires on a push to `main` — i.e. on a merge — and on manual
dispatch, nothing else.** Iterating on a branch is not a release, and it used to
deploy (and run the browser suite) on every commit of a branch in flight. The
trade is that the shared URL tracks `main`, so a change cannot be looked at
live before it merges; deploy a branch on purpose with `workflow_dispatch` when
that is what you want.

**`keepalive.yml` keeps the DATABASE from being paused, and is the reason the
app was once down for a day.** The Supabase project pauses after about a week
with no database activity; when it does, its hostname stops resolving, every
database-backed route fails, and nobody can sign in — which is exactly what
happened on 2026-08-29 (the church read Cloudflare's own `error code: 1016` on
the sign-in card, because the app forwarded it verbatim; that half is fixed
too, see `SERVICE_UNAVAILABLE` in `lib/server/db.ts`). So every third day at
noon Malaysia time this asks the LIVE site for `GET /api/church` — a real read
of a real table through the deployed Worker, needing no secret of its own
because that endpoint is public by design. It retries five times before
failing, so a project still waking (Cloudflare answers 521 for a minute or two)
is not reported as down. It doubles as the app's only uptime check: a red run
emails whoever owns the repo, rather than the church finding out on a Sunday
morning. **It is a mitigation, not a fix** — Supabase decides what counts as
activity and may change it, and GitHub may delay or skip a scheduled run under
load, which every-third-day survives once but not twice. The real fix is a plan
that does not pause; failing that, move the cron to daily (this repository is
public, so Actions minutes are free).

---

## 测试覆盖面（哪一条规则由哪个断言守着）

> 从 `CLAUDE.md` 原样搬来。命令与分层总表在 `docs/PROJECT_PROFILE.md`，
> 怎么跑与陷阱在 skill `church-testing`。

Testing layers (in `apps/web`):
- `npm test` — Vitest unit tests (labels, rules, perms, i18n dictionaries, the
  theme catalogue + its colour validation, **which of a member's two names is
  drawn** (`names.test.ts`: the congregation's own preference, "either one
  alone" beating it, and every unknown-hall path falling back to Chinese) and
  the searched-but-never-drawn `ComboOption.search` beside it, the **role drift
  guard** — every
  `ChurchRole` / `DisplayRole` value named in all three dictionaries, coloured in
  `ROLE_TAG`, and offered by **exactly one** of the three role-option lists /
  filtered on **exactly one** of the pages that lists it (0031: the three lists
  must cover the enum AND not overlap, so a form can never create what another
  page owns), that a form offers the list its own row's role lives in so a
  `<select>` is never blank, and that `isMemberRole` splits the enum the way
  the dashboard and 需要关怀 rely on (with an unknown role reading as a member,
  the safe direction) — its own analogue
  for `AccountRole` (every value named in all three dictionaries with both a
  bare label and a dropdown option, offered in `ACCOUNT_ROLE_OPTIONS`, coloured
  by `accountRoleClass`) — and the import
  planner: its name-pair key, its three-language header/enum matching, every row
  it refuses, 推荐人 resolved by name pair (and refused when it names nobody, two
  people, or the row's own person), the one column that holds a list —
  服侍岗位 read out of a single cell whatever the church separated it with —
  and 教会身份 accepting every role the app ships while refusing the one
  pairing the database forbids (a BEST in a life group, whether the row says so
  itself or the church already had them as one)).
- `npm run test:api-e2e` — API end-to-end against the live Worker (auth, role
  matrix, full CRUD, **a member created under each of the five church roles** —
  the assertion that would have caught the database enum being two values short
  — a 地址 and a 推荐人 written and read back through the self-referencing embed,
  the public forms — the training sign-up and the member self-registration,
  which now round-trips a 推荐人/life group/服侍岗位/备注 it names (0128, the
  bootstrap it reads them from carrying nothing but names) while still
  refusing a `church_role` and a `group_position` exactly as before, its
  Chinese-name-only + phone-tiebreak matching (`matchRegistrant`, not
  `pairKey`) proven with two members sharing a Chinese name — a matching
  phone updates the right one, a non-matching phone creates a third rather
  than guessing — a
  member import with its refusals, a member's 服侍岗位 written
  and read back, `joined_at`(来访日期)/`group_joined_at`(加入小组日期)/`notes`(备注)
  round-tripped on the same `PATCH` and reread from a fresh `GET`, the
  group-scoped
  roll-call sheet: its rows are one roster, a Sunday ticked through it shows up
  on the UNSCOPED sheet, and a hall-pinned account cannot reach another
  congregation's group with `group_id`, and a full **`group_leader` account
  lifecycle**: promoting a fixture member to 小组长 provisions a real
  `app_users` row (role/hall/group all asserted) and returns a password that
  actually signs in; that session gets `403` on an out-of-scope path
  (`/trainings`) and stays narrowed to its own group on `GET /members` /
  `GET /groups` even when the request itself asks for a different one;
  demoting disables the account and the same password can no longer sign in;
  a promotion with no email on file is a named, non-blocking event; all
  self-cleaning).
- `npm run test:ui-e2e` — **browser UI end-to-end**: drives the real site in
  Chromium and asserts each interaction's expected outcome (login, search,
  filters, modals, weekly attendance, a 主日 tick→untick round-trip on the
  roll-call sheet and the same for a hand-added meeting's own column,
  discipleship day-notes, the life-group card's one column per Sunday with its
  三 sub-ticks 小组/会前/主日 (its tick round-trip driven only on the group's
  own 小组 sub-tick — the 会前/主日 beside it are the congregation's real
  record), a
  培训&活动 catalog listing both shapes with no filter, plus an
  activity's single-column roll call and its time/place, a paid 培训's fee
  block and the receipt link beside Approve (with a free one proving the same
  fields are absent), a column check-all on both sheets, the roll-call sheet's
  per-occasion totals `<tfoot>` (and the absence of a per-person total column), a
  member combobox typed→filtered→picked, an interface-language round-trip, the
  absence of the 守望模块 manager in the UI *and* on the server, an add-on
  module off→on cycle on 教会设置, a theme preset picked there and the sidebar
  repainting under it, a create→delete member write-cycle carrying a 服侍岗位
  through the shared `TagsInput` — typed and then saved **without pressing
  Enter**, which is the path that silently lost it — onto the member page's
  badges and the members page's ministry filter, the member form NOT offering
  访客 or BEST (0031 — it makes members) while still offering the ranks it does,
  and a 推荐人 combobox defaulting to 无推荐人, the whole **成员/访客 split** end
  to end — a 访客 listed on `/visitors` with the 来访日期 the members list no
  longer carries and absent from `/members`, that page's role filter offering
  neither 访客 nor BEST, 转为成员 on the person's own page asking first and
  saying what survives the change, then the button and the visit date both
  going away once it is done, and `/welcome` rendering with no session and
  asking a stranger nothing about a life group or a ministry,
  a 聚会's 地点 typed into its form and stored on the
  row, a member row showing exactly ONE name — the one that
  congregation reads them by — with no second line under it while a search
  still finds them by the name it does not show, the canonical mobile tile
  (one tag on the first row beside the name, the leader and the member count
  each on a line of their own), a 幸福小组 roster row with no editable role,
  a tag on whoever on it is not one of the church's own members and none on
  anybody else, and View beside Remove,
  the members page's import modal opening on a file field and a
  template with nothing written yet, `/join` rendering with no session at
  all, its photo field taking camera OR gallery, the dashboard's New
  Visits/Active Members trend card (its two toggle chips, each hiding its own
  line) and its upcoming-events table and single Total Active Members KPI
  tile replacing the old four-tile row and its two cards, the member detail
  page's facts grouped under labelled sections rather than one long grid, a
  discipleship pair reading as "Led by X" on the trainee's own member page,
  a life group's roster row opening the shared member-edit modal from its
  own **Edit** button, and promoting a member with an email to 小组长 through
  the group detail page's own leadership picker showing the one-time
  credential MODAL (email + a sensible-length generated password) with a
  working copy button, rather than a toast that would vanish before anyone
  could copy it).
  The check-all round trip is driven **only on a meeting column this run
  created** — never on a Sunday, whose ticks are the congregation's real
  attendance and would be genuinely deleted.
  It restores anything it changes — including the module states and the
  church's theme, which it reads first and puts back in a `finally`.
  **Every assertion in it reads ENGLISH labels, so the run pins the account's
  interface language to `en` immediately after login** and hands the church's
  own choice back in that same `finally` (this account runs in 简体中文 day to
  day). That pin is captured ONCE, at login, before anything English-reading
  executes — the 语言 module further down must never re-read it, or the restore
  would hand back the pin instead of the church's real setting. The login check
  itself is therefore language-INDEPENDENT (it waits on `.sidebar`, which exists
  on every signed-in page and never on `/login`): waiting on the dashboard's own
  translated `<h1>` made the very first check silently require English, so the
  day the church switched to Chinese the whole suite died there, 90s of retries
  deep, reporting what looked like a broken login.
  **Both e2e scripts end by deleting every fixture-named row in the church**
  (`ZZ_UITEST_…` / `E2E…`), whichever run created it — the registered-fixture
  sweep can only see this process's own rows, so residue from a run that died
  used to accumulate on the live database. It runs on the crash path too, and
  residue that survives it is a FAILED CHECK: a run that leaves data behind has
  not passed, whatever its assertions said. It runs a tiny in-process reverse proxy so the browser
  works even behind an egress proxy. `UI_E2E_PASSWORD` is required (never
  hardcode a real password); `UI_E2E_URL` / `UI_E2E_EMAIL` are optional. In this
  sandbox run it as:
  `NODE_USE_ENV_PROXY=1 PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome UI_E2E_PASSWORD=… npm run test:ui-e2e`.
  When you add/rename a page or a key interaction, add a matching check to
  `scripts/ui-e2e.mjs`.
  **This script is only valid against the build it is checked out from.** The
  site has one shared URL, so an old script pointed at a newer deploy reports
  moved selectors as "failures" — which is why the script can be handed
  `UI_E2E_EXPECT_BUILD`, waits for `/api/version` to report that build, and
  **skips with exit 0** if a newer deploy overtook it. Never "fix" a red run by
  loosening a selector before checking which build it actually tested.
  **It no longer runs in CI on its own** (`ui-e2e.yml` is `workflow_dispatch`
  only): every automatic run pulled ~300MB of Chromium to re-check what a
  laptop checks for free. Running it before a push is golden rule **G0**, and
  it is now the ONLY thing checking the app through a browser — the deploy
  gate is the API E2E, which never opens one.
- `npm run ui:shots` — **screenshot sweep**: captures every list page at a phone
  and a desktop viewport into `$OUT` (default `/tmp/shots`; `WIDE=1` for
  desktop). A local tool for looking at a layout change with your own eyes —
  ui-e2e proves the pages *work*, it cannot see that two pages lay their header
  out differently. **CI does not run it and collects no artifacts**: the
  workflow's job is finding bugs, and nobody was reading the images.

---
