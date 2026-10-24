import crypto from 'node:crypto';
import { all, get, run, insert, type DB, type Row } from './db.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
export const bad = (m: string, d?: unknown) => new HttpError(400, m, d);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const forbidden = (m = 'Forbidden') => new HttpError(403, m);
export const conflict = (m: string) => new HttpError(409, m);

export type Role = 'owner' | 'admin' | 'staff' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 0, staff: 1, admin: 2, owner: 3 };
export interface Ctx { db: DB; bid: number; uid: number | null; role: Role; }

export const DEFAULT_SETTINGS = {
  payment_terms_days: 14,
  estimate_valid_days: 30,
  invoice_notes: '',
  estimate_terms: '',
  invoice_terms: '',
  payment_instructions: '',
  prices_include_tax: false,
  default_tax_ids: [] as number[],
  template: 'minimal' as 'minimal' | 'editorial' | 'creative' | 'formal',
  accent: '#1f4e5f',
  payment_methods: ['E-transfer', 'Bank transfer', 'Cash', 'Cheque', 'Card (processed elsewhere)', 'Other'],
  reminders: { enabled: false, offsets: [-3, 0, 7, 14] as number[] },
  rate_card: { title: 'Rate Card', intro: '', conditions: '', terms: '', validity_days: 90, show_unit: true, show_descriptions: true, show_deliverables: true },
  public_link_days: 30,
  statement_of_work_note: 'This statement of work describes the scope of the engagement. It is not a legally binding contract in every jurisdiction; seek legal advice if you need one.',
};
export type Settings = typeof DEFAULT_SETTINGS;

export function getSettings(db: DB, bid: number): Settings {
  const r = get(db, 'SELECT settings FROM businesses WHERE id = ?', bid);
  if (!r) throw notFound('Business');
  const s = JSON.parse(r.settings || '{}');
  return { ...DEFAULT_SETTINGS, ...s, reminders: { ...DEFAULT_SETTINGS.reminders, ...(s.reminders ?? {}) }, rate_card: { ...DEFAULT_SETTINGS.rate_card, ...(s.rate_card ?? {}) } };
}
export function saveSettings(db: DB, bid: number, patch: Partial<Settings>) {
  const cur = getSettings(db, bid);
  const next = { ...cur, ...patch, reminders: { ...cur.reminders, ...(patch.reminders ?? {}) }, rate_card: { ...cur.rate_card, ...(patch.rate_card ?? {}) } };
  run(db, 'UPDATE businesses SET settings = ? WHERE id = ?', JSON.stringify(next), bid);
  return next;
}

export function audit(c: { db: DB; bid: number | null; uid: number | null }, entity: string, entityId: number | null, action: string, detail?: unknown) {
  insert(c.db, 'INSERT INTO audit_events (business_id, user_id, entity, entity_id, action, detail) VALUES (?,?,?,?,?,?)',
    c.bid, c.uid, entity, entityId, action, detail === undefined ? null : JSON.stringify(detail));
}

/** Atomically allocate the next number in a sequence. Must be called inside tx(). */
export function nextNumber(db: DB, bid: number, kind: 'invoice' | 'estimate' | 'credit_note' | 'receipt'): string {
  const seq = get(db, 'SELECT * FROM number_sequences WHERE business_id = ? AND kind = ?', bid, kind);
  if (!seq) throw new Error(`No numbering sequence for ${kind}`);
  const r = run(db, 'UPDATE number_sequences SET next_number = next_number + 1 WHERE business_id = ? AND kind = ? AND next_number = ?', bid, kind, seq.next_number);
  if (Number(r.changes) !== 1) throw conflict('Numbering sequence changed concurrently; retry');
  return `${seq.prefix}${String(seq.next_number).padStart(seq.padding, '0')}`;
}

export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

export function today(tz?: string): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = (m - 1) + n; const ny = y + Math.floor(total / 12); const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

export function bizToday(db: DB, bid: number) { const b = get(db, 'SELECT timezone FROM businesses WHERE id = ?', bid); return today(b?.timezone); }

/** Input coercion helpers for validated request bodies. */
export const str = (v: unknown, max = 5000): string | null => { if (v === undefined || v === null) return null; const s = String(v).trim(); if (s.length > max) throw bad(`Text too long (max ${max})`); return s || null; };
export const reqStr = (v: unknown, field: string, max = 500): string => { const s = str(v, max); if (!s) throw bad(`${field} is required`); return s; };
export const int = (v: unknown, field: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number | null => {
  if (v === undefined || v === null || v === '') { if (opts.optional) return null; throw bad(`${field} is required`); }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n)) throw bad(`${field} must be a whole number`);
  if (opts.min !== undefined && n < opts.min) throw bad(`${field} must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw bad(`${field} must be at most ${opts.max}`);
  return n;
};
export const bool = (v: unknown): number => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
export const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string, dflt?: T): T => {
  if ((v === undefined || v === null || v === '') && dflt) return dflt;
  if (!allowed.includes(v as T)) throw bad(`${field} must be one of: ${allowed.join(', ')}`);
  return v as T;
};
export const optDate = (v: unknown, field: string): string | null => { if (v === undefined || v === null || v === '') return null; if (!isDate(v)) throw bad(`${field} must be YYYY-MM-DD`); return v; };
export const currencyCode = (v: unknown, dflt: string): string => { const s = (str(v, 3) ?? dflt).toUpperCase(); if (!/^[A-Z]{3}$/.test(s)) throw bad('Currency must be a 3-letter code'); return s; };

export function ensureOwned(db: DB, table: string, id: unknown, bid: number, label = table): Row {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) throw bad(`${label} id invalid`);
  const r = get(db, `SELECT * FROM ${table} WHERE id = ? AND business_id = ?`, n, bid);
  if (!r) throw notFound(label);
  return r;
}
export { all, get, run, insert };
