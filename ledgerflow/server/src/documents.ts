import { all, get, run, insert, tx } from './db.ts';
import type { Row } from './db.ts';
import { type Ctx, bad, notFound, conflict, str, reqStr, int, bool, oneOf, optDate, currencyCode, audit, getSettings, nextNumber, bizToday, addDays, randomToken, sha256, ensureOwned, isDate } from './core.ts';
import { calcDocument, allocate, type CalcLineIn, type TaxRef } from './calc.ts';
import { roundDiv, lineAmount, PCT_SCALE } from './money.ts';
import { resolvePrice, getItem } from './ratecard.ts';

export type DocType = 'estimate' | 'invoice' | 'credit_note';

const parseJson = (s: string | null, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---- Status helpers --------------------------------------------------------------
export function balanceOf(d: Row) { return d.total_cents - d.amount_paid_cents - (d.credited_cents ?? 0); }
export function displayStatus(d: Row, today: string, hasInvoice = false): string {
  if (d.type === 'invoice') {
    if (d.status === 'draft' || d.status === 'void') return d.status;
    const bal = balanceOf(d);
    if (bal <= 0) return d.credited_cents > 0 && d.amount_paid_cents === 0 ? 'credited' : 'paid';
    if (d.due_date && d.due_date < today) return 'overdue';
    return d.amount_paid_cents > 0 ? 'partially_paid' : 'issued';
  }
  if (d.type === 'estimate') {
    if (hasInvoice && d.status === 'accepted') return 'converted';
    if (d.status === 'issued' && d.valid_until && d.valid_until < today) return 'expired';
  }
  return d.status;
}

// ---- Line normalisation ----------------------------------------------------------
interface NormLine extends Row { children?: NormLine[] }

function resolveTaxes(c: Ctx, taxes: unknown): TaxRef[] {
  if (taxes === undefined || taxes === null) return [];
  if (!Array.isArray(taxes)) throw bad('taxes must be an array');
  return taxes.map((t: Row) => {
    const id = int(t.id, 'tax id', { min: 1 })!;
    const tc = get(c.db, 'SELECT id, name, rate_milli FROM tax_codes WHERE id=? AND business_id=?', id, c.bid);
    if (!tc) throw bad('Unknown tax code');
    return { id: tc.id, name: tc.name, rate_milli: tc.rate_milli } as TaxRef; // server-authoritative name & rate
  });
}

function normaliseLine(c: Ctx, l: Row, clientId: number, onDate: string, isChild = false): NormLine {
  const description = reqStr(l.description, 'Line description', 500);
  const qty = int(l.qty_milli ?? 1000, 'quantity', { min: 1, max: 1e9 })!;
  const unit_price = int(l.unit_price_cents ?? 0, 'unit price', { min: -1e11, max: 1e11 })!;
  const discount_type = oneOf(l.discount_type, ['none', 'percent', 'fixed'] as const, 'discount type', 'none');
  const discount_value = discount_type === 'none' ? 0 : int(l.discount_value ?? 0, 'discount', { min: 0, max: 1e11 })!;
  if (discount_type === 'percent' && discount_value > 100000) throw bad('Percentage discount cannot exceed 100%');
  const out: NormLine = {
    description, detail: str(l.detail, 3000), unit: str(l.unit, 40), qty_milli: qty, unit_price_cents: unit_price,
    discount_type, discount_value, tax_exempt: bool(l.tax_exempt), taxes: resolveTaxes(c, l.taxes),
    is_component: bool(l.is_component), rc_item_id: null, rc_item_version: null, category_name: str(l.category_name, 120),
    standard_price_cents: null, price_source: 'custom', client_price_id: null, needs_confirmation: 0, price_confirmed: 1,
    package_id: null, package_display: null, recurring: bool(l.recurring), group_only: bool(l.group_only),
    price_note: str(l.price_note, 300),
  };
  const src = oneOf(l.price_source, ['rate_card', 'client_agreement', 'custom', 'time', 'expense', 'package', 'stage'] as const, 'price source', 'custom');
  out.price_source = src;
  if (l.rc_item_id) {
    const itemId = int(l.rc_item_id, 'rate card item', { min: 1 })!;
    const r = resolvePrice(c, itemId, clientId, onDate); // server decides what the rate card says
    out.rc_item_id = itemId; out.rc_item_version = r.item.version; out.standard_price_cents = r.item.rate_cents; out.category_name = r.item.category_name ?? null;
    if (r.item.kind === 'package' && !isChild) { out.package_id = itemId; out.package_display = oneOf(l.package_display ?? r.item.pkg_display, ['combined', 'itemized'] as const, 'package display', 'combined'); }
    const intended = r.rate_cents;
    if (r.item.pricing_type === 'fixed' || r.source === 'client_agreement') {
      out.price_source = unit_price === intended ? r.source : 'custom';
      out.client_price_id = unit_price === intended ? r.client_price_id : null;
      out.needs_confirmation = 0; out.price_confirmed = 1;
    } else if (out.group_only || (r.item.kind === 'package' && r.item.pkg_price_mode === 'itemized')) {
      out.needs_confirmation = 0; out.price_confirmed = 1;
    } else { // starting_from / custom_quote / on_request: user must explicitly confirm a price
      out.needs_confirmation = 1; out.price_confirmed = bool(l.price_confirmed); out.price_source = unit_price === intended && intended !== null ? 'rate_card' : 'custom';
    }
    if (out.is_component) { out.needs_confirmation = 0; out.price_confirmed = 1; }
  } else if (['rate_card', 'client_agreement'].includes(src)) { out.price_source = 'custom'; }
  if (['time', 'expense', 'stage'].includes(src)) out.price_source = src;
  return out;
}

function flatten(lines: NormLine[]): NormLine[] {
  const out: NormLine[] = [];
  for (const l of lines) { out.push(l); for (const ch of l.children ?? []) { ch._parent = l; out.push(ch); } }
  return out;
}

function computeAndLayout(doc: Row, lines: NormLine[]) {
  const flat = flatten(lines);
  const calcIn = {
    lines: flat.map((l): CalcLineIn => ({ qty_milli: l.qty_milli, unit_price_cents: l.unit_price_cents, discount_type: l.discount_type, discount_value: l.discount_value, taxes: l.taxes, tax_exempt: !!l.tax_exempt, is_component: !!l.is_component })),
    prices_include_tax: !!doc.prices_include_tax, discount_type: doc.discount_type, discount_value: doc.discount_value, tax_exempt: !!doc.tax_exempt,
  };
  const out = calcDocument(calcIn);
  flat.forEach((l, i) => Object.assign(l, out.lines[i]));
  return { flat, calc: out };
}

// ---- Persistence -----------------------------------------------------------------------
function persistLines(c: Ctx, docId: number, lines: NormLine[]) {
  run(c.db, 'DELETE FROM document_lines WHERE document_id = ?', docId);
  let pos = 0;
  const insertOne = (l: NormLine, parentId: number | null) => {
    const id = insert(c.db, `INSERT INTO document_lines (document_id, position, rc_item_id, rc_item_version, category_name, parent_line_id, is_component, package_id, package_display,
      description, detail, unit, qty_milli, unit_price_cents, standard_price_cents, price_source, client_price_id, needs_confirmation, price_confirmed, discount_type, discount_value,
      tax_exempt, taxes, amount_cents, line_discount_cents, net_cents, doc_discount_cents, taxable_cents, tax_cents, total_cents, recurring)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      docId, pos++, l.rc_item_id, l.rc_item_version, l.category_name, parentId, l.is_component ? 1 : 0, l.package_id, l.package_display,
      l.description, l.detail, l.unit, l.qty_milli, l.unit_price_cents, l.standard_price_cents, l.price_source, l.client_price_id, l.needs_confirmation, l.price_confirmed, l.discount_type, l.discount_value,
      l.tax_exempt ? 1 : 0, JSON.stringify(l.taxes), l.amount_cents, l.line_discount_cents, l.net_cents, l.doc_discount_cents, l.taxable_cents, l.tax_cents, l.total_cents, l.recurring ? 1 : 0);
    return id;
  };
  for (const l of lines) { const pid = insertOne(l, null); for (const ch of l.children ?? []) insertOne(ch, pid); }
}

function saveStages(c: Ctx, estId: number, stages: unknown) {
  run(c.db, 'DELETE FROM billing_stages WHERE estimate_id = ? AND invoice_id IS NULL', estId);
  if (!Array.isArray(stages)) return;
  let pct = 0; let balances = 0;
  stages.forEach((s: Row, i: number) => {
    const kind = oneOf(s.kind, ['percent', 'fixed', 'balance'] as const, 'stage kind');
    const value = kind === 'balance' ? 0 : int(s.value, 'stage value', { min: 1, max: kind === 'percent' ? 100000 : 1e11 })!;
    if (kind === 'percent') pct += value; if (kind === 'balance') balances++;
    insert(c.db, 'INSERT INTO billing_stages (estimate_id, position, label, kind, value, due_days) VALUES (?,?,?,?,?,?)', estId, i, reqStr(s.label, 'Stage label', 120), kind, value, int(s.due_days, 'due days', { min: 0, max: 365, optional: true }));
  });
  if (pct > 100000) throw bad('Percentage stages add up to more than 100%');
  if (balances > 1) throw bad('Only one "balance" stage is allowed');
}

const DOC_TEXT = ['po_ref', 'title', 'notes', 'terms', 'payment_instructions', 'scope', 'deliverables', 'assumptions', 'exclusions', 'revision_terms', 'deposit_note', 'tax_exempt_note'] as const;

export function saveDraft(c: Ctx, id: number | null, type: DocType, b: Row): number {
  return tx(c.db, () => {
    let cur: Row | undefined;
    if (id) { cur = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', id, c.bid); if (!cur) throw notFound('Document'); if (cur.status !== 'draft') throw conflict('Only drafts can be edited. Issued documents are locked; revise, void or credit instead.'); type = cur.type; }
    const client = ensureOwned(c.db, 'clients', b.client_id ?? cur?.client_id, c.bid, 'Client');
    const biz = get(c.db, 'SELECT currency FROM businesses WHERE id=?', c.bid)!;
    const s = getSettings(c.db, c.bid);
    const currency = currencyCode(b.currency ?? cur?.currency ?? client.currency, biz.currency);
    if (cur && cur.currency !== currency && get(c.db, 'SELECT 1 FROM document_lines WHERE document_id=? LIMIT 1', cur.id)) { /* allowed in draft; prices are not converted */ }
    const projectId = b.project_id ? int(b.project_id, 'project', { min: 1 }) : null;
    if (projectId) { const p = ensureOwned(c.db, 'projects', projectId, c.bid, 'Project'); if (p.client_id !== client.id) throw bad('Project belongs to a different client'); }
    const discount_type = oneOf(b.discount_type ?? 'none', ['none', 'percent', 'fixed'] as const, 'discount type');
    const discount_value = discount_type === 'none' ? 0 : int(b.discount_value ?? 0, 'discount', { min: 0, max: 1e11 })!;
    if (discount_type === 'percent' && discount_value > 100000) throw bad('Discount cannot exceed 100%');
    const today = bizToday(c.db, c.bid);
    const rawLines = Array.isArray(b.lines) ? b.lines : [];
    if (rawLines.length > 300) throw bad('Too many lines');
    const lines: NormLine[] = rawLines.map((l: Row) => {
      const n = normaliseLine(c, l, client.id, today);
      if (Array.isArray(l.children)) n.children = l.children.map((ch: Row) => normaliseLine(c, ch, client.id, today, true));
      return n;
    });
    const taxExempt = b.tax_exempt !== undefined ? bool(b.tax_exempt) : (cur ? cur.tax_exempt : client.tax_exempt);
    const docFields: Row = {
      client_id: client.id, project_id: projectId, currency, po_ref: null,
      prices_include_tax: b.prices_include_tax !== undefined ? bool(b.prices_include_tax) : (cur ? cur.prices_include_tax : (s.prices_include_tax ? 1 : 0)),
      tax_exempt: taxExempt, discount_type, discount_value,
    };
    for (const k of DOC_TEXT) docFields[k] = str(b[k], 8000);
    if (taxExempt && !docFields.tax_exempt_note) docFields.tax_exempt_note = client.tax_exempt_note ?? null;
    docFields.issue_date = optDate(b.issue_date, 'Issue date'); docFields.due_date = optDate(b.due_date, 'Due date'); docFields.valid_until = optDate(b.valid_until, 'Valid until');
    if (docFields.issue_date && docFields.due_date && docFields.due_date < docFields.issue_date) throw bad('Due date cannot be before the issue date');
    docFields.template = b.template ? oneOf(b.template, ['minimal', 'editorial', 'creative', 'formal'] as const, 'template') : null;
    // sensible defaults from settings
    if (type === 'invoice') { docFields.notes ??= s.invoice_notes || null; docFields.terms ??= s.invoice_terms || null; }
    if (type === 'estimate') docFields.terms ??= s.estimate_terms || null;
    docFields.payment_instructions ??= s.payment_instructions || null;

    const { calc } = computeAndLayout(docFields, lines);
    docFields.subtotal_cents = calc.subtotal_cents; docFields.discount_cents = calc.discount_cents; docFields.tax_total_cents = calc.tax_total_cents;
    docFields.total_cents = calc.total_cents; docFields.tax_summary = JSON.stringify(calc.tax_summary);
    if (calc.total_cents < 0) throw bad('Document total cannot be negative');

    let docId: number;
    if (cur) {
      const keys = Object.keys(docFields);
      run(c.db, `UPDATE documents SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`, ...keys.map((k) => docFields[k] ?? null), cur.id);
      docId = cur.id;
    } else {
      docFields.business_id = c.bid; docFields.type = type; docFields.created_by = c.uid;
      if (b.credit_for_invoice_id) docFields.credit_for_invoice_id = int(b.credit_for_invoice_id, 'invoice', { min: 1 });
      const keys = Object.keys(docFields);
      docId = insert(c.db, `INSERT INTO documents (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => docFields[k] ?? null));
    }
    persistLines(c, docId, lines);
    if (type === 'estimate' && b.stages !== undefined) saveStages(c, docId, b.stages);
    audit(c, type, docId, cur ? 'update_draft' : 'create_draft', { total_cents: calc.total_cents });
    return docId;
  });
}

// ---- Reading --------------------------------------------------------------------------
export function getDocument(c: Ctx, id: number, opts: { includeStale?: boolean } = {}) {
  const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', id, c.bid);
  if (!d) throw notFound('Document');
  return hydrate(c, d, opts);
}
export function hydrate(c: Ctx, d: Row, opts: { includeStale?: boolean } = {}) {
  const raw: Row[] = all(c.db, 'SELECT * FROM document_lines WHERE document_id=? ORDER BY position', d.id).map((l): Row => ({ ...l, taxes: parseJson(l.taxes, []) }));
  const byParent = new Map<number, Row[]>(); const top: Row[] = [];
  for (const l of raw) { if (l.parent_line_id) { const arr = byParent.get(l.parent_line_id) ?? []; arr.push(l); byParent.set(l.parent_line_id, arr); } else top.push(l); }
  const lines = top.map((l) => ({ ...l, children: byParent.get(l.id) ?? [] }));
  const today = bizToday(c.db, c.bid);
  const hasInvoice = d.type === 'estimate' ? !!get(c.db, "SELECT 1 FROM documents WHERE source_estimate_id=? AND status<>'void'", d.id) : false;
  const client = get(c.db, 'SELECT id, name, company, email FROM clients WHERE id=?', d.client_id);
  const out: Row = {
    ...d, public_token_hash: undefined, tax_summary: parseJson(d.tax_summary, []), business_snapshot: parseJson(d.business_snapshot, null), client_snapshot: parseJson(d.client_snapshot, null),
    lines, client, balance_cents: d.type === 'invoice' ? balanceOf(d) : null, display_status: displayStatus(d, today, hasInvoice), has_public_link: !!d.public_token_hash && !d.public_revoked,
  };
  if (d.type === 'estimate') {
    out.stages = all(c.db, 'SELECT * FROM billing_stages WHERE estimate_id=? ORDER BY position', d.id);
    out.invoices = all(c.db, "SELECT id, number, status, total_cents, conversion_kind FROM documents WHERE source_estimate_id=? AND status<>'void'", d.id);
    out.revisions = all(c.db, 'SELECT id, number, revision_no, status, total_cents, issued_at FROM documents WHERE business_id=? AND type=? AND (id=? OR revision_of_id=? OR id=? OR id IN (SELECT revision_of_id FROM documents WHERE id=?)) ORDER BY revision_no', c.bid, 'estimate', d.id, d.id, d.revision_of_id ?? -1, d.id);
    out.revisions = estimateChain(c, d);
  }
  if (d.type === 'invoice') {
    out.payments = all(c.db, `SELECT p.id, p.paid_date, p.method, p.reference, p.kind, p.verification, p.receipt_number, p.voided_at, a.amount_cents AS allocated_cents, a.voided_at AS allocation_voided_at
      FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id=? ORDER BY p.paid_date, p.id`, d.id);
    out.credit_notes = all(c.db, "SELECT id, number, status, total_cents FROM documents WHERE credit_for_invoice_id=? AND status<>'void'", d.id);
    if (d.source_estimate_id) out.source_estimate = get(c.db, 'SELECT id, number, title FROM documents WHERE id=?', d.source_estimate_id);
  }
  out.communications = all(c.db, 'SELECT id, kind, to_addr, subject, status, error, created_at, sent_at FROM communications WHERE document_id=? ORDER BY id DESC', d.id);
  out.attachments = all(c.db, 'SELECT id, filename, mime, size, created_at FROM attachments WHERE owner_type=? AND owner_id=? AND business_id=?', d.type === 'estimate' ? 'estimate' : 'invoice', d.id, c.bid);
  if (d.status === 'draft' && opts.includeStale !== false) out.stale = staleLines(c, d, raw);
  out.issues = d.status === 'draft' ? validateForIssue(c, d, raw, true) : [];
  return out;
}
function estimateChain(c: Ctx, d: Row): Row[] {
  let root = d; const seen = new Set<number>();
  while (root.revision_of_id && !seen.has(root.id)) { seen.add(root.id); const p = get(c.db, 'SELECT * FROM documents WHERE id=?', root.revision_of_id); if (!p) break; root = p; }
  const chain: Row[] = []; let cur: Row | undefined = root;
  while (cur) { chain.push({ id: cur.id, number: cur.number, revision_no: cur.revision_no, status: cur.status, total_cents: cur.total_cents, issued_at: cur.issued_at }); cur = get(c.db, 'SELECT * FROM documents WHERE revision_of_id=?', cur.id); }
  return chain;
}

export function staleLines(c: Ctx, d: Row, raw?: Row[]) {
  raw ??= all(c.db, 'SELECT * FROM document_lines WHERE document_id=?', d.id);
  const out: Row[] = [];
  const today = bizToday(c.db, c.bid);
  for (const l of raw) {
    if (!l.rc_item_id || l.is_component || l.price_source === 'custom' && l.standard_price_cents === null) continue;
    const item = get(c.db, 'SELECT id FROM rc_items WHERE id=? AND business_id=?', l.rc_item_id, c.bid); if (!item) continue;
    const r = resolvePrice(c, l.rc_item_id, d.client_id, today);
    if (r.item.pricing_type !== 'fixed' && r.source !== 'client_agreement') continue;
    if (l.price_source === 'custom') { if (r.standard_rate_cents !== l.standard_price_cents) out.push({ line_id: l.id, description: l.description, current_price_cents: l.unit_price_cents, new_rate_cents: r.rate_cents, standard_changed: true, custom: true }); continue; }
    if (r.rate_cents !== null && r.rate_cents !== l.unit_price_cents) out.push({ line_id: l.id, description: l.description, current_price_cents: l.unit_price_cents, new_rate_cents: r.rate_cents, source: r.source });
  }
  return out;
}

/** Deliberately refresh drafts' prices from the current rate card for selected lines. */
export function refreshPricing(c: Ctx, id: number, lineIds: number[]) {
  return tx(c.db, () => {
    const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', id, c.bid);
    if (!d) throw notFound('Document'); if (d.status !== 'draft') throw conflict('Only drafts can be refreshed');
    const full = hydrate(c, d, { includeStale: false });
    const today = bizToday(c.db, c.bid);
    const patchLine = (l: Row): Row => {
      const o: Row = { ...l, children: undefined };
      if (lineIds.includes(l.id) && l.rc_item_id) { const r = resolvePrice(c, l.rc_item_id, d.client_id, today); if (r.rate_cents !== null) { o.unit_price_cents = r.rate_cents; o.price_source = r.source; o.rc_item_id = l.rc_item_id; } }
      return o;
    };
    const lines = full.lines.map((l: Row) => ({ ...patchLine(l), children: l.children.map(patchLine) }));
    saveDraft(c, id, d.type, { ...d, lines, stages: undefined });
    audit(c, d.type, id, 'refresh_pricing', { line_ids: lineIds });
  });
}

// ---- Validation & issuing -------------------------------------------------------------------------
export function validateForIssue(c: Ctx, d: Row, raw: Row[], soft = false): { level: 'error' | 'warning'; msg: string }[] {
  const issues: { level: 'error' | 'warning'; msg: string }[] = [];
  const priced = raw.filter((l) => !l.is_component);
  if (!priced.length) issues.push({ level: 'error', msg: 'Add at least one line item' });
  for (const l of priced) {
    if (l.needs_confirmation && !l.price_confirmed) issues.push({ level: 'error', msg: `"${l.description}": the price must be confirmed (custom / starting-from / on-request rate)` });
    if (l.unit_price_cents === 0 && !(l.package_id && l.package_display) && !raw.some((x) => x.parent_line_id === l.id) && l.price_source !== 'stage') issues.push({ level: 'warning', msg: `"${l.description}" has a zero price` });
    if (l.rc_item_id) { const it = get(c.db, 'SELECT min_amount_cents, min_qty_milli, name FROM rc_items WHERE id=?', l.rc_item_id); if (it?.min_qty_milli && l.qty_milli < it.min_qty_milli && l.price_source !== 'custom') issues.push({ level: 'warning', msg: `"${l.description}" is below the minimum quantity` }); if (it?.min_amount_cents && l.amount_cents > 0 && l.amount_cents < it.min_amount_cents) issues.push({ level: 'warning', msg: `"${l.description}" is below the minimum booking amount` }); }
  }
  if (d.total_cents === 0 && priced.length && d.type !== 'estimate') issues.push({ level: 'warning', msg: 'Total is zero' });
  if (d.type === 'invoice' && d.due_date && d.issue_date && d.due_date < d.issue_date) issues.push({ level: 'error', msg: 'Due date is before the issue date' });
  return issues;
}

export function issueDocument(c: Ctx, id: number, opts: { issue_date?: string; due_date?: string } = {}) {
  return tx(c.db, () => {
    const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', id, c.bid);
    if (!d) throw notFound('Document');
    if (d.status !== 'draft') throw conflict('Document has already been issued');
    const raw = all(c.db, 'SELECT * FROM document_lines WHERE document_id=?', id);
    const errors = validateForIssue(c, d, raw).filter((i) => i.level === 'error');
    if (errors.length) throw bad(errors.map((e) => e.msg).join('; '), errors);
    const client = get(c.db, 'SELECT * FROM clients WHERE id=?', d.client_id)!;
    if (client.archived) throw bad('Client is archived');
    const s = getSettings(c.db, c.bid);
    const today = bizToday(c.db, c.bid);
    const issue_date = opts.issue_date ?? d.issue_date ?? today;
    if (!isDate(issue_date)) throw bad('Invalid issue date');
    let due_date = d.due_date, valid_until = d.valid_until;
    if (d.type === 'invoice' && !(opts.due_date ?? due_date)) due_date = addDays(issue_date, client.payment_terms_days ?? s.payment_terms_days);
    if (opts.due_date) due_date = opts.due_date;
    if (d.type === 'estimate' && !valid_until) valid_until = addDays(issue_date, s.estimate_valid_days);
    if (due_date && due_date < issue_date) throw bad('Due date is before the issue date');
    const calc = recalcStored(c, id); // deterministic re-check against stored lines
    if (calc.total_cents !== d.total_cents) throw conflict('Stored totals do not match recalculated totals; save the draft again');
    const number = nextNumber(c.db, c.bid, d.type);
    const biz = get(c.db, 'SELECT * FROM businesses WHERE id=?', c.bid)!;
    const bizSnap = { legal_name: biz.legal_name, trading_name: biz.trading_name, address: biz.address, email: biz.email, phone: biz.phone, website: biz.website, registration_info: biz.registration_info, tax_registration_label: biz.tax_registration_label, tax_registration_number: biz.tax_registration_number, locale: biz.locale };
    const cliSnap = { name: client.name, company: client.company, email: client.email, phone: client.phone, billing_address: client.billing_address };
    run(c.db, `UPDATE documents SET status='issued', number=?, issue_date=?, due_date=?, valid_until=?, business_snapshot=?, client_snapshot=?, template=COALESCE(template, ?), issued_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
      number, issue_date, due_date, valid_until, JSON.stringify(bizSnap), JSON.stringify(cliSnap), s.template, id);
    if (d.type === 'estimate' && d.revision_of_id) run(c.db, "UPDATE documents SET status='superseded', updated_at=datetime('now') WHERE id=? AND status IN ('issued','rejected')", d.revision_of_id);
    if (d.type === 'credit_note') {
      if (!d.credit_for_invoice_id) throw bad('Credit note must reference an invoice');
      const inv = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', d.credit_for_invoice_id, c.bid);
      if (!inv || inv.type !== 'invoice' || inv.status === 'draft' || inv.status === 'void') throw bad('Credit notes apply to issued invoices');
      if (inv.currency !== d.currency) throw bad('Credit note currency must match the invoice');
      if (d.total_cents > balanceOf(inv)) throw bad(`Credit exceeds the invoice's outstanding balance (${(balanceOf(inv) / 100).toFixed(2)}). If it has been paid, record a refund first.`);
      run(c.db, 'UPDATE documents SET credited_cents = credited_cents + ? WHERE id=?', d.total_cents, inv.id);
      audit(c, 'invoice', inv.id, 'credit_applied', { credit_note: number, amount_cents: d.total_cents });
    }
    // link billable time/expense lines (draft links) are already in billing_links
    audit(c, d.type, id, 'issue', { number, total_cents: d.total_cents });
    return getDocument(c, id);
  });
}

/** Recompute totals from stored lines (used for verification). */
export function recalcStored(c: Ctx, id: number) {
  const d = get(c.db, 'SELECT * FROM documents WHERE id=?', id)!;
  const raw = all(c.db, 'SELECT * FROM document_lines WHERE document_id=? ORDER BY position', id);
  return calcDocument({
    lines: raw.map((l) => ({ qty_milli: l.qty_milli, unit_price_cents: l.unit_price_cents, discount_type: l.discount_type, discount_value: l.discount_value, taxes: parseJson(l.taxes, []), tax_exempt: !!l.tax_exempt, is_component: !!l.is_component })),
    prices_include_tax: !!d.prices_include_tax, discount_type: d.discount_type, discount_value: d.discount_value, tax_exempt: !!d.tax_exempt,
  });
}

export function deleteDraft(c: Ctx, id: number) {
  tx(c.db, () => {
    const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', id, c.bid);
    if (!d) throw notFound('Document'); if (d.status !== 'draft') throw conflict('Only drafts can be deleted. Void issued documents instead.');
    audit(c, d.type, id, 'delete_draft_links', { released: all(c.db, 'SELECT source_type, source_id FROM billing_links WHERE document_id=? AND released_at IS NULL', id) });
    run(c.db, 'DELETE FROM billing_links WHERE document_id=?', id); // a deleted draft never billed anything; its time/expenses become available again
    run(c.db, 'UPDATE recurring_runs SET invoice_id=NULL WHERE invoice_id=?', id);
    run(c.db, 'UPDATE billing_stages SET invoice_id=NULL, billed_base_cents=NULL WHERE invoice_id=?', id);
    run(c.db, 'UPDATE documents SET revision_of_id=NULL WHERE revision_of_id=?', id);
    run(c.db, 'DELETE FROM documents WHERE id=?', id);
    audit(c, d.type, id, 'delete_draft');
  });
}

export function voidDocument(c: Ctx, id: number, reason: string) {
  return tx(c.db, () => {
    const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', id, c.bid);
    if (!d) throw notFound('Document');
    if (d.status === 'draft') throw bad('Delete drafts instead of voiding them');
    if (d.status === 'void') throw conflict('Already void');
    const why = reqStr(reason, 'A reason', 500);
    if (d.type === 'invoice') {
      if (d.amount_paid_cents !== 0) throw conflict('This invoice has recorded payments. Void or refund the payments first.');
      if (d.credited_cents > 0) throw conflict('This invoice has credit notes applied. Void those first.');
    }
    if (d.type === 'estimate' && get(c.db, "SELECT 1 FROM documents WHERE source_estimate_id=? AND status<>'void'", id)) throw conflict('Void the invoices created from this estimate first.');
    if (d.type === 'credit_note') {
      run(c.db, 'UPDATE documents SET credited_cents = credited_cents - ? WHERE id=?', d.total_cents, d.credit_for_invoice_id);
    }
    run(c.db, "UPDATE documents SET status='void', void_reason=?, voided_at=datetime('now'), public_revoked=1, updated_at=datetime('now') WHERE id=?", why, id);
    run(c.db, "UPDATE billing_links SET released_at=datetime('now'), release_reason='document voided' WHERE document_id=? AND released_at IS NULL", id);
    run(c.db, 'UPDATE billing_stages SET invoice_id=NULL, billed_base_cents=NULL WHERE invoice_id=?', id);
    audit(c, d.type, id, 'void', { reason: why, number: d.number });
    return getDocument(c, id);
  });
}

export function duplicateDocument(c: Ctx, id: number) {
  return tx(c.db, () => {
    const d = getDocument(c, id, { includeStale: false });
    if (d.type === 'credit_note') throw bad('Credit notes cannot be duplicated');
    const strip = (l: Row): Row => ({ ...l, id: undefined, children: l.children?.map(strip) });
    const nid = saveDraft(c, null, d.type, { ...d, issue_date: null, due_date: null, valid_until: null, po_ref: null, lines: d.lines.map(strip), stages: d.stages?.map((s: Row) => ({ label: s.label, kind: s.kind, value: s.value, due_days: s.due_days })) });
    audit(c, d.type, nid, 'duplicate', { from: id });
    return nid;
  });
}

// ---- Estimate lifecycle -------------------------------------------------------------------------------
export function acceptEstimate(c: Ctx, id: number, b: { by?: string | null; note?: string | null; method?: 'manual' | 'public_link' }) {
  return tx(c.db, () => {
    const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=? AND type=\'estimate\'', id, c.bid);
    if (!d) throw notFound('Estimate'); if (d.status !== 'issued') throw conflict(`Only issued estimates can be accepted (status: ${d.status})`);
    const today = bizToday(c.db, c.bid);
    if (d.valid_until && d.valid_until < today && b.method !== 'manual') throw conflict('This estimate has expired');
    run(c.db, "UPDATE documents SET status='accepted', accepted_at=datetime('now'), accepted_by=?, acceptance_method=?, acceptance_note=?, updated_at=datetime('now') WHERE id=?",
      str(b.by, 200), b.method ?? 'manual', str(b.note, 1000), id);
    audit(c, 'estimate', id, 'accept', { method: b.method ?? 'manual', by: b.by });
  });
}
export function rejectEstimate(c: Ctx, id: number, note: string | null) {
  return tx(c.db, () => {
    const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=? AND type=\'estimate\'', id, c.bid);
    if (!d) throw notFound('Estimate'); if (d.status !== 'issued') throw conflict('Only issued estimates can be rejected');
    run(c.db, "UPDATE documents SET status='rejected', rejected_at=datetime('now'), rejection_note=?, updated_at=datetime('now') WHERE id=?", str(note, 1000), id);
    audit(c, 'estimate', id, 'reject', { note });
  });
}
export function reviseEstimate(c: Ctx, id: number) {
  return tx(c.db, () => {
    const d = getDocument(c, id, { includeStale: false });
    if (d.type !== 'estimate') throw bad('Only estimates can be revised');
    if (!['issued', 'rejected'].includes(d.status)) throw conflict('Only issued or rejected estimates can be revised (accepted estimates are agreed — create a change estimate instead)');
    if (get(c.db, "SELECT 1 FROM documents WHERE revision_of_id=? AND status<>'void'", id)) throw conflict('A newer revision already exists');
    const strip = (l: Row): Row => ({ ...l, id: undefined, children: l.children?.map(strip) });
    const nid = saveDraft(c, null, 'estimate', { ...d, issue_date: null, valid_until: null, lines: d.lines.map(strip), stages: d.stages.map((s: Row) => ({ label: s.label, kind: s.kind, value: s.value, due_days: s.due_days })) });
    run(c.db, 'UPDATE documents SET revision_of_id=?, revision_no=? WHERE id=?', id, d.revision_no + 1, nid);
    audit(c, 'estimate', nid, 'revise', { from: id, from_number: d.number });
    return nid;
  });
}

// ---- Conversion: estimate -> invoice ----------------------------------------------------------------------
export function convertEstimate(c: Ctx, id: number, b: { mode?: 'full' | 'stage'; stage_id?: number }) {
  return tx(c.db, () => {
    const est = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=? AND type=\'estimate\'', id, c.bid);
    if (!est) throw notFound('Estimate');
    if (est.status !== 'accepted') throw conflict('Only accepted estimates can be converted to invoices. Record the acceptance first.');
    const mode = b.mode ?? 'full';
    const full = hydrate(c, est, { includeStale: false });
    const existing = all(c.db, "SELECT id, number, conversion_kind FROM documents WHERE source_estimate_id=? AND status<>'void'", id);
    const strip = (l: Row): Row => ({ ...l, id: undefined, parent_line_id: undefined, children: l.children?.map(strip) });
    if (mode === 'full') {
      if (existing.length) throw conflict(`This estimate has already been invoiced (${existing.map((e) => e.number ?? 'draft #' + e.id).join(', ')}). Void those invoices first to convert again.`);
      const nid = saveDraft(c, null, 'invoice', {
        client_id: est.client_id, project_id: est.project_id, currency: est.currency, prices_include_tax: est.prices_include_tax, tax_exempt: est.tax_exempt, tax_exempt_note: est.tax_exempt_note,
        discount_type: est.discount_type, discount_value: est.discount_value, notes: est.notes, payment_instructions: est.payment_instructions, po_ref: est.po_ref, title: est.title, template: est.template,
        lines: full.lines.map(strip),
      });
      run(c.db, "UPDATE documents SET source_estimate_id=?, conversion_kind='full', terms=NULL WHERE id=?", id, nid);
      audit(c, 'estimate', id, 'convert', { invoice_id: nid, mode });
      return nid;
    }
    // stage mode
    if (existing.some((e) => e.conversion_kind === 'full')) throw conflict('This estimate was already fully invoiced');
    const stages = full.stages as Row[];
    const stage = stages.find((s) => s.id === b.stage_id);
    if (!stage) throw bad('Choose a payment stage to invoice');
    if (stage.invoice_id) throw conflict('That stage has already been invoiced');
    // groups by tax signature on after-discount entered basis
    const flat = full.lines.flatMap((l: Row) => [l, ...l.children]).filter((l: Row) => !l.is_component && (l.net_cents - l.doc_discount_cents) !== 0);
    const groups = new Map<string, { base: number; taxes: Row[]; exempt: number; label: string }>();
    for (const l of flat) {
      const sig = JSON.stringify([l.tax_exempt, l.taxes.map((t: Row) => [t.id, t.name, t.rate_milli])]);
      const g = groups.get(sig) ?? { base: 0, taxes: l.taxes, exempt: l.tax_exempt, label: l.description };
      g.base += l.net_cents - l.doc_discount_cents; groups.set(sig, g);
    }
    const totalBase = [...groups.values()].reduce((a, g) => a + g.base, 0);
    const billed = stages.filter((s) => s.invoice_id).reduce((a, s) => a + (s.billed_base_cents ?? 0), 0);
    let stageBase: number;
    if (stage.kind === 'percent') stageBase = roundDiv(totalBase * stage.value, PCT_SCALE);
    else if (stage.kind === 'fixed') stageBase = stage.value;
    else stageBase = totalBase - billed;
    if (stageBase <= 0) throw bad('Nothing left to invoice for this stage');
    if (billed + stageBase > totalBase) throw conflict('Invoicing this stage would exceed the estimate total');
    const gl = [...groups.values()];
    const shares = allocate(stageBase, gl.map((g) => g.base));
    const title = est.title ? ` — ${est.title}` : '';
    const lines = gl.map((g, i) => ({
      description: `${stage.label} (Estimate ${est.number}${title})${gl.length > 1 ? ` — ${g.label}${gl.length > 2 ? ' & others' : ''}` : ''}`, unit: 'stage', qty_milli: 1000, unit_price_cents: shares[i],
      price_source: 'stage', taxes: g.taxes, tax_exempt: g.exempt,
    })).filter((l) => l.unit_price_cents !== 0);
    const s = getSettings(c.db, c.bid); const today = bizToday(c.db, c.bid);
    const nid = saveDraft(c, null, 'invoice', {
      client_id: est.client_id, project_id: est.project_id, currency: est.currency, prices_include_tax: est.prices_include_tax, tax_exempt: est.tax_exempt, tax_exempt_note: est.tax_exempt_note,
      payment_instructions: est.payment_instructions, po_ref: est.po_ref, title: est.title, template: est.template, lines,
      due_date: stage.due_days != null ? addDays(today, stage.due_days) : undefined,
      notes: `${stage.label}: ${stage.kind === 'percent' ? stage.value / 1000 + '% of estimate' : stage.kind === 'balance' ? 'remaining balance' : 'fixed amount'} ${est.number}.`,
    });
    void s;
    run(c.db, "UPDATE documents SET source_estimate_id=?, conversion_kind='stage' WHERE id=?", id, nid);
    run(c.db, 'UPDATE billing_stages SET invoice_id=?, billed_base_cents=? WHERE id=?', nid, stageBase, stage.id);
    audit(c, 'estimate', id, 'convert', { invoice_id: nid, mode, stage: stage.label, base_cents: stageBase });
    return nid;
  });
}

// ---- Credit notes ----------------------------------------------------------------------------------------------------
export function createCreditNoteDraft(c: Ctx, invoiceId: number, b: Row) {
  return tx(c.db, () => {
    const inv = getDocument(c, invoiceId, { includeStale: false });
    if (inv.type !== 'invoice' || ['draft', 'void'].includes(inv.status)) throw bad('Credit notes apply to issued invoices');
    let lines: Row[];
    if (b.mode === 'full') {
      const strip = (l: Row): Row => ({ ...l, id: undefined, rc_item_id: undefined, children: l.children?.map(strip) });
      lines = inv.lines.map(strip);
    } else lines = Array.isArray(b.lines) ? b.lines : [];
    const nid = saveDraft(c, null, 'credit_note', {
      client_id: inv.client_id, project_id: inv.project_id, currency: inv.currency, prices_include_tax: inv.prices_include_tax, tax_exempt: inv.tax_exempt,
      discount_type: b.mode === 'full' ? inv.discount_type : 'none', discount_value: b.mode === 'full' ? inv.discount_value : 0,
      notes: str(b.reason, 1000) ?? null, credit_for_invoice_id: invoiceId, lines, title: `Credit for ${inv.number}`,
    });
    return nid;
  });
}

// ---- Public links ---------------------------------------------------------------------------------------------------
export function createPublicLink(c: Ctx, id: number, days?: number) {
  const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', id, c.bid);
  if (!d) throw notFound('Document'); if (d.status === 'draft' || d.status === 'void') throw bad('Only issued documents can be shared');
  const ttl = days ?? getSettings(c.db, c.bid).public_link_days;
  const token = randomToken(32);
  run(c.db, 'UPDATE documents SET public_token_hash=?, public_expires_at=?, public_revoked=0 WHERE id=?', sha256(token), new Date(Date.now() + ttl * 864e5).toISOString(), id);
  audit(c, d.type, id, 'public_link_created', { days: ttl });
  return { token, expires_at: new Date(Date.now() + ttl * 864e5).toISOString() };
}
export function revokePublicLink(c: Ctx, id: number) {
  const r = run(c.db, 'UPDATE documents SET public_revoked=1 WHERE id=? AND business_id=?', id, c.bid);
  if (!Number(r.changes)) throw notFound('Document');
  audit(c, 'document', id, 'public_link_revoked');
}
export function documentByToken(db: any, token: string): Row | null {
  if (!token || token.length < 20 || token.length > 100) return null;
  const d = get(db, 'SELECT * FROM documents WHERE public_token_hash = ?', sha256(token));
  if (!d || d.public_revoked || d.status === 'draft' || d.status === 'void') return null;
  if (d.public_expires_at && new Date(d.public_expires_at).getTime() < Date.now()) return null;
  return d;
}

// ---- Listing ---------------------------------------------------------------------------------------------------------
export function listDocuments(c: Ctx, type: DocType, q: Row) {
  const where = ['d.business_id = ?', 'd.type = ?']; const p: any[] = [c.bid, type];
  if (q.client_id) { where.push('d.client_id = ?'); p.push(Number(q.client_id)); }
  if (q.project_id) { where.push('d.project_id = ?'); p.push(Number(q.project_id)); }
  if (q.currency) { where.push('d.currency = ?'); p.push(String(q.currency)); }
  if (q.from) { where.push('d.issue_date >= ?'); p.push(q.from); }
  if (q.to) { where.push('d.issue_date <= ?'); p.push(q.to); }
  if (q.search) { where.push("(d.number LIKE ? OR cl.name LIKE ? OR d.title LIKE ? OR d.po_ref LIKE ?)"); const s = `%${String(q.search).replace(/[%_]/g, '')}%`; p.push(s, s, s, s); }
  const rows = all(c.db, `SELECT d.id, d.number, d.type, d.status, d.client_id, cl.name AS client_name, d.project_id, d.currency, d.issue_date, d.due_date, d.valid_until, d.title, d.total_cents,
    d.amount_paid_cents, d.credited_cents, d.disputed, d.revision_no, d.created_at, d.source_estimate_id, d.credit_for_invoice_id,
    EXISTS (SELECT 1 FROM documents x WHERE x.source_estimate_id = d.id AND x.status <> 'void') AS has_invoice
    FROM documents d JOIN clients cl ON cl.id = d.client_id WHERE ${where.join(' AND ')} ORDER BY COALESCE(d.issue_date, d.created_at) DESC, d.id DESC LIMIT 1000`, ...p);
  const today = bizToday(c.db, c.bid);
  const out = rows.map((r) => ({ ...r, display_status: displayStatus(r, today, !!r.has_invoice), balance_cents: type === 'invoice' ? balanceOf(r) : null }));
  return q.status ? out.filter((r) => r.display_status === q.status) : out;
}

// ---- Billable time & expenses --------------------------------------------------------------------------------------
export function addBillableToDraft(c: Ctx, invoiceId: number, b: { time_entry_ids?: number[]; expense_ids?: number[]; override?: boolean }) {
  return tx(c.db, () => {
    const d = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', invoiceId, c.bid);
    if (!d || d.type !== 'invoice') throw notFound('Invoice'); if (d.status !== 'draft') throw conflict('Only draft invoices can receive billable items');
    const full = hydrate(c, d, { includeStale: false });
    const lines: Row[] = full.lines.map((l: Row) => ({ ...l, children: l.children }));
    const s = getSettings(c.db, c.bid);
    const defTaxes = all(c.db, `SELECT id, name, rate_milli FROM tax_codes WHERE business_id=? AND active=1 AND id IN (${(s.default_tax_ids.length ? s.default_tax_ids : [0]).map(() => '?').join(',')})`, c.bid, ...(s.default_tax_ids.length ? s.default_tax_ids : [0]));
    const pending: { type: 'time' | 'expense'; id: number; lineIdx: number }[] = [];
    for (const tid of b.time_entry_ids ?? []) {
      const t = get(c.db, 'SELECT * FROM time_entries WHERE id=? AND business_id=?', tid, c.bid); if (!t) throw notFound('Time entry');
      if (t.client_id !== d.client_id) throw bad('Time entry belongs to a different client'); if (!t.billable) throw bad('Time entry is not billable');
      const hours = roundDiv(t.minutes * 1000, 60);
      lines.push({ description: `${t.notes || 'Time'} (${t.entry_date})`, unit: 'hour', qty_milli: hours, unit_price_cents: t.rate_cents, price_source: 'time', taxes: defTaxes, rc_item_id: t.rc_item_id ?? undefined });
      pending.push({ type: 'time', id: tid, lineIdx: lines.length - 1 });
    }
    for (const eid of b.expense_ids ?? []) {
      const e = get(c.db, 'SELECT * FROM expenses WHERE id=? AND business_id=?', eid, c.bid); if (!e) throw notFound('Expense');
      if (e.client_id !== d.client_id) throw bad('Expense belongs to a different client'); if (!e.billable) throw bad('Expense is not billable');
      if (e.currency !== d.currency) throw bad('Expense currency differs from the invoice currency');
      const amount = e.amount_cents - (e.tax_cents ?? 0) + roundDiv((e.amount_cents - e.tax_cents) * e.billable_markup_milli, PCT_SCALE);
      lines.push({ description: `${e.merchant ? e.merchant + ' — ' : ''}${e.description || 'Expense'} (${e.expense_date})`, unit: 'item', qty_milli: 1000, unit_price_cents: amount, price_source: 'expense', taxes: defTaxes });
      pending.push({ type: 'expense', id: eid, lineIdx: lines.length - 1 });
    }
    for (const p of pending) {
      const active = get(c.db, 'SELECT * FROM billing_links WHERE source_type=? AND source_id=? AND released_at IS NULL', p.type, p.id);
      if (active) {
        if (!b.override) throw conflict(`That ${p.type === 'time' ? 'time entry' : 'expense'} has already been invoiced (document #${active.document_id}). Use the override only if this is intentional.`);
        run(c.db, "UPDATE billing_links SET released_at=datetime('now'), release_reason=? WHERE id=?", `override by user ${c.uid}`, active.id);
        audit(c, p.type, p.id, 'rebill_override', { previous_document: active.document_id, new_document: invoiceId });
      }
    }
    saveDraft(c, invoiceId, 'invoice', { ...d, lines: lines.map((l) => ({ ...l, id: undefined })) });
    // link to the new rows by position (appended last)
    const saved = all(c.db, 'SELECT id, price_source, position FROM document_lines WHERE document_id=? AND parent_line_id IS NULL ORDER BY position', invoiceId);
    const baseCount = full.lines.length;
    pending.forEach((p, i) => {
      const row = saved[baseCount + i];
      insert(c.db, 'INSERT INTO billing_links (business_id, source_type, source_id, document_id, line_id) VALUES (?,?,?,?,?)', c.bid, p.type, p.id, invoiceId, row.id);
    });
    return getDocument(c, invoiceId);
  });
}

export function verifyDocument(c: Ctx, id: number) {
  const d = get(c.db, 'SELECT * FROM documents WHERE id=?', id)!;
  const calc = recalcStored(c, id);
  const paid = Number(get(c.db, 'SELECT COALESCE(SUM(amount_cents),0) AS s FROM payment_allocations WHERE invoice_id=? AND voided_at IS NULL', id)!.s);
  return { ok: calc.total_cents === d.total_cents && calc.tax_total_cents === d.tax_total_cents && (d.type !== 'invoice' || paid === d.amount_paid_cents), calc_total: calc.total_cents, stored_total: d.total_cents, alloc_paid: paid, stored_paid: d.amount_paid_cents };
}
void lineAmount; void getItem;
