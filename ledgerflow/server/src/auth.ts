import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { DB } from './db.ts';
import { get, run, insert } from './db.ts';
import { randomToken, sha256 } from './core.ts';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const N = 16384, R = 8, P = 1;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const derived = await scrypt(pw, Buffer.from(salt, 'base64'), 64, { N: +n, r: +r, p: +p });
  const expected = Buffer.from(key, 'base64');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 200) return 'Password too long';
  return null;
}

const SESSION_DAYS = 14;
export function createSession(db: DB, userId: number): string {
  const token = randomToken(32);
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  insert(db, 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(token), userId, exp);
  return token;
}
export function userFromToken(db: DB, token: string | undefined) {
  if (!token) return null;
  const s = get(db, 'SELECT s.user_id, s.expires_at, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', sha256(token));
  if (!s) return null;
  if (new Date(s.expires_at as string).getTime() < Date.now()) { run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(token)); return null; }
  return { id: s.user_id as number, email: s.email as string, name: s.name as string };
}
export function destroySession(db: DB, token: string) { run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(token)); }

/** Tiny in-memory sliding-window limiter (single-process deployments). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  check(key: string): boolean {
    const now = Date.now(); const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr); return true;
  }
  reset(key: string) { this.hits.delete(key); }
}
