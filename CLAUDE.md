# TOG（主恩堂）Codebase Guide & Golden Rules

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
because a duplicate pair is a real user-facing outcome and not a bug. On screen
the two names are ONE component — `<MemberName />` — the Chinese name with the
English one under it, smaller and muted, and nothing extra when there is none:
every table, every mobile tile, every roll-call row, every namelist, the
account list and the member `Combobox` (whose options carry the English name as
their `sub`, searched as well as shown) go through it, so a person looks the
same everywhere. A search matches EITHER name, case-insensitively — the
members list, `comboboxFilter`, and `GET /api/members?q=`. Neither roll-call
sheet has a search box of its own: 全员到齐 and the totals row cover everybody
on screen, and narrowing what is DRAWN while those two still act on everybody
reads as a contradiction, so both sheets simply list the whole roster, always.
The three places a name stays on one line are a relay-chart
node, the lineage badges and a 铁三角 seat, each a fixed box whose geometry the
second line would break; each says so in a comment.

**教会身份 is FIVE values, and the fifth is 访客** (migration 0021). `church_role`
runs 牧师 → 执事 → 同工 → 一般成员 → **访客**, in reading order. A visitor is a
ROLE rather than a status — "visitor" is what somebody is to the church, not
whether their record is active, so a visitor who stops coming is an *inactive
visitor* and both facts survive; and like every other church-wide role it is
read **ahead of** any group position, because a visitor sitting in on a life
group is still a visitor. Its badge is a warm sand no rank uses, so it cannot be
mistaken for 普通成员's cool grey or 未分组's warm grey. The reason this needed a
migration at all is worth remembering: `deacon` and `co_worker` had been in the
CODE enum since the day they shipped while the DATABASE type held neither, so
saving a member as 执事 did not degrade — it failed outright, and nothing
noticed, because the two lists were never compared. They are now: a unit test
(`labels.test.ts`) asserts every `ChurchRole` / `DisplayRole` value has a label
in all three dictionaries, an entry in `ROLE_TAG`, a place in the form's options
and in the members-list filter; and `api-e2e.mjs` creates a member as **each**
role against the live database, which is the half a unit test cannot reach.

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
re-import cannot un-serve the whole church.

*自助注册* (`/join` + `GET`/`POST /members/register`) is the public link the
church hands out — the fourth shell-less page, and the only public path under
`/members`. Its field set now mirrors the staff-facing add-member form
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
福友) + weekly attendance tracked **by week number, not by calendar date**. A
福友 needs no special handling anywhere: it is simply a member whose
`church_role` is 访客 (0021), so the roster picker is the ordinary member
`Combobox` over every member, unfiltered. `happiness_terms.weeks` (1–52,
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
check-all/clear-confirms-first rules, same totals `<tfoot>`. Like 守望, it is a
toggleable add-on module (`church_modules`, `MODULE_HAPPINESS` in
`OPTIONAL_MODULES`, 404 when off) — but unlike 守望's `/d/[token]` mentor form,
it has **no public-facing page at all**: roster and roll call are staff/leader
only.

**期号 is server-assigned, not typed** (church feedback: a term just needs a
name). The term form (`happiness/page.tsx`) asks only for 名称 (now required)
and 周数; `POST /happiness/terms` fills `term_no` itself — one past the
highest on record — when the client sends none, so it still sorts and reads
the way `happy.term.pageTitle` ("第 {no} 期") always has. The term detail
card dropped 期号 as a fact (it is the page's own title already) and no
longer collapses 起止日期 into one string — 开始/结束 are their own rows.
**Editing and deleting a 幸福小组 now live on the GROUP's own detail page**
(`/happiness/group/[groupId]`), not on the term's list: that list (both the
desktop table and the mobile tile) is nav-only now, matching `/groups`'s own
list exactly (rule G4) — a row/tile opens the group, full stop. The group
page's own top-left card is an editable form (名称/hall/组长/星期/时间/地点)
with its own Save/Delete, replacing the read-only 期号+聚会安排 text it used
to show; the roll-call card moved above it, roll-call-first, the same order
`/groups/[id]` already uses. **A roster row's role is its own fact**
(`happiness_group_members.role`, migration 0027) — free text (组长/组员/…),
editable inline, committed on blur — and is deliberately NOT
`members.church_role`/`group_position`: those belong to the church-wide
membership and the life-group membership respectively, neither of which this
church's own use of 幸福小组 role means the same thing. **Adding a roster
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

**The dashboard (`/`) is three sections, not four KPI tiles and two cards.**
The first is a hand-rolled SVG line chart — this app has no charting library
and does not gain one, the same convention every other "chart" here follows —
plotting **New Visits** (members whose 来访日期/`joined_at` falls in a given
month, visitor and member alike: a visit is when someone first came, not what
they are today) against **Active Members** (members active and non-visitor
TODAY whose `joined_at` falls on or before that month — a defensible
cumulative growth curve, and said so in a code comment, since it is NOT a real
historical reconstruction: status and role are only known as of now, never as
of each past month) over the trailing six months. Both series are one pure,
unit-tested function, `monthlyVisitAndActiveTrend` in `lib/dashboard.ts`,
built on `churchParts` per rule G6a rather than the runtime's own clock. Two
independent toggle `chip`s — the same pattern `/discipleship`'s own state
filter already uses (rule G4), not new toggle markup — show or hide each
series, both on by default; toggling both off reads as a small empty state
rather than a blank chart box. Below it, the old card-list-of-5 upcoming
events is now an actual table, desktop table + mobile tile pair like every
other list in this app (rule G7). Below THAT is a single KPI tile, **Total
Active Members** — active and non-visitor, the SAME headline definition of
"active" the chart's own line uses, so the page never states "active member"
two different ways on one screen. The old KPI row (成员总数/在册/即将聚会/**门训
进行中**), the 身份分布 bar chart and the 守望进度 card are gone entirely.

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

Run before every push: `npm run --workspace @tog/web -s build` (or in
`apps/web`: `npx tsc --noEmit && npm test && npm run build`). Deploys are gated
on unit tests + a post-deploy smoke test (`.github/workflows/deploy.yml`).
**`deploy.yml` fires on a push to `main` — i.e. on a merge — and on manual
dispatch, nothing else.** Iterating on a branch is not a release, and it used to
deploy (and run the browser suite) on every commit of a branch in flight. The
trade is that the shared URL tracks `main`, so a change cannot be looked at
live before it merges; deploy a branch on purpose with `workflow_dispatch` when
that is what you want.

Testing layers (in `apps/web`):
- `npm test` — Vitest unit tests (labels, rules, perms, i18n dictionaries, the
  theme catalogue + its colour validation, the **role drift guard** — every
  `ChurchRole` / `DisplayRole` value named in all three dictionaries, coloured in
  `ROLE_TAG`, offered by the form and by the members filter — its own analogue
  for `AccountRole` (every value named in all three dictionaries with both a
  bare label and a dropdown option, offered in `ACCOUNT_ROLE_OPTIONS`, coloured
  by `accountRoleClass`) — and the import
  planner: its name-pair key, its three-language header/enum matching, every row
  it refuses, 推荐人 resolved by name pair (and refused when it names nobody, two
  people, or the row's own person), and the one column that holds a list —
  服侍岗位 read out of a single cell whatever the church separated it with).
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
  badges and the members page's ministry filter, the member form offering 访客
  and a 推荐人 combobox defaulting to 无推荐人, a 聚会's 地点 typed into its form and stored on the
  row, a member row showing BOTH of a person's names, the members page's import modal opening on a file field and a
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
  **This script is only valid against the build it was checked out from.** The
  site has one shared URL, and a deploy can be dispatched from a branch, so an
  old script pointed at a newer deploy reports moved selectors as "failures". CI therefore pins the checkout to the deployed SHA
  (`ref: github.event.workflow_run.head_sha`) and passes
  `UI_E2E_EXPECT_BUILD`; the script waits for `/api/version` to report that
  build and **skips with exit 0** if a newer deploy overtook it. Never "fix" a
  red automatic run by loosening a selector before checking which build it
  actually tested.
- `npm run ui:shots` — **screenshot sweep**: captures every list page at a phone
  and a desktop viewport into `$OUT` (default `/tmp/shots`; `WIDE=1` for
  desktop). A local tool for looking at a layout change with your own eyes —
  ui-e2e proves the pages *work*, it cannot see that two pages lay their header
  out differently. **CI does not run it and collects no artifacts**: the
  workflow's job is finding bugs, and nobody was reading the images.

---

## GOLDEN RULES — every auditor / code reviewer MUST check these

These are hard requirements for this codebase. A change that breaks one is a
review finding, not a preference. Cite the rule number in the finding.

### G1 — CRUD completeness on every management page
Every entity page (成员、小组、聚会（点名表上的一列）、培训&活动（培训与活动两种形态）、四十天守望模块与配对、幸福小组的期与小组、账户) must offer
the full set its users need: **Create, Read, Update, Delete**. If the API supports an
operation, the UI must expose it (or the omission must be a deliberate,
documented decision). A page that can only create + list is incomplete.
The documented exception: 教会设置 (`/church`) is read + update only — the
church row is a seeded singleton (one deployment, one church) and the module
catalog is code, so neither can be created or deleted from the UI. 成员 has two
extra CREATE paths beside its form — a spreadsheet import and the public
self-registration link — and both are create-or-update on the name pair rather
than a second way to make duplicates.

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
  self-registration form — that exact path and those two methods only, never a
  prefix, so nothing else under `/members` is opened by it), **`GET
  /api/church`** (the login card and the public forms render the church's name
  before anyone signs in; writes stay super_admin) (+ `/api/auth/*`) — each a
  narrow, specific handler reading an allow-list of fields.

### G3 — Every destructive action shows a confirmation
Any delete/remove/detach/irreversible action (`api.delete(...)`, or a mutation
like 移除/清空/重置 that discards data) MUST go through the shared
`useConfirm()` dialog (`components/ui.tsx`) with `danger: true`. Native
`window.confirm` is not allowed. No silent destructive taps.

### G4 — One mechanism, not per-page reimplementations (altitude)
Reuse the shared primitives instead of re-rolling them per page:
`Modal`, `Field`, `PasswordInput`, `useConfirm`, `useToast`, `RoleBadge`,
`Avatar`, `MemberName` (**every** rendering of a person's name — one component
draws the Chinese name and the English one under it, so no page invents its own
two-line shape or forgets the second name), `PairProgressModal`,
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

### G7 — Mobile-first & theme
Tables become list tiles on small screens (`.only-desktop` / `.only-mobile`
helpers). Two-column layouts collapse to a single full-width column on tablet
and below. **Light theme only** — no dark-mode branches, no `data-theme` code,
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

## Reviewer output
Report findings most-severe first. Correctness/security (G2, G3, G6) outrank
CRUD gaps (G1) which outrank cleanup/altitude (G4, G5, G8, G9). Every finding
cites a concrete failure scenario and, where applicable, the golden-rule number.
