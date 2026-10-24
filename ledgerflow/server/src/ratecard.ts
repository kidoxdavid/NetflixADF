import { all, get, run, insert, tx } from './db.ts';
import type { Row } from './db.ts';
import { type Ctx, bad, notFound, conflict, str, reqStr, int, bool, oneOf, optDate, currencyCode, audit, getSettings } from './core.ts';
import { lineAmount } from './money.ts';
import type { TaxRef } from './calc.ts';

export const PRICING_TYPES = ['fixed', 'starting_from', 'custom_quote', 'on_request'] as const;
export const KINDS = ['service', 'addon', 'fee', 'package'] as const;
export const STATUSES = ['active', 'inactive', 'archived'] as const;

export const COMMON_UNITS = ['project', 'hour', 'day', 'video', 'reel', 'post', 'platform', 'event', 'session', 'month', 'week', 'photo', 'revision', 'km', 'item', 'package'];

export function listCategories(c: Ctx) {
  return all(c.db, `SELECT cat.*, (SELECT COUNT(*) FROM rc_items i WHERE i.category_id = cat.id AND i.status <> 'archived') AS item_count
    FROM rc_categories cat WHERE business_id = ? ORDER BY sort_order, name`, c.bid);
}
export function saveCategory(c: Ctx, id: number | null, b: Row) {
  const name = reqStr(b.name, 'Name', 120);
  const data = [name, str(b.description, 500), int(b.sort_order, 'sort_order', { optional: true }) ?? 0, bool(b.archived)] as const;
  try {
    if (id) { if (!get(c.db, 'SELECT 1 FROM rc_categories WHERE id=? AND business_id=?', id, c.bid)) throw notFound('Category');
      run(c.db, 'UPDATE rc_categories SET name=?, description=?, sort_order=?, archived=? WHERE id=? AND business_id=?', ...data, id, c.bid); return id; }
    const nid = insert(c.db, 'INSERT INTO rc_categories (name, description, sort_order, archived, business_id) VALUES (?,?,?,?,?)', ...data, c.bid);
    audit(c, 'rc_category', nid, 'create'); return nid;
  } catch (e: any) { if (/UNIQUE/.test(String(e.message))) throw conflict('A category with that name already exists'); throw e; }
}

function parseItem(r: Row): Row { return { ...r, tax_code_ids: r.tax_code_ids === null ? null : JSON.parse(r.tax_code_ids) }; }

export function getItem(c: Ctx, id: number, full = true) {
  const r = get(c.db, `SELECT i.*, cat.name AS category_name FROM rc_items i LEFT JOIN rc_categories cat ON cat.id = i.category_id WHERE i.id = ? AND i.business_id = ?`, id, c.bid);
  if (!r) throw notFound('Rate card item');
  const item: Row = parseItem(r);
  if (full) {
    item.addons = all(c.db, `SELECT i.id, i.name, i.unit, i.rate_cents, i.pricing_type, i.status FROM rc_item_addons a JOIN rc_items i ON i.id = a.addon_id WHERE a.item_id = ?`, id);
    if (item.kind === 'package') {
      item.components = all(c.db, `SELECT pc.id, pc.item_id, pc.qty_milli, pc.description, pc.position, i.name, i.unit, i.rate_cents, i.pricing_type, i.status
        FROM rc_package_components pc JOIN rc_items i ON i.id = pc.item_id WHERE pc.package_id = ? ORDER BY pc.position, pc.id`, id);
      item.itemized_total_cents = item.components.reduce((a: number, k: Row) => a + (k.rate_cents != null ? lineAmount(k.qty_milli, k.rate_cents) : 0), 0);
      item.itemized_complete = item.components.every((k: Row) => k.rate_cents != null && k.pricing_type === 'fixed');
    }
    item.history = all(c.db, 'SELECT * FROM rc_item_history WHERE item_id = ? ORDER BY version DESC, id DESC', id);
  }
  return item;
}

export function listItems(c: Ctx, q: { search?: string; category_id?: string; status?: string; kind?: string }) {
  const where = ['i.business_id = ?']; const p: any[] = [c.bid];
  if (q.status && q.status !== 'all') { where.push('i.status = ?'); p.push(q.status); } else if (!q.status) where.push("i.status <> 'archived'");
  if (q.category_id) { where.push('i.category_id = ?'); p.push(Number(q.category_id)); }
  if (q.kind) { where.push('i.kind = ?'); p.push(q.kind); }
  if (q.search) { where.push("(i.name LIKE ? ESCAPE '\\' OR i.sku LIKE ? ESCAPE '\\' OR i.short_desc LIKE ? ESCAPE '\\')"); const s = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`; p.push(s, s, s); }
  return all(c.db, `SELECT i.*, cat.name AS category_name FROM rc_items i LEFT JOIN rc_categories cat ON cat.id = i.category_id
    WHERE ${where.join(' AND ')} ORDER BY COALESCE(cat.sort_order, 9999), cat.name, i.sort_order, i.name`, ...p).map(parseItem);
}

function validateItem(c: Ctx, b: Row, existing?: Row) {
  const kind = oneOf(b.kind ?? existing?.kind, KINDS, 'kind', 'service');
  const pricing_type = oneOf(b.pricing_type ?? existing?.pricing_type, PRICING_TYPES, 'pricing_type', 'fixed');
  const name = reqStr(b.name ?? existing?.name, 'Name', 200);
  const unit = reqStr(b.unit ?? existing?.unit ?? 'project', 'Unit', 40);
  const rate_cents = int(b.rate_cents, 'rate', { min: 0, max: 1e11, optional: true });
  if ((pricing_type === 'fixed' || pricing_type === 'starting_from') && rate_cents === null && !(kind === 'package' && b.pkg_price_mode === 'itemized'))
    throw bad(`A rate is required for "${pricing_type === 'fixed' ? 'fixed' : 'starting from'}" pricing. Use "custom quote" or "price on request" if there is no set rate.`);
  const category_id = b.category_id ? int(b.category_id, 'category', { min: 1 }) : null;
  if (category_id && !get(c.db, 'SELECT 1 FROM rc_categories WHERE id=? AND business_id=?', category_id, c.bid)) throw bad('Category not found');
  let tax_code_ids: string | null = null;
  if (b.tax_code_ids !== undefined && b.tax_code_ids !== null) {
    if (!Array.isArray(b.tax_code_ids)) throw bad('tax_code_ids must be an array');
    const ids = b.tax_code_ids.map((x: unknown) => int(x, 'tax id', { min: 1 })!);
    for (const t of ids) if (!get(c.db, 'SELECT 1 FROM tax_codes WHERE id=? AND business_id=?', t, c.bid)) throw bad('Tax code not found');
    tax_code_ids = JSON.stringify(ids);
  }
  const defaultQty = int(b.default_qty_milli ?? existing?.default_qty_milli ?? 1000, 'default quantity', { min: 1 })!;
  const minQty = int(b.min_qty_milli, 'minimum quantity', { min: 1, optional: true });
  return {
    category_id, kind, sku: str(b.sku, 60), name, short_desc: str(b.short_desc, 500), long_desc: str(b.long_desc, 5000), unit, pricing_type,
    rate_cents, currency: currencyCode(b.currency ?? existing?.currency, getBusinessCurrency(c)),
    default_qty_milli: defaultQty, min_qty_milli: minQty, min_amount_cents: int(b.min_amount_cents, 'minimum amount', { min: 0, optional: true }),
    duration: str(b.duration, 100), delivery_time: str(b.delivery_time, 100), revisions: int(b.revisions, 'revisions', { min: 0, max: 1000, optional: true }),
    platforms: int(b.platforms, 'platforms', { min: 0, max: 1000, optional: true }), deliverable_count: int(b.deliverable_count, 'deliverables', { min: 0, max: 100000, optional: true }),
    usage_rights: str(b.usage_rights, 2000), included: str(b.included, 3000), exclusions: str(b.exclusions, 3000),
    tax_code_ids, cost_cents: int(b.cost_cents, 'cost', { min: 0, optional: true }), internal_notes: str(b.internal_notes, 3000),
    public_visible: b.public_visible === undefined ? 1 : bool(b.public_visible), show_price: b.show_price === undefined ? 1 : bool(b.show_price),
    status: oneOf(b.status, STATUSES, 'status', 'active'), effective_date: optDate(b.effective_date, 'Effective date'),
    pkg_price_mode: kind === 'package' ? oneOf(b.pkg_price_mode, ['fixed', 'itemized'] as const, 'package price mode', 'fixed') : null,
    pkg_display: kind === 'package' ? oneOf(b.pkg_display, ['combined', 'itemized'] as const, 'package display', 'combined') : 'combined',
    pkg_valid_days: int(b.pkg_valid_days, 'package validity', { min: 1, optional: true }), pkg_billing_frequency: str(b.pkg_billing_frequency, 40),
    sort_order: int(b.sort_order, 'sort', { optional: true }) ?? 0,
  };
}
function getBusinessCurrency(c: Ctx) { return get(c.db, 'SELECT currency FROM businesses WHERE id=?', c.bid)!.currency as string; }

const PRICE_FIELDS = ['name', 'unit', 'pricing_type', 'rate_cents', 'currency', 'effective_date', 'status'] as const;

function setRelations(c: Ctx, itemId: number, b: Row) {
  if (Array.isArray(b.addon_ids)) {
    run(c.db, 'DELETE FROM rc_item_addons WHERE item_id = ?', itemId);
    for (const a of b.addon_ids) {
      const aid = int(a, 'addon', { min: 1 })!;
      if (aid === itemId) continue;
      if (!get(c.db, 'SELECT 1 FROM rc_items WHERE id=? AND business_id=?', aid, c.bid)) throw bad('Add-on not found');
      run(c.db, 'INSERT OR IGNORE INTO rc_item_addons (item_id, addon_id) VALUES (?,?)', itemId, aid);
    }
  }
  if (Array.isArray(b.components)) {
    run(c.db, 'DELETE FROM rc_package_components WHERE package_id = ?', itemId);
    b.components.forEach((k: Row, idx: number) => {
      const cid = int(k.item_id, 'component', { min: 1 })!;
      const comp = get(c.db, 'SELECT kind FROM rc_items WHERE id=? AND business_id=?', cid, c.bid);
      if (!comp) throw bad('Package component not found');
      if (comp.kind === 'package') throw bad('Packages cannot contain other packages');
      if (cid === itemId) throw bad('A package cannot contain itself');
      run(c.db, 'INSERT INTO rc_package_components (package_id, item_id, qty_milli, description, position) VALUES (?,?,?,?,?)', itemId, cid, int(k.qty_milli ?? 1000, 'component quantity', { min: 1 })!, str(k.description, 500), idx);
    });
  }
}

export function createItem(c: Ctx, b: Row) {
  return tx(c.db, () => {
    const v = validateItem(c, b);
    if (v.kind === 'package' && (!Array.isArray(b.components) || !b.components.length)) throw bad('A package needs at least one included service');
    try {
      const keys = Object.keys(v);
      const id = insert(c.db, `INSERT INTO rc_items (business_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, c.bid, ...keys.map((k) => (v as any)[k] ?? null));
      setRelations(c, id, b);
      insert(c.db, 'INSERT INTO rc_item_history (item_id, version, user_id, name, unit, pricing_type, rate_cents, currency, effective_date, status, change_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, 1, c.uid, v.name, v.unit, v.pricing_type, v.rate_cents, v.currency, v.effective_date, v.status, 'Created');
      audit(c, 'rc_item', id, 'create', { name: v.name, rate_cents: v.rate_cents });
      return id;
    } catch (e: any) { if (/UNIQUE/.test(String(e.message))) throw conflict('Another service already uses that SKU'); throw e; }
  });
}

export function updateItem(c: Ctx, id: number, b: Row) {
  return tx(c.db, () => {
    const cur = get(c.db, 'SELECT * FROM rc_items WHERE id=? AND business_id=?', id, c.bid);
    if (!cur) throw notFound('Rate card item');
    const merged = { ...cur, ...b, tax_code_ids: b.tax_code_ids !== undefined ? b.tax_code_ids : (cur.tax_code_ids === null ? null : JSON.parse(cur.tax_code_ids)) };
    // fields not supplied keep their stored values
    for (const k of Object.keys(cur)) if (b[k] === undefined && k !== 'tax_code_ids') (merged as any)[k] = cur[k];
    const v = validateItem(c, merged, cur);
    const priceChanged = PRICE_FIELDS.some((f) => ((v as any)[f] ?? null) !== (cur[f] ?? null));
    const version = priceChanged ? cur.version + 1 : cur.version;
    const keys = Object.keys(v);
    try {
      run(c.db, `UPDATE rc_items SET ${keys.map((k) => `${k}=?`).join(',')}, version=?, updated_at=datetime('now') WHERE id=? AND business_id=?`, ...keys.map((k) => (v as any)[k] ?? null), version, id, c.bid);
    } catch (e: any) { if (/UNIQUE/.test(String(e.message))) throw conflict('Another service already uses that SKU'); throw e; }
    setRelations(c, id, b);
    if (priceChanged) {
      insert(c.db, 'INSERT INTO rc_item_history (item_id, version, user_id, name, unit, pricing_type, rate_cents, currency, effective_date, status, change_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, version, c.uid, v.name, v.unit, v.pricing_type, v.rate_cents, v.currency, v.effective_date, v.status, str(b.change_note, 300));
      audit(c, 'rc_item', id, 'price_change', { from: cur.rate_cents, to: v.rate_cents, unit: v.unit });
    }
    return id;
  });
}

export function setItemStatus(c: Ctx, id: number, status: string) {
  oneOf(status, STATUSES, 'status');
  const cur = get(c.db, 'SELECT status, version FROM rc_items WHERE id=? AND business_id=?', id, c.bid);
  if (!cur) throw notFound('Rate card item');
  if (cur.status === status) return;
  tx(c.db, () => {
    run(c.db, "UPDATE rc_items SET status=?, version=version+1, updated_at=datetime('now') WHERE id=?", status, id);
    const r = get(c.db, 'SELECT * FROM rc_items WHERE id=?', id)!;
    insert(c.db, 'INSERT INTO rc_item_history (item_id, version, user_id, name, unit, pricing_type, rate_cents, currency, effective_date, status, change_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, r.version, c.uid, r.name, r.unit, r.pricing_type, r.rate_cents, r.currency, r.effective_date, status, `Status: ${status}`);
    audit(c, 'rc_item', id, 'status', { status });
  });
}

export function duplicateItem(c: Ctx, id: number) {
  return tx(c.db, () => {
    const it = getItem(c, id);
    const copy: Row = { ...it, name: `${it.name} (copy)`, sku: null, status: 'inactive' };
    copy.addon_ids = it.addons.map((a: Row) => a.id);
    copy.components = it.components ?? undefined;
    return createItem(c, copy);
  });
}

/** Bulk-adjust rates by a percentage (recorded as price changes). Percent in milli-percent. */
export function bulkAdjust(c: Ctx, ids: number[], milliPct: number, note: string | null) {
  return tx(c.db, () => {
    let n = 0;
    for (const id of ids) {
      const it = get(c.db, 'SELECT * FROM rc_items WHERE id=? AND business_id=?', id, c.bid);
      if (!it || it.rate_cents === null) continue;
      const nr = Math.round(it.rate_cents * (100000 + milliPct) / 100000);
      updateItem(c, id, { rate_cents: nr, change_note: note ?? `Bulk adjustment ${milliPct / 1000}%` }); n++;
    }
    return n;
  });
}

// ---- Versions --------------------------------------------------------------
export function createVersion(c: Ctx, label: string, note: string | null) {
  const items = listItems(c, { status: 'all' }).map((i) => ({ id: i.id, sku: i.sku, name: i.name, category: i.category_name, kind: i.kind, unit: i.unit, pricing_type: i.pricing_type, rate_cents: i.rate_cents, currency: i.currency, status: i.status, version: i.version }));
  const id = insert(c.db, 'INSERT INTO rc_versions (business_id, label, note, created_by, snapshot) VALUES (?,?,?,?,?)', c.bid, reqStr(label, 'Label', 100), str(note, 500), c.uid, JSON.stringify(items));
  audit(c, 'rc_version', id, 'create', { label, items: items.length });
  return id;
}
export function listVersions(c: Ctx) {
  return all(c.db, 'SELECT id, label, note, created_at, (json_array_length(snapshot)) AS item_count FROM rc_versions WHERE business_id=? ORDER BY id DESC', c.bid);
}
function snapshotOf(c: Ctx, ref: string | number): any[] {
  if (ref === 'current') return listItems(c, { status: 'all' }).map((i) => ({ id: i.id, name: i.name, unit: i.unit, rate_cents: i.rate_cents, pricing_type: i.pricing_type, status: i.status, currency: i.currency }));
  const r = get(c.db, 'SELECT snapshot FROM rc_versions WHERE id=? AND business_id=?', Number(ref), c.bid);
  if (!r) throw notFound('Version');
  return JSON.parse(r.snapshot);
}
export function compareVersions(c: Ctx, a: string | number, b: string | number) {
  const A = new Map(snapshotOf(c, a).map((i) => [i.id, i])); const B = new Map(snapshotOf(c, b).map((i) => [i.id, i]));
  const changed: Row[] = [], added: Row[] = [], removed: Row[] = [];
  for (const [id, y] of B) { const x = A.get(id); if (!x) added.push(y); else if (x.rate_cents !== y.rate_cents || x.unit !== y.unit || x.pricing_type !== y.pricing_type || x.status !== y.status || x.name !== y.name)
    changed.push({ id, name: y.name, before: { rate_cents: x.rate_cents, unit: x.unit, pricing_type: x.pricing_type, status: x.status, name: x.name }, after: { rate_cents: y.rate_cents, unit: y.unit, pricing_type: y.pricing_type, status: y.status, name: y.name },
      change_pct: x.rate_cents && y.rate_cents != null ? Math.round(((y.rate_cents - x.rate_cents) / x.rate_cents) * 10000) / 100 : null }); }
  for (const [id, x] of A) if (!B.has(id)) removed.push(x);
  return { added, removed, changed };
}

// ---- Pricing resolution -------------------------------------------------------
export interface Resolved {
  item: Row; standard_rate_cents: number | null; rate_cents: number | null;
  source: 'rate_card' | 'client_agreement'; client_price_id: number | null; client_price_note: string | null;
  needs_confirmation: boolean; reason: string | null;
}
export function resolvePrice(c: Ctx, itemId: number, clientId: number | null, onDate: string): Resolved {
  const item = getItem(c, itemId, false);
  let rate = item.rate_cents as number | null; let source: Resolved['source'] = 'rate_card'; let cpId: number | null = null; let cpNote: string | null = null;
  if (clientId) {
    const cp = get(c.db, `SELECT * FROM client_prices WHERE business_id=? AND client_id=? AND item_id=? AND active=1
      AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?) ORDER BY id DESC LIMIT 1`, c.bid, clientId, itemId, onDate, onDate);
    if (cp) { rate = cp.rate_cents; source = 'client_agreement'; cpId = cp.id; cpNote = cp.note; }
  }
  let needs = false; let reason: string | null = null;
  if (item.pricing_type === 'custom_quote') { needs = source !== 'client_agreement'; reason = 'Custom quotation required — confirm the price before issuing'; }
  else if (item.pricing_type === 'on_request') { needs = source !== 'client_agreement'; reason = 'Price on request — enter and confirm the price before issuing'; }
  else if (item.pricing_type === 'starting_from') { needs = source !== 'client_agreement'; reason = '"Starting from" price — confirm the final price before issuing'; }
  if (rate === null && !needs) { needs = true; reason = 'No rate defined — enter a price'; }
  return { item, standard_rate_cents: item.rate_cents, rate_cents: rate, source, client_price_id: cpId, client_price_note: cpNote, needs_confirmation: needs, reason };
}

export function taxesForItem(c: Ctx, item: Row): TaxRef[] {
  let ids: number[];
  if (item.tax_code_ids === null || item.tax_code_ids === undefined) ids = getSettings(c.db, c.bid).default_tax_ids;
  else ids = Array.isArray(item.tax_code_ids) ? item.tax_code_ids : JSON.parse(item.tax_code_ids);
  if (!ids.length) return [];
  return all(c.db, `SELECT id, name, rate_milli FROM tax_codes WHERE business_id=? AND active=1 AND id IN (${ids.map(() => '?').join(',')})`, c.bid, ...ids) as TaxRef[];
}

/** Build editor-ready line(s) from a rate card item. Returns a line with optional children (packages). */
export function buildLinesFromItem(c: Ctx, itemId: number, clientId: number | null, onDate: string, qtyMilli?: number): Row {
  const r = resolvePrice(c, itemId, clientId, onDate);
  const it = r.item;
  const parts = [it.short_desc, it.long_desc].filter(Boolean);
  const qty = Math.max(qtyMilli ?? it.default_qty_milli, it.min_qty_milli ?? 0);
  const warnings: string[] = [];
  if (it.status !== 'active') warnings.push(`This rate card item is ${it.status}`);
  const base: Row = {
    rc_item_id: it.id, rc_item_version: it.version, category_name: it.category_name ?? null,
    description: it.name, detail: it.long_desc ?? it.short_desc ?? null, unit: it.unit, qty_milli: qty,
    unit_price_cents: r.rate_cents ?? 0, standard_price_cents: it.rate_cents, price_source: r.source, client_price_id: r.client_price_id,
    needs_confirmation: r.needs_confirmation ? 1 : 0, price_confirmed: r.needs_confirmation ? 0 : 1, price_note: r.reason ?? r.client_price_note,
    discount_type: 'none', discount_value: 0, taxes: taxesForItem(c, it), tax_exempt: 0, min_amount_cents: it.min_amount_cents ?? null, warnings, _parts: parts.length,
  };
  if (it.min_amount_cents != null && r.rate_cents != null && lineAmount(qty, r.rate_cents) < it.min_amount_cents)
    warnings.push(`Below the minimum booking amount of ${(it.min_amount_cents / 100).toFixed(2)}`);
  delete base._parts;
  if (it.kind !== 'package') return base;

  const comps = all(c.db, 'SELECT * FROM rc_package_components WHERE package_id=? ORDER BY position, id', it.id);
  if (!comps.length) throw bad('Package has no components');
  base.package_id = it.id; base.package_display = it.pkg_display; base.price_source = r.source === 'client_agreement' ? 'client_agreement' : 'package';
  const children: Row[] = comps.map((k) => {
    const cr = resolvePrice(c, k.item_id, clientId, onDate);
    return {
      rc_item_id: cr.item.id, rc_item_version: cr.item.version, category_name: cr.item.category_name ?? null,
      description: k.description || cr.item.name, detail: null, unit: cr.item.unit, qty_milli: k.qty_milli,
      unit_price_cents: it.pkg_price_mode === 'fixed' ? 0 : (cr.rate_cents ?? 0), standard_price_cents: cr.item.rate_cents,
      price_source: cr.source, client_price_id: cr.client_price_id,
      needs_confirmation: it.pkg_price_mode === 'fixed' ? 0 : (cr.needs_confirmation ? 1 : 0), price_confirmed: it.pkg_price_mode === 'fixed' ? 1 : (cr.needs_confirmation ? 0 : 1),
      price_note: it.pkg_price_mode === 'fixed' ? 'Included in package price' : cr.reason,
      discount_type: 'none', discount_value: 0, taxes: taxesForItem(c, cr.item), tax_exempt: 0,
      is_component: it.pkg_price_mode === 'fixed' ? 1 : 0,
    };
  });
  if (it.pkg_price_mode === 'itemized') { base.unit_price_cents = 0; base.standard_price_cents = null; base.needs_confirmation = 0; base.price_confirmed = 1; base.price_note = 'Itemized package: priced by its components'; base.group_only = 1; base.qty_milli = 1000; base.taxes = []; }
  base.children = children;
  return base;
}

export function exportCsv(c: Ctx): string {
  const rows = listItems(c, { status: 'all' });
  const head = ['sku', 'category', 'kind', 'name', 'unit', 'pricing_type', 'rate', 'currency', 'status', 'short_description', 'description', 'minimum_quantity', 'minimum_amount', 'delivery_time', 'revisions', 'included', 'exclusions', 'effective_date'];
  const money = (n: number | null) => (n === null || n === undefined ? '' : (n / 100).toFixed(2));
  const lines = [head.join(',')];
  for (const i of rows) lines.push([i.sku, i.category_name, i.kind, i.name, i.unit, i.pricing_type, money(i.rate_cents), i.currency, i.status, i.short_desc, i.long_desc,
    i.min_qty_milli != null ? i.min_qty_milli / 1000 : '', money(i.min_amount_cents), i.delivery_time, i.revisions, i.included, i.exclusions, i.effective_date].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
