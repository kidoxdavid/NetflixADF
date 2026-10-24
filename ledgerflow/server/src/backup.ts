import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb, all, get } from './db.ts';
import type { DB, Row } from './db.ts';
import { type Ctx } from './core.ts';
import { csvCell } from './ratecard.ts';
import { MIGRATIONS } from './schema.ts';
import { calcDocument } from './calc.ts';

const COUNT_TABLES = ['users', 'businesses', 'clients', 'rc_items', 'documents', 'document_lines', 'payments', 'payment_allocations', 'expenses', 'time_entries', 'attachments', 'audit_events'];

function counts(db: DB) { const o: Record<string, number> = {}; for (const t of COUNT_TABLES) o[t] = Number(get(db, `SELECT COUNT(*) n FROM ${t}`)!.n); return o; }
const sha256File = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Consistent online backup of the entire database (all businesses, attachments and logos live inside it). */
export function createBackup(db: DB, dir: string, label = ''): { file: string; manifest: string; sha256: string; counts: Record<string, number> } {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `ledgerflow-${stamp}${label ? '-' + label.replace(/[^\w-]/g, '') : ''}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const hash = sha256File(file);
  const c = counts(db);
  const manifest = file + '.json';
  fs.writeFileSync(manifest, JSON.stringify({ created_at: new Date().toISOString(), file: path.basename(file), sha256: hash, schema_version: MIGRATIONS[MIGRATIONS.length - 1].id, counts: c, includes: 'All businesses, users (password hashes), rate cards, documents, payments, expenses, time, attachments and logos. Does NOT include .env settings (SMTP credentials).' }, null, 2));
  return { file, manifest, sha256: hash, counts: c };
}

export interface VerifyResult { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[]; counts?: Record<string, number> }
/** Open a backup read-only and prove it is intact and internally consistent. */
export function verifyBackup(file: string): VerifyResult {
  const checks: VerifyResult['checks'] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  if (!fs.existsSync(file)) return { ok: false, checks: [{ name: 'file exists', ok: false }] };
  const mf = file + '.json';
  if (fs.existsSync(mf)) { const m = JSON.parse(fs.readFileSync(mf, 'utf8')); add('checksum matches manifest', m.sha256 === sha256File(file), m.sha256); } else add('manifest present', false, 'no .json manifest next to the backup (checksum not verified)');
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const ic = (db.prepare('PRAGMA integrity_check').all() as Row[]).map((r) => Object.values(r)[0]);
    add('sqlite integrity_check', ic.length === 1 && ic[0] === 'ok', ic.join('; '));
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    add('foreign keys consistent', fk.length === 0, `${fk.length} violations`);
    const ver = Number((db.prepare('SELECT MAX(id) m FROM schema_migrations').get() as Row).m);
    add('schema version known', ver <= MIGRATIONS[MIGRATIONS.length - 1].id, `v${ver}`);
    // financial consistency: stored totals equal recomputed totals; invoice paid equals allocations
    let bad = 0;
    for (const d of db.prepare("SELECT * FROM documents WHERE status <> 'draft'").all() as Row[]) {
      const lines = db.prepare('SELECT * FROM document_lines WHERE document_id=? ORDER BY position').all(d.id) as Row[];
      const calc = calcDocument({ lines: lines.map((l) => ({ qty_milli: l.qty_milli, unit_price_cents: l.unit_price_cents, discount_type: l.discount_type, discount_value: l.discount_value, taxes: JSON.parse(l.taxes), tax_exempt: !!l.tax_exempt, is_component: !!l.is_component })), prices_include_tax: !!d.prices_include_tax, discount_type: d.discount_type, discount_value: d.discount_value, tax_exempt: !!d.tax_exempt });
      const paid = Number((db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM payment_allocations WHERE invoice_id=? AND voided_at IS NULL').get(d.id) as Row).s);
      if (calc.total_cents !== d.total_cents || (d.type === 'invoice' && paid !== d.amount_paid_cents)) bad++;
    }
    add('document totals and balances recompute correctly', bad === 0, `${bad} mismatches`);
    const cnt: Record<string, number> = {}; for (const t of COUNT_TABLES) cnt[t] = Number((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as Row).n);
    return { ok: checks.every((c) => c.ok), checks, counts: cnt };
  } catch (e: any) { add('open and read', false, String(e.message)); return { ok: false, checks }; }
  finally { try { db?.close(); } catch { /* ignore */ } }
}

/** Replace the live database with a verified backup. The server must be stopped. The previous DB is kept alongside. */
export function restoreBackup(backupFile: string, liveDbFile: string): { previous: string; verified: VerifyResult } {
  const verified = verifyBackup(backupFile);
  if (!verified.ok) throw new Error('Backup failed verification; refusing to restore:\n' + verified.checks.filter((c) => !c.ok).map((c) => `  - ${c.name}: ${c.detail ?? ''}`).join('\n'));
  const previous = `${liveDbFile}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (fs.existsSync(liveDbFile)) fs.copyFileSync(liveDbFile, previous);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(liveDbFile + ext)) fs.rmSync(liveDbFile + ext);
  fs.copyFileSync(backupFile, liveDbFile);
  openDb(liveDbFile).close(); // runs any pending migrations on the restored copy
  return { previous, verified };
}

// ---- Business export (portability) -------------------------------------------------------------
class Zip {
  private parts: Buffer[] = []; private central: Buffer[] = []; private offset = 0;
  add(name: string, data: Buffer | string) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'); const nameB = Buffer.from(name, 'utf8'); const crc = zlib.crc32(buf);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(buf.length, 18); local.writeUInt32LE(buf.length, 22); local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(0, 28);
    this.parts.push(local, nameB, buf);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(0, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(buf.length, 20); cen.writeUInt32LE(buf.length, 24); cen.writeUInt16LE(nameB.length, 28); cen.writeUInt32LE(this.offset, 42);
    this.central.push(cen, nameB); this.offset += 30 + nameB.length + buf.length;
  }
  finish(): Buffer {
    const cd = Buffer.concat(this.central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); const n = this.central.length / 2;
    end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, cd, end]);
  }
}

function toCsv(rows: Row[], money: string[] = []): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  return '﻿' + [keys.join(','), ...rows.map((r) => keys.map((k) => (money.includes(k) && r[k] != null ? (r[k] / 100).toFixed(2) : csvCell(r[k]))).join(','))].join('\r\n') + '\r\n';
}

export function exportBusinessZip(c: Ctx): Buffer {
  const db = c.db; const b = c.bid; const z = new Zip();
  const q = (sql: string) => all(db, sql, b);
  const sets: Record<string, Row[]> = {
    clients: q('SELECT * FROM clients WHERE business_id=?'),
    client_contacts: q('SELECT * FROM client_contacts WHERE client_id IN (SELECT id FROM clients WHERE business_id=?)'),
    client_prices: q('SELECT * FROM client_prices WHERE business_id=?'),
    rate_card_categories: q('SELECT * FROM rc_categories WHERE business_id=?'),
    rate_card_items: q('SELECT * FROM rc_items WHERE business_id=?'),
    rate_card_package_components: q('SELECT * FROM rc_package_components WHERE package_id IN (SELECT id FROM rc_items WHERE business_id=?)'),
    rate_card_addons: q('SELECT * FROM rc_item_addons WHERE item_id IN (SELECT id FROM rc_items WHERE business_id=?)'),
    rate_card_history: q('SELECT * FROM rc_item_history WHERE item_id IN (SELECT id FROM rc_items WHERE business_id=?)'),
    rate_card_versions: q('SELECT * FROM rc_versions WHERE business_id=?'),
    tax_codes: q('SELECT * FROM tax_codes WHERE business_id=?'),
    projects: q('SELECT * FROM projects WHERE business_id=?'),
    estimates: q("SELECT * FROM documents WHERE business_id=? AND type='estimate'").map((d) => ({ ...d, public_token_hash: undefined })),
    invoices: q("SELECT * FROM documents WHERE business_id=? AND type='invoice'").map((d) => ({ ...d, public_token_hash: undefined })),
    credit_notes: q("SELECT * FROM documents WHERE business_id=? AND type='credit_note'").map((d) => ({ ...d, public_token_hash: undefined })),
    document_lines: q('SELECT l.*, d.number AS document_number, d.type AS document_type FROM document_lines l JOIN documents d ON d.id=l.document_id WHERE d.business_id=?'),
    billing_stages: q('SELECT * FROM billing_stages WHERE estimate_id IN (SELECT id FROM documents WHERE business_id=?)'),
    payments: q('SELECT * FROM payments WHERE business_id=?'),
    payment_allocations: q('SELECT * FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE business_id=?)'),
    expenses: q('SELECT * FROM expenses WHERE business_id=?'),
    expense_categories: q('SELECT * FROM expense_categories WHERE business_id=?'),
    time_entries: q('SELECT * FROM time_entries WHERE business_id=?'),
    recurring_schedules: q('SELECT * FROM recurring_schedules WHERE business_id=?'),
    communications: q('SELECT * FROM communications WHERE business_id=?'),
    audit_events: q('SELECT * FROM audit_events WHERE business_id=?'),
    number_sequences: q('SELECT * FROM number_sequences WHERE business_id=?'),
  };
  const business = get(db, 'SELECT id, legal_name, trading_name, address, email, phone, website, registration_info, tax_registration_label, tax_registration_number, currency, timezone, locale, date_format, settings, created_at FROM businesses WHERE id=?', b)!;
  const manifest = { format: 'ledgerflow-export', version: 1, exported_at: new Date().toISOString(), business, counts: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.length])),
    notes: 'Amounts are integer minor units (cents) in JSON; CSV files show decimal currency amounts for *_cents columns. Quantities are thousandths (qty_milli); tax rates are thousandths of a percent (rate_milli). Password hashes and secrets are never exported.' };
  z.add('manifest.json', JSON.stringify(manifest, null, 2));
  z.add('data.json', JSON.stringify(sets));
  for (const [name, rows] of Object.entries(sets)) {
    if (!rows.length || ['audit_events', 'rate_card_versions'].includes(name)) continue;
    const moneyCols = Object.keys(rows[0]).filter((k) => k.endsWith('_cents'));
    const flat = rows.map((r) => { const o: Row = {}; for (const [k, v] of Object.entries(r)) if (v !== undefined && !(Buffer.isBuffer(v))) o[k] = v; return o; });
    z.add(`csv/${name}.csv`, toCsv(flat, moneyCols));
  }
  const atts = all(db, 'SELECT id, owner_type, owner_id, filename, mime, size, sha256, data FROM attachments WHERE business_id=?', b);
  z.add('attachments/index.json', JSON.stringify(atts.map((a) => ({ id: a.id, owner_type: a.owner_type, owner_id: a.owner_id, filename: a.filename, mime: a.mime, size: a.size, sha256: a.sha256 }))));
  for (const a of atts) z.add(`attachments/${a.id}-${String(a.filename).replace(/[^\w.\-]/g, '_')}`, Buffer.from(a.data as Uint8Array));
  const logo = get(db, 'SELECT logo, logo_mime FROM businesses WHERE id=?', b); if (logo?.logo) z.add(`logo.${logo.logo_mime === 'image/png' ? 'png' : 'jpg'}`, Buffer.from(logo.logo as Uint8Array));
  return z.finish();
}
void crypto;
