import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, get, run, insert, tx } from './db.ts';
import type { Row } from './db.ts';
import { type Ctx, bad, audit, sha256 } from './core.ts';
import { parseMoney, parseQty } from './money.ts';
import { createItem, updateItem, saveCategory, COMMON_UNITS } from './ratecard.ts';

export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => ({ d, n: first.split(d).length - 1 }));
  return counts.sort((a, b) => b.n - a.n)[0].n > 0 ? counts[0].d : ',';
}
export function parseCsv(text: string, delim?: string): string[][] {
  text = text.replace(/^﻿/, '');
  const d = delim ?? detectDelimiter(text);
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === '') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export const IMPORT_FIELDS = ['name', 'category', 'unit', 'rate', 'short_desc', 'long_desc', 'sku', 'pricing_type', 'min_qty', 'min_amount', 'currency', 'kind', 'delivery_time', 'revisions', 'included', 'exclusions', 'internal_notes'] as const;
const HEADER_HINTS: Record<string, RegExp> = {
  name: /^(service|name|item|title|product|offering|service name)$/i, category: /categor|type|group|section/i, unit: /^(unit|per|billing|basis|billed|pricing unit)/i,
  rate: /rate|price|cost|fee|amount|charge|\$/i, short_desc: /^(short|summary|blurb)/i, long_desc: /desc|detail|scope|notes?$/i, sku: /sku|code|id$/i,
  pricing_type: /pricing.?type|price.?type/i, min_qty: /min.*(qty|quant)/i, min_amount: /min.*(amount|fee|booking|value)/i, currency: /currenc/i,
  delivery_time: /deliver.*(time|days)|turnaround/i, revisions: /revision/i, included: /includ|deliverable/i, exclusions: /exclu/i, internal_notes: /internal/i,
};
export function suggestMapping(headers: string[]): Record<string, number | null> {
  const m: Record<string, number | null> = {}; const used = new Set<number>();
  for (const f of IMPORT_FIELDS) {
    const re = HEADER_HINTS[f]; m[f] = null; if (!re) continue;
    const idx = headers.findIndex((h, i) => !used.has(i) && re.test(h.trim()));
    if (idx >= 0) { m[f] = idx; used.add(idx); }
  }
  return m;
}

/** Heuristic extraction of "<name> ... <price>" lines from pasted text / PDF text. Always flagged for review. */
export function extractFromText(text: string): string[][] {
  const out: string[][] = [['Service', 'Rate', 'Category']];
  let category = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const m = line.match(/^(.*?)[\s.:\-–—]*((?:from|starting at|starts at|starting from)?\s*(?:CAD|USD)?\s*\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:\/\s*[A-Za-z]+|per\s+[A-Za-z]+)?)\s*$/i);
    if (m && m[1].trim().length >= 3 && /[A-Za-z]/.test(m[1])) out.push([m[1].trim(), m[2].trim(), category]);
    else if (line.length < 60 && !/\d/.test(line) && /^[A-Z0-9][\w &/'’-]+$/.test(line)) category = line;
  }
  return out;
}
export function extractPdfText(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-pdf-'));
  try {
    const f = path.join(dir, 'in.pdf'); fs.writeFileSync(f, buf);
    return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8', timeout: 20000, maxBuffer: 20e6 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const UNIT_ALIASES: Record<string, string> = { hr: 'hour', hrs: 'hour', hours: 'hour', hourly: 'hour', hour: 'hour', day: 'day', daily: 'day', days: 'day', video: 'video', videos: 'video', reel: 'reel', reels: 'reel', post: 'post', posts: 'post',
  month: 'month', monthly: 'month', mo: 'month', event: 'event', events: 'event', session: 'session', sessions: 'session', project: 'project', flat: 'project', fixed: 'project', platform: 'platform', week: 'week', weekly: 'week', photo: 'photo', photos: 'photo', km: 'km', item: 'item', revision: 'revision' };

export interface PreviewRow {
  row_no: number; raw: string[]; skip: boolean; issues: { level: 'error' | 'warning'; msg: string }[];
  item: Row; duplicate_of: { id: number; name: string; unit: string; rate_cents: number | null } | null; duplicate_in_file: boolean; action: 'create' | 'update' | 'skip'; needs_review: boolean;
}

export function previewImport(c: Ctx, rows: string[][], mapping: Record<string, number | null>, opts: { hasHeader: boolean; defaultCurrency?: string; fromText?: boolean }) {
  const data = opts.hasHeader ? rows.slice(1) : rows;
  const bizCur = (get(c.db, 'SELECT currency FROM businesses WHERE id=?', c.bid)!.currency as string);
  const existing = all(c.db, "SELECT id, name, unit, rate_cents FROM rc_items WHERE business_id=? AND status <> 'archived'", c.bid);
  const exMap = new Map(existing.map((e) => [norm(e.name) + '|' + norm(e.unit), e]));
  const seen = new Set<string>();
  const cell = (r: string[], f: string) => { const i = mapping[f]; return i === null || i === undefined ? '' : (r[i] ?? '').trim(); };
  const preview: PreviewRow[] = data.map((r, idx) => {
    const issues: PreviewRow['issues'] = [];
    const name = cell(r, 'name');
    if (!name) issues.push({ level: 'error', msg: 'Missing service name' });
    let unit = cell(r, 'unit'); let rateCell = cell(r, 'rate');
    let pricing_type: string = cell(r, 'pricing_type').toLowerCase().replace(/\s+/g, '_');
    let rate_cents: number | null = null;
    if (!['fixed', 'starting_from', 'custom_quote', 'on_request'].includes(pricing_type)) pricing_type = '';
    if (rateCell) {
      let rc = rateCell;
      const unitInCell = rc.match(/(?:\/|per\s+)\s*([A-Za-z]+)\s*$/i);
      if (unitInCell) { const u = UNIT_ALIASES[unitInCell[1].toLowerCase()]; if (u) { if (!unit) { unit = u; issues.push({ level: 'warning', msg: `Unit "${u}" was read from the rate text "${rateCell}" — please confirm` }); } rc = rc.replace(/(?:\/|per\s+)\s*[A-Za-z]+\s*$/i, ''); } }
      if (/^\s*(from|starting at|starts at|starting from)\b/i.test(rc)) { pricing_type ||= 'starting_from'; rc = rc.replace(/^\s*(from|starting at|starts at|starting from)\s*/i, ''); issues.push({ level: 'warning', msg: 'Marked as a "starting from" price — not a guaranteed final price' }); }
      if (/(custom|quote|tbd|tba|n\/a|varies|contact|request|por|negotiable)/i.test(rc) && !/\d/.test(rc)) { pricing_type ||= /request|por/i.test(rc) ? 'on_request' : 'custom_quote'; rc = ''; issues.push({ level: 'warning', msg: `Rate text "${rateCell}" means no fixed price; imported as ${pricing_type.replace('_', ' ')}` }); }
      if (rc) {
        if (/\d\s*(-|–|to)\s*\$?\d/.test(rc)) issues.push({ level: 'error', msg: `Price range "${rateCell}" is ambiguous — enter one rate (or use "starting from")` });
        else { const p = parseMoney(rc.replace(/^\s*(CAD|USD)\s*/i, '')); if (p.ok) rate_cents = p.value; else issues.push({ level: 'error', msg: `Cannot read rate "${rateCell}": ${p.error}` }); }
      }
    } else if (!pricing_type) { issues.push({ level: 'warning', msg: 'No price found — will be imported as "price on request" only if you keep this row' }); pricing_type = 'on_request'; }
    if (!pricing_type) pricing_type = 'fixed';
    if ((pricing_type === 'fixed' || pricing_type === 'starting_from') && rate_cents === null && !issues.some((i) => i.level === 'error')) { issues.push({ level: 'error', msg: 'Fixed pricing needs a rate' }); }
    if (!unit) { unit = 'project'; issues.push({ level: 'warning', msg: 'No billing unit found — defaulted to "project". Please confirm.' }); }
    else { const u = UNIT_ALIASES[unit.toLowerCase()]; if (u) unit = u; }
    const minq = cell(r, 'min_qty'); let min_qty_milli: number | null = null;
    if (minq) { const p = parseQty(minq); if (p.ok) min_qty_milli = p.value; else issues.push({ level: 'error', msg: `Minimum quantity: ${p.error}` }); }
    const mina = cell(r, 'min_amount'); let min_amount_cents: number | null = null;
    if (mina) { const p = parseMoney(mina); if (p.ok) min_amount_cents = p.value; else issues.push({ level: 'error', msg: `Minimum amount: ${p.error}` }); }
    const cur = (cell(r, 'currency') || opts.defaultCurrency || bizCur).toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) issues.push({ level: 'error', msg: `Invalid currency "${cur}"` });
    if (cur !== bizCur && /^[A-Z]{3}$/.test(cur)) issues.push({ level: 'warning', msg: `Currency ${cur} differs from the business currency ${bizCur}` });
    const kindRaw = cell(r, 'kind').toLowerCase(); const kind = ['service', 'addon', 'fee', 'package'].includes(kindRaw) ? kindRaw : 'service';
    if (kind === 'package') issues.push({ level: 'error', msg: 'Packages cannot be imported from a file; create them in the Packages editor after import' });
    const revs = cell(r, 'revisions'); let revisions: number | null = null;
    if (revs) { if (/^\d+$/.test(revs)) revisions = Number(revs); else issues.push({ level: 'warning', msg: `Revisions "${revs}" is not a whole number and was ignored` }); }
    const key = norm(name) + '|' + norm(unit);
    const dupEx = name ? exMap.get(key) ?? null : null; const dupFile = name ? seen.has(key) : false; if (name) seen.add(key);
    if (dupEx) issues.push({ level: 'warning', msg: `Looks like an existing service (#${dupEx.id}, ${dupEx.rate_cents != null ? (dupEx.rate_cents / 100).toFixed(2) : 'no rate'}). Choose update, create anyway, or skip.` });
    if (dupFile) issues.push({ level: 'warning', msg: 'Duplicate of an earlier row in this file' });
    const needs_review = opts.fromText || issues.some((i) => i.level === 'warning');
    return {
      row_no: idx + (opts.hasHeader ? 2 : 1), raw: r, skip: false, issues,
      item: { name, category: cell(r, 'category') || null, unit, pricing_type, rate_cents, currency: cur, kind, sku: cell(r, 'sku') || null, short_desc: cell(r, 'short_desc') || null, long_desc: cell(r, 'long_desc') || null,
        min_qty_milli, min_amount_cents, delivery_time: cell(r, 'delivery_time') || null, revisions, included: cell(r, 'included') || null, exclusions: cell(r, 'exclusions') || null, internal_notes: cell(r, 'internal_notes') || null },
      duplicate_of: dupEx, duplicate_in_file: dupFile, action: dupEx || dupFile ? 'skip' : 'create', needs_review,
    } as PreviewRow;
  });
  return {
    rows: preview,
    summary: { total: preview.length, with_errors: preview.filter((p) => p.issues.some((i) => i.level === 'error')).length, with_warnings: preview.filter((p) => p.issues.some((i) => i.level === 'warning')).length, duplicates: preview.filter((p) => p.duplicate_of || p.duplicate_in_file).length },
    units: COMMON_UNITS,
  };
}

export interface CommitRow { row_no: number; item: Row; action: 'create' | 'update' | 'skip'; update_id?: number | null }
/** Import user-confirmed rows. Each row succeeds or fails independently; the file and result are retained. */
export function commitImport(c: Ctx, rows: CommitRow[], confirmCount: number, source?: { filename: string; mime: string; data: Buffer }) {
  const todo = rows.filter((r) => r.action !== 'skip');
  if (confirmCount !== todo.length) throw bad(`Confirmation mismatch: you confirmed ${confirmCount} records but ${todo.length} are selected for import`);
  const results: { row_no: number; status: 'created' | 'updated' | 'skipped' | 'error'; id?: number; message?: string; name?: string }[] = [];
  for (const r of rows) {
    if (r.action === 'skip') { results.push({ row_no: r.row_no, status: 'skipped', name: r.item?.name }); continue; }
    try {
      const it = { ...r.item };
      if (it.pricing_type === 'fixed' && it.rate_cents == null) throw bad('Fixed pricing needs a rate');
      if (it.category) {
        const cat = get(c.db, 'SELECT id FROM rc_categories WHERE business_id=? AND name=? COLLATE NOCASE', c.bid, it.category);
        it.category_id = cat ? cat.id : saveCategory(c, null, { name: it.category });
      }
      delete it.category;
      const id = tx(c.db, () => {
        if (r.action === 'update') {
          if (!r.update_id) throw bad('No existing service selected to update');
          updateItem(c, r.update_id, { ...it, change_note: 'Updated by import' });
          return r.update_id;
        }
        return createItem(c, it);
      });
      results.push({ row_no: r.row_no, status: r.action === 'update' ? 'updated' : 'created', id, name: it.name });
    } catch (e: any) { results.push({ row_no: r.row_no, status: 'error', message: e.message, name: r.item?.name }); }
  }
  let attachmentId: number | null = null;
  if (source) {
    attachmentId = insert(c.db, 'INSERT INTO attachments (business_id, owner_type, owner_id, filename, mime, size, sha256, data, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      c.bid, 'import', null, source.filename.slice(0, 200), source.mime, source.data.length, sha256(source.data), source.data, c.uid);
  }
  const summary = { created: results.filter((x) => x.status === 'created').length, updated: results.filter((x) => x.status === 'updated').length, skipped: results.filter((x) => x.status === 'skipped').length, errors: results.filter((x) => x.status === 'error').length };
  audit(c, 'rc_import', attachmentId, 'import', { ...summary, source: source?.filename });
  return { summary, results, attachment_id: attachmentId };
}
