import { HallNameDisplay } from '@tog/shared';

/**
 * Which of a person's TWO names (migration 0018) is shown.
 *
 * Every list used to draw BOTH, the Chinese name with the English one stacked
 * under it. The church's own feedback is that this reads as noise: a
 * congregation knows its people by ONE name, and which name that is depends on
 * the congregation (0028) — 中文堂 reads 张伟, 英文堂 and 马来文堂 read David.
 *
 * The pair is still the person's IDENTITY: the unique index is on both names
 * together, the importer still matches on the pair, a search still matches
 * either name, and both are still stored, edited and exported. Only what is
 * DRAWN narrowed — the same shape as the 来访日期 rename (rule G8), a display
 * decision that stops at the API boundary.
 */
export type NameShape = { full_name: string; english_name?: string | null };

/**
 * The one name to draw for this person, in this congregation.
 *
 * "Either one alone" beats the preference every time: a congregation reading
 * by English name still has to show 张伟 for the member who has no English
 * name, because the alternative is drawing nothing at all. That case is the
 * ordinary one rather than an edge — plenty of people have no English name,
 * which is exactly why that column is nullable.
 *
 * `prefer` is the member's OWN hall's setting, so a person reads the same on
 * every screen in the app rather than changing with whoever is looking. When
 * it is unknown — a public page with no session, a payload that carries no
 * hall, a database still waiting on 0028 — it falls back to the Chinese name,
 * which is what every congregation showed before any of this existed.
 */
export function memberDisplayName(
  member: NameShape | null | undefined,
  prefer?: HallNameDisplay | null,
): string {
  if (!member) return '';
  const zh = (member.full_name ?? '').trim();
  const en = (member.english_name ?? '').trim();
  if (!en) return zh;
  if (!zh) return en;
  return prefer === HallNameDisplay.English ? en : zh;
}

/**
 * The name NOT being drawn, or `null` when there is only one.
 *
 * Nothing renders this — it is what keeps a person findable by the name their
 * own congregation does not show them by: the member combobox searches it, so
 * "John" still finds the 陈约翰 filed in 中文堂.
 */
export function memberAltName(
  member: NameShape | null | undefined,
  prefer?: HallNameDisplay | null,
): string | null {
  if (!member) return null;
  const shown = memberDisplayName(member, prefer);
  const zh = (member.full_name ?? '').trim();
  const en = (member.english_name ?? '').trim();
  const other = shown === en ? zh : en;
  return other && other !== shown ? other : null;
}

/**
 * Resolve a hall id to what it reads by, from the halls the session can see.
 *
 * Deliberately tolerant at both ends: a member with no hall on their payload
 * and a hall id that answers to nothing both mean "nobody has said", which is
 * the Chinese name rather than an error — a name is not a place to surface a
 * missing join (rule G6).
 */
export function hallNameDisplay(
  halls: readonly { id: string; name_display?: HallNameDisplay | null }[] | null | undefined,
  hallId: string | null | undefined,
): HallNameDisplay {
  if (!hallId || !halls) return HallNameDisplay.Chinese;
  const hall = halls.find((h) => h.id === hallId);
  return hall?.name_display === HallNameDisplay.English
    ? HallNameDisplay.English
    : HallNameDisplay.Chinese;
}
