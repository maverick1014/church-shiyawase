import { HttpError } from './db';

/**
 * Server-side auth for the API route handlers. Sessions are signed cookies
 * (HMAC-SHA256) — the signing key is derived from the Supabase service-role
 * secret that already lives as a Worker secret, so no extra secret is needed.
 * Passwords are PBKDF2-HMAC-SHA256. All primitives use Web Crypto, which is
 * available on both the Workers runtime and Node 20+.
 */

const COOKIE = 'tog_session';
const enc = new TextEncoder();
const PBKDF2_ITERS = 100_000;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str: string) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function keyMaterial(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  if (!k) throw new HttpError(500, '缺少会话签名密钥');
  return `tog-session::${k}`;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(keyMaterial()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface Session {
  sub: string; // account id
  role: string; // account_role
  member: string | null;
  /** Hall this account is scoped to; null = 全堂权限 (all halls). */
  hall: string | null;
  name: string;
  exp: number;
}

const WEEK = 60 * 60 * 24 * 7;

export async function signSession(
  payload: Omit<Session, 'exp'>,
  ttlSec = WEEK,
): Promise<string> {
  const body: Session = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const data = b64url(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(),
    fromB64url(sig),
    enc.encode(data),
  );
  if (!ok) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(fromB64url(data))) as Session;
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

async function pbkdf2(pw: string, salt: Uint8Array<ArrayBuffer>, iterations: number, lenBytes: number) {
  const mat = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    mat,
    lenBytes * 8,
  );
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(pw, salt, PBKDF2_ITERS, 32);
  return `pbkdf2$${PBKDF2_ITERS}$${b64url(salt)}$${b64url(bits)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromB64url(parts[2]);
  const expected = fromB64url(parts[3]);
  const bits = new Uint8Array(await pbkdf2(pw, salt, iterations, expected.length));
  return timingSafeEqual(bits, expected);
}

export function sessionCookie(token: string, maxAge = WEEK): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readCookie(req: Request): string | null {
  const h = req.headers.get('cookie') ?? '';
  const m = h.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export async function getSession(req: Request): Promise<Session | null> {
  const t = readCookie(req);
  return t ? verifySessionToken(t) : null;
}
