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
    throw new HttpError(
      500,
      'Missing Supabase configuration (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).',
    );
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

/** Throw a clean HTTP error when a Supabase query fails (mirrors the API). */
export function unwrap<T = Record<string, unknown>>(result: {
  data: T | null;
  error: { code?: string; message: string } | null;
}): T {
  if (result.error) {
    // PGRST116 = no rows returned for a `.single()` query.
    if (result.error.code === 'PGRST116') {
      throw new HttpError(404, 'Resource not found');
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
    throw new HttpError(500, result.error.message);
  }
  if (result.data === null) {
    throw new HttpError(404, 'Resource not found');
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
