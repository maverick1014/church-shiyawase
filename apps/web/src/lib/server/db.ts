import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-only Supabase client for the API route handlers. Uses the service-role
 * key (full access, bypasses RLS) — never import this into client components.
 *
 * On Cloudflare Workers (OpenNext) and in `next dev`, the credentials come from
 * `process.env`. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY as Worker secrets
 * (or in .env for local dev).
 */
let client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    // Names no vendor and no environment variable: the person reading this
    // is a church secretary, and neither is theirs to fix. The detail a
    // developer needs is logged instead (rule G6 — never the key itself).
    console.error('[config] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not set');
    throw new HttpError(500, SERVICE_UNAVAILABLE);
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** A typed HTTP error the route dispatcher turns into a JSON response. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The ONE sentence a user reads when something broke on our side.
 *
 * A 500 is never something the person at the keyboard did, and never
 * something they can fix — so it says what happened in their terms and what
 * to do next, and nothing else. Raw upstream text must never take its place:
 * a database driver, PostgREST and the CDN in front of them all write for a
 * developer, and one of them ("error code: 1016") is what the church actually
 * saw when they tried to sign in.
 */
export const SERVICE_UNAVAILABLE =
  'The app cannot reach its records right now. Please try again in a few minutes — if it keeps happening, tell your church administrator.';

/** The same idea for a row that is not there. "Resource" is not a word a church uses. */
export const NOT_FOUND = 'That record could not be found. It may have been deleted.';

/** Throw a clean HTTP error when a Supabase query fails (mirrors the API). */
export function unwrap<T = Record<string, unknown>>(result: {
  data: T | null;
  error: { code?: string; message: string } | null;
}): T {
  if (result.error) {
    // PGRST116 = no rows returned for a `.single()` query.
    if (result.error.code === 'PGRST116') {
      throw new HttpError(404, NOT_FOUND);
    }
    // 23505 = unique_violation. Everything else Postgres reports is a bug or an
    // outage and stays a 500, but this one is a real user-facing OUTCOME since
    // 0018: two people filed under the same 中文名 + English-name pair, which
    // the person at the keyboard can fix by giving one of them an English name.
    // Mapped here rather than at the call site so every write that can collide
    // — the member form, the profile form, an import — answers the same way.
    if (result.error.code === '23505') {
      throw new HttpError(409, uniqueViolationMessage(result.error.message));
    }
    // EVERYTHING else is an outage or a bug, and its text is written for a
    // developer: a Postgres constraint name, a PostgREST code, or — the way
    // this rule came to be written — Cloudflare's own "error code: 1016" from
    // in front of an unreachable database, which is what the church read on
    // the login screen. None of it is the reader's to act on, and some of it
    // names internal columns, so it is LOGGED and a plain sentence is what
    // leaves the building.
    console.error('[db]', result.error.code ?? '', result.error.message);
    throw new HttpError(500, SERVICE_UNAVAILABLE);
  }
  if (result.data === null) {
    throw new HttpError(404, NOT_FOUND);
  }
  return result.data;
}

/**
 * What a 23505 is SAID to be, per index this app can actually collide on.
 *
 * Postgres names the index it refused ("duplicate key value violates unique
 * constraint \"members_name_pair_key\""), which tells a developer everything
 * and a church secretary nothing. Each entry here turns one index into the
 * sentence describing what the person did — and, where there is one, the way
 * out. An index nobody has translated yet keeps a plain sentence rather than
 * the raw text: the raw text names internal columns.
 */
const UNIQUE_VIOLATIONS: Record<string, string> = {
  members_name_pair_key:
    'Another member is already filed under this pair of names. Two people who share a Chinese name are told apart by their English names — give this one an English name, or edit the existing member instead.',
  members_one_leader_per_group: 'This group already has a leader',
  members_one_assistant_per_group: 'This group already has an assistant leader',
  members_one_intern_per_group: 'This group already has an intern leader',
  happiness_terms_no_unique: 'A term with that number already exists',
};

function uniqueViolationMessage(raw: string): string {
  for (const [index, message] of Object.entries(UNIQUE_VIOLATIONS)) {
    if (raw.includes(index)) return message;
  }
  return 'That record already exists';
}

/**
 * The same error mapping for a write that asked for nothing back.
 *
 * `insert` / `upsert` / `update` / `delete` without a `.select()` resolve with
 * `data: null` on SUCCESS — there is no representation to return, and that is
 * the point. `unwrap` reads that null as "no such row" and turns a completed
 * write into a 404: the 40-day backfill created its pair, wrote the days, and
 * then answered "Resource not found", so the page reported failure for work
 * that had actually been done. Only the error is meaningful here.
 */
export function unwrapWrite(result: {
  data: unknown;
  error: { code?: string; message: string } | null;
}): void {
  // Delegate rather than re-deciding which code maps to which status, so the
  // two can never drift.
  if (result.error) unwrap({ data: null, error: result.error });
}

export function json(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
