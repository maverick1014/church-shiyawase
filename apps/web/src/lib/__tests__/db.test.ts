import { describe, it, expect } from 'vitest';
import { HttpError, unwrap, unwrapWrite, SERVICE_UNAVAILABLE } from '@/lib/server/db';

/**
 * The two ways a Supabase result is read.
 *
 * `unwrap` is for a query that asked for rows, so a null payload means the row
 * is not there. `unwrapWrite` is for a write that asked for nothing back,
 * where the SAME null payload means it worked — the distinction the 40-day
 * 补进度 got wrong: it created the pair, wrote the days, and then answered
 * 404 "Resource not found" through `unwrap`.
 */
const status = (fn: () => unknown): number | string => {
  try {
    fn();
    return 'no throw';
  } catch (e) {
    return e instanceof HttpError ? e.status : `not HttpError: ${String(e)}`;
  }
};

/** The sentence the caller is answered with — a 409 is read by a user. */
const message = (fn: () => unknown): string => {
  try {
    fn();
    return 'no throw';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe('unwrap', () => {
  it('returns the data of a successful read', () => {
    expect(unwrap({ data: { id: 'a' }, error: null })).toEqual({ id: 'a' });
  });

  it('turns "no rows" from a .single() into a 404', () => {
    expect(status(() => unwrap({ data: null, error: { code: 'PGRST116', message: 'no rows' } }))).toBe(404);
  });

  it('turns any other database error into a 500', () => {
    expect(status(() => unwrap({ data: null, error: { code: '23503', message: 'fk violation' } }))).toBe(500);
  });

  /* The regression this file exists for as much as any.
     A 500 is never something the person at the keyboard did, and the text that
     comes back from below is written for a developer: a Postgres constraint,
     a PostgREST code — or, the day the church could not sign in, Cloudflare's
     own "error code: 1016" from in front of an unreachable database. That
     string was thrown as the HttpError's message, answered as the body of the
     500, and printed on the sign-in card. Nothing upstream may reach a reader. */
  it('never lets the raw database text reach the reader', () => {
    const cases = [
      { code: undefined, message: 'error code: 1016' },
      { code: '23503', message: 'insert or update on table "members" violates foreign key constraint "members_hall_id_fkey"' },
      { code: 'PGRST200', message: "Could not find a relationship between 'members' and 'referred_by'" },
      { code: '42P01', message: 'relation "public.happiness_terms" does not exist' },
    ];
    for (const error of cases) {
      expect(status(() => unwrap({ data: null, error }))).toBe(500);
      expect(message(() => unwrap({ data: null, error }))).toBe(SERVICE_UNAVAILABLE);
    }
  });

  /* And the sentence that replaces it has to be worth reading: it says what
     happened in the church's terms and what to do next, and names no table,
     no vendor, no status code and no error number. */
  it('answers a 500 with a sentence a non-technical reader can act on', () => {
    expect(SERVICE_UNAVAILABLE).toMatch(/try again/i);
    expect(SERVICE_UNAVAILABLE).toMatch(/administrator/i);
    expect(SERVICE_UNAVAILABLE).not.toMatch(
      /supabase|postgres|cloudflare|worker|database|SQL|HTTP|\b5\d\d\b|error code|\bnull\b|_id\b/i,
    );
  });

  /* A unique violation is the one Postgres code that is a real user-facing
     OUTCOME rather than a bug: since 0018 a member is identified by the PAIR of
     names, so saving a second 张伟 with no English name is something the person
     at the keyboard did and can fix. It is mapped once, here, so every write
     that can collide answers the same way. */
  it('turns a unique violation into a 409 that names the conflict', () => {
    const dup = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "members_name_pair_key"' },
    };
    expect(status(() => unwrap(dup))).toBe(409);
    expect(message(() => unwrap(dup))).toMatch(/pair of names/i);
    // Never the raw Postgres text — it names internal columns and index names.
    expect(message(() => unwrap(dup))).not.toMatch(/duplicate key/i);
  });

  it('still says something usable for a unique index nobody has worded yet', () => {
    const dup = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "some_future_key"' },
    };
    expect(status(() => unwrap(dup))).toBe(409);
    expect(message(() => unwrap(dup))).toBe('That record already exists');
  });

  it('treats a null payload as a missing row', () => {
    expect(status(() => unwrap({ data: null, error: null }))).toBe(404);
  });
});

describe('unwrapWrite', () => {
  it('accepts the null payload a write with no .select() returns', () => {
    expect(status(() => unwrapWrite({ data: null, error: null }))).toBe('no throw');
  });

  it('still raises a real database error, with unwrap’s own mapping', () => {
    expect(status(() => unwrapWrite({ data: null, error: { code: '23503', message: 'fk violation' } }))).toBe(500);
    expect(status(() => unwrapWrite({ data: null, error: { code: 'PGRST116', message: 'no rows' } }))).toBe(404);
  });
});
