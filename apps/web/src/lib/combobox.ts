/**
 * The matching rules behind the shared `<Combobox />` (`components/ui.tsx`).
 *
 * Kept out of the component so they can be unit-tested on their own: a member
 * picker that silently stops matching is the kind of thing nobody notices until
 * the church has 400 people in the list.
 */

export interface ComboOption {
  /** The stored code that is saved — never a translated label (rule G8). */
  value: string;
  /** What the user reads and types against. */
  label: string;
  /** A second line under the label, searched as well as shown. */
  sub?: string | null;
  /** Secondary text (a role, a group…), searched as well as shown. */
  hint?: string;
  /**
   * Matched but never DRAWN — the only field here that is search-only.
   *
   * A member picker puts their other name in it (0018/0028): every list now
   * shows ONE name, the one their own congregation reads them by, but a person
   * must still be findable by the name it doesn't show. Typing "John" has to
   * reach the 陈约翰 filed in 中文堂, and typing 陈约翰 has to reach the same
   * person if they sit in 英文堂 and read as "John" on screen.
   *
   * It is separate from `sub` precisely because `sub` renders: putting the
   * other name there would put both names back on screen, which is the thing
   * 0028 removed.
   */
  search?: string | null;
}

/**
 * Case- and order-insensitive AND-matching over the label, its second line and
 * its hint.
 *
 * Every whitespace-separated word of the query has to appear somewhere, so
 * "chen elder" finds 陈牧师 filed as "陈 · Elder" whichever way round it was
 * typed. An empty query matches everything — the closed picker still has to
 * offer the whole list the moment it is opened.
 */
export function comboboxFilter<T extends ComboOption>(
  options: readonly T[],
  query: string,
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((o) => {
    const hay = `${o.label} ${o.sub ?? ''} ${o.hint ?? ''} ${o.search ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Where the keyboard highlight lands next.
 *
 * Wraps at both ends (so ↑ from the top reaches the last option, which is what
 * a long member list needs), and answers -1 for an empty list so the caller
 * never highlights a row that is not drawn.
 */
export function nextActiveIndex(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}
