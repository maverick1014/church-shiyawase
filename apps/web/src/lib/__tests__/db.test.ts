import { describe, it, expect } from 'vitest';
import { HttpError, unwrap, unwrapWrite } from '@/lib/server/db';

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

describe('unwrap', () => {
  it('returns the data of a successful read', () => {
    expect(unwrap({ data: { id: 'a' }, error: null })).toEqual({ id: 'a' });
  });

  it('turns "no rows" from a .single() into a 404', () => {
    expect(status(() => unwrap({ data: null, error: { code: 'PGRST116', message: 'no rows' } }))).toBe(404);
  });

  it('turns any other database error into a 500', () => {
    expect(status(() => unwrap({ data: null, error: { code: '23505', message: 'duplicate key' } }))).toBe(500);
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
