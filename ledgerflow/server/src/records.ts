import fs from 'node:fs';
import { all, get, run, insert, tx } from './db.ts';
import type { Row } from './db.ts';
import { type Ctx, bad, notFound, conflict, str, reqStr, int, bool, oneOf, optDate, currencyCode, audit, ensureOwned, sha256, getSettings, saveSettings, bizToday } from './core.ts';
import { balanceOf } from './documents.ts';
import { roundDiv } from './money.ts';

export const CA_TAX_PRESETS = [
  { name: 'GST', rate_milli: 5000, note: 'Federal goods and services tax (5%)' },
  { name: 'HST (ON)', rate_milli: 13000, note: 'Ontario harmonized sales tax (13%)' },
  { name: 'HST (NB/NL/PE)', rate_milli: 15000, note: 'New Brunswick, Newfoundland and Labrador, PEI (15%)' },
  { name: 'HST (NS)', rate_milli: 14000, note: 'Nova Scotia (14% since 1 Apr 2025)' },
  { name: 'PST (BC)', rate_milli: 7000, note: 'British Columbia provincial sales tax (7%)' },
  { name: 'PST (SK)', rate_milli: 6000, note: 'Saskatchewan provincial sales tax (6%)' },
  { name: 'RST (MB)', rate_milli: 7000, note: 'Manitoba retail sales tax (7%)' },
  { name: 'QST', rate_milli: 9975, note: 'Québec sales tax (9.975%)' },
];
export const DEFAULT_EXPENSE_CATEGORIES = ['Software subscriptions', 'Equipment', 'Travel', 'Transportation', 'Advertising', 'Contractor costs', 'Event expenses', 'Office expenses', 'Phone and internet', 'Professional services', 'Other'];

// ---- Businesses ------------------------------------------------------------------------------
export function createBusiness(db: any, userId: number, b: Row): number {
  return tx(db, () => {
    const legal = reqStr(b.legal_name, 'Legal business name', 200);
    const id = insert(db, `INSERT INTO businesses (legal_name, trading_name, address, email, phone, website, registration_info, tax_registration_label, tax_registration_number, currency, timezone, locale, date_format)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, legal, str(b.trading_name, 200), str(b.address, 500), str(b.email, 200), str(b.phone, 60), str(b.website, 200), str(b.registration_info, 300),
      str(b.tax_registration_label, 60), str(b.tax_registration_number, 60), currencyCode(b.currency, 'CAD'), str(b.timezone, 60) ?? 'America/Toronto', str(b.locale, 20) ?? 'en-CA', str(b.date_format, 20) ?? 'YYYY-MM-DD');
    insert(db, 'INSERT INTO memberships (user_id, business_id, role) VALUES (?,?,?)', userId, id, 'owner');
    for (const [kind, prefix, padding] of [['invoice', 'INV-', 4], ['estimate', 'EST-', 4], ['credit_note', 'CN-', 4], ['receipt', 'RCT-', 4]] as const)
      insert(db, 'INSERT INTO number_sequences (business_id, kind, prefix, next_number, padding) VALUES (?,?,?,?,?)', id, kind, prefix, 1, padding);
    for (const n of DEFAULT_EXPENSE_CATEGORIES) insert(db, 'INSERT INTO expense_categories (business_id, name) VALUES (?,?)', id, n);
    audit({ db, bid: id, uid: userId }, 'business', id, 'create');
    return id;
  });
}
const BIZ_FIELDS = ['legal_name', 'trading_name', 'address', 'email', 'phone', 'website', 'registration_info', 'tax_registration_label', 'tax_registration_number', 'timezone', 'locale', 'date_format'] as const;
export function updateBusiness(c: Ctx, b: Row) {
  const cur = get(c.db, 'SELECT * FROM businesses WHERE id=?', c.bid)!;
  const vals: Row = {};
  for (const f of BIZ_FIELDS) vals[f] = b[f] === undefined ? cur[f] : (f === 'legal_name' ? reqStr(b[f], 'Legal business name', 200) : str(b[f], 500));
  if (b.currency !== undefined && b.currency !== cur.currency) {
    if (get(c.db, "SELECT 1 FROM documents WHERE business_id=? AND status<>'draft' LIMIT 1", c.bid)) throw conflict('The default currency cannot be changed once documents have been issued. Set a currency per client or document instead.');
    vals.currency = currencyCode(b.currency, cur.currency);
  }
  const keys = Object.keys(vals);
  run(c.db, `UPDATE businesses SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => vals[k]), c.bid);
  audit(c, 'business', c.bid, 'update');
}
export function getBusiness(c: Ctx) {
  const b = get(c.db, 'SELECT id, legal_name, trading_name, address, email, phone, website, registration_info, tax_registration_label, tax_registration_number, currency, timezone, locale, date_format, (logo IS NOT NULL) AS has_logo FROM businesses WHERE id=?', c.bid)!;
  return { ...b, settings: getSettings(c.db, c.bid), sequences: all(c.db, 'SELECT kind, prefix, next_number, padding FROM number_sequences WHERE business_id=?', c.bid) };
}
export function updateSequence(c: Ctx, kind: string, b: Row) {
  oneOf(kind, ['invoice', 'estimate', 'credit_note', 'receipt'] as const, 'kind');
  const prefix = str(b.prefix, 20) ?? ''; if (!/^[A-Za-z0-9\-_/.]*$/.test(prefix)) throw bad('Prefix may contain letters, digits and - _ / . only');
  const padding = int(b.padding ?? 4, 'padding', { min: 1, max: 10 })!;
  const cur = get(c.db, 'SELECT * FROM number_sequences WHERE business_id=? AND kind=?', c.bid, kind)!;
  const next = b.next_number !== undefined ? int(b.next_number, 'next number', { min: 1 })! : cur.next_number;
  const type = kind === 'receipt' ? null : kind;
  if (next < cur.next_number || prefix !== cur.prefix) {
    // never allow a collision with an already-used number
    const probe = `${prefix}${String(next).padStart(padding, '0')}`;
    const used = kind === 'receipt' ? get(c.db, 'SELECT 1 FROM payments WHERE business_id=? AND receipt_number>=?', c.bid, probe) : get(c.db, 'SELECT 1 FROM documents WHERE business_id=? AND type=? AND number>=? AND number LIKE ?', c.bid, type, probe, prefix + '%');
    if (next < cur.next_number && used) throw conflict('That number is not higher than numbers already used');
  }
  run(c.db, 'UPDATE number_sequences SET prefix=?, padding=?, next_number=? WHERE business_id=? AND kind=?', prefix, padding, next, c.bid, kind);
  audit(c, 'numbering', null, 'update', { kind, prefix, next });
}

// ---- Taxes ------------------------------------------------------------------------------------------
export function listTaxes(c: Ctx) { return all(c.db, 'SELECT * FROM tax_codes WHERE business_id=? ORDER BY name', c.bid); }
export function saveTax(c: Ctx, id: number | null, b: Row) {
  const name = reqStr(b.name, 'Tax name', 60); const rate = int(b.rate_milli, 'rate', { min: 0, max: 100000 })!;
  try {
    if (id) { ensureOwned(c.db, 'tax_codes', id, c.bid, 'Tax'); run(c.db, 'UPDATE tax_codes SET name=?, rate_milli=?, note=?, active=? WHERE id=?', name, rate, str(b.note, 300), b.active === undefined ? 1 : bool(b.active), id);
      audit(c, 'tax', id, 'update', { name, rate_milli: rate }); return id; }
    const nid = insert(c.db, 'INSERT INTO tax_codes (business_id, name, rate_milli, note) VALUES (?,?,?,?)', c.bid, name, rate, str(b.note, 300)); audit(c, 'tax', nid, 'create', { name, rate_milli: rate }); return nid;
  } catch (e: any) { if (/UNIQUE/.test(String(e.message))) throw conflict('A tax with that name exists'); throw e; }
}

// ---- Clients ----------------------------------------------------------------------------------------------
export function saveClient(c: Ctx, id: number | null, b: Row) {
  return tx(c.db, () => {
    const cur = id ? ensureOwned(c.db, 'clients', id, c.bid, 'Client') : null;
    const v = {
      type: oneOf(b.type ?? cur?.type, ['individual', 'business'] as const, 'type', 'business'), name: reqStr(b.name ?? cur?.name, 'Client name', 200), company: str(b.company, 200), email: str(b.email, 200), phone: str(b.phone, 60),
      billing_address: str(b.billing_address, 500), service_address: str(b.service_address, 500), currency: b.currency ? currencyCode(b.currency, 'CAD') : null,
      payment_terms_days: int(b.payment_terms_days, 'payment terms', { min: 0, max: 365, optional: true }), tax_exempt: bool(b.tax_exempt), tax_exempt_note: str(b.tax_exempt_note, 300),
      notes: str(b.notes, 5000), tags: JSON.stringify(Array.isArray(b.tags) ? b.tags.map((t: unknown) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20) : []), archived: bool(b.archived),
    };
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw bad('Email address looks invalid');
    if (v.tax_exempt && !v.tax_exempt_note) throw bad('Explain the tax exemption (e.g. status card or certificate reference)');
    const keys = Object.keys(v);
    let cid: number;
    if (cur) { run(c.db, `UPDATE clients SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`, ...keys.map((k) => (v as any)[k]), cur.id); cid = cur.id; }
    else cid = insert(c.db, `INSERT INTO clients (business_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, c.bid, ...keys.map((k) => (v as any)[k]));
    if (Array.isArray(b.contacts)) {
      run(c.db, 'DELETE FROM client_contacts WHERE client_id=?', cid);
      for (const k of b.contacts) if (str(k.name, 200)) insert(c.db, 'INSERT INTO client_contacts (client_id, name, role, email, phone, is_primary) VALUES (?,?,?,?,?,?)', cid, str(k.name, 200), str(k.role, 100), str(k.email, 200), str(k.phone, 60), bool(k.is_primary));
    }
    audit(c, 'client', cid, cur ? 'update' : 'create');
    return cid;
  });
}
export function listClients(c: Ctx, q: Row): Row[] {
  const where = ['c.business_id=?']; const p: any[] = [c.bid];
  if (q.archived === '1') where.push('c.archived=1'); else if (q.archived !== 'all') where.push('c.archived=0');
  if (q.search) { where.push("(c.name LIKE ? OR c.company LIKE ? OR c.email LIKE ? OR c.tags LIKE ?)"); const s = `%${String(q.search).replace(/[%_]/g, '')}%`; p.push(s, s, s, s); }
  if (q.tag) { where.push('c.tags LIKE ?'); p.push(`%"${String(q.tag).replace(/[%_"]/g, '')}"%`); }
  return all(c.db, `SELECT c.*, 
    COALESCE((SELECT SUM(d.total_cents - d.amount_paid_cents - d.credited_cents) FROM documents d WHERE d.client_id=c.id AND d.type='invoice' AND d.status='issued'),0) AS outstanding_cents,
    COALESCE((SELECT SUM(d.total_cents) FROM documents d WHERE d.client_id=c.id AND d.type='invoice' AND d.status='issued'),0) AS invoiced_cents
    FROM clients c WHERE ${where.join(' AND ')} ORDER BY c.name COLLATE NOCASE`, ...p).map((r): Row => ({ ...r, tags: JSON.parse(r.tags) }));
}
export function getClient(c: Ctx, id: number) {
  const cl = ensureOwned(c.db, 'clients', id, c.bid, 'Client'); cl.tags = JSON.parse(cl.tags);
  cl.contacts = all(c.db, 'SELECT * FROM client_contacts WHERE client_id=? ORDER BY is_primary DESC, id', id);
  cl.prices = all(c.db, `SELECT cp.*, i.name AS item_name, i.unit, i.rate_cents AS standard_rate_cents FROM client_prices cp JOIN rc_items i ON i.id=cp.item_id WHERE cp.client_id=? ORDER BY cp.active DESC, i.name`, id);
  cl.estimates = all(c.db, "SELECT id, number, status, title, total_cents, currency, issue_date, valid_until FROM documents WHERE client_id=? AND type='estimate' ORDER BY id DESC LIMIT 100", id);
  cl.invoices = all(c.db, "SELECT id, number, status, title, total_cents, amount_paid_cents, credited_cents, currency, issue_date, due_date FROM documents WHERE client_id=? AND type='invoice' ORDER BY id DESC LIMIT 200", id)
    .map((d) => ({ ...d, type: 'invoice', balance_cents: balanceOf(d), display_status: dispInv(d, bizToday(c.db, c.bid)) }));
  cl.payments = all(c.db, 'SELECT id, paid_date, amount_cents, currency, method, reference, kind, voided_at, receipt_number FROM payments WHERE client_id=? ORDER BY paid_date DESC, id DESC LIMIT 100', id);
  cl.projects = all(c.db, 'SELECT * FROM projects WHERE client_id=? ORDER BY id DESC', id);
  cl.expenses = all(c.db, 'SELECT id, expense_date, merchant, description, amount_cents, currency, billable FROM expenses WHERE client_id=? ORDER BY expense_date DESC LIMIT 100', id);
  cl.totals = all(c.db, `SELECT currency, SUM(total_cents) AS invoiced_cents, SUM(amount_paid_cents) AS paid_cents, SUM(total_cents - amount_paid_cents - credited_cents) AS outstanding_cents
    FROM documents WHERE client_id=? AND type='invoice' AND status='issued' GROUP BY currency`, id);
  cl.activity = all(c.db, "SELECT action, entity, entity_id, detail, created_at FROM audit_events WHERE business_id=? AND ((entity='client' AND entity_id=?) OR (entity IN ('invoice','estimate') AND entity_id IN (SELECT id FROM documents WHERE client_id=?))) ORDER BY id DESC LIMIT 20", c.bid, id, id);
  return cl;
}
function dispInv(d: Row, today: string) {
  const bal = balanceOf(d); if (d.status !== 'issued') return d.status;
  if (bal <= 0) return 'paid'; if (d.due_date && d.due_date < today) return 'overdue'; return d.amount_paid_cents > 0 ? 'partially_paid' : 'issued';
}

export function saveClientPrice(c: Ctx, clientId: number, id: number | null, b: Row) {
  ensureOwned(c.db, 'clients', clientId, c.bid, 'Client');
  const itemId = int(b.item_id, 'service', { min: 1 })!; const item = ensureOwned(c.db, 'rc_items', itemId, c.bid, 'Rate card item');
  const rate = int(b.rate_cents, 'negotiated rate', { min: 0, max: 1e11 })!;
  const from = optDate(b.valid_from, 'Valid from'), to = optDate(b.valid_to, 'Valid to'); if (from && to && to < from) throw bad('Valid-to is before valid-from');
  if (id) { run(c.db, 'UPDATE client_prices SET rate_cents=?, note=?, valid_from=?, valid_to=?, active=? WHERE id=? AND client_id=? AND business_id=?', rate, str(b.note, 300), from, to, b.active === undefined ? 1 : bool(b.active), id, clientId, c.bid); audit(c, 'client_price', id, 'update', { rate_cents: rate }); return id; }
  const nid = insert(c.db, 'INSERT INTO client_prices (business_id, client_id, item_id, rate_cents, note, valid_from, valid_to) VALUES (?,?,?,?,?,?,?)', c.bid, clientId, itemId, rate, str(b.note, 300), from, to);
  audit(c, 'client_price', nid, 'create', { client_id: clientId, item: item.name, rate_cents: rate, standard_cents: item.rate_cents });
  return nid;
}

// ---- Projects, time ---------------------------------------------------------------------------------
export function saveProject(c: Ctx, id: number | null, b: Row) {
  const cur = id ? ensureOwned(c.db, 'projects', id, c.bid, 'Project') : null;
  const client = ensureOwned(c.db, 'clients', b.client_id ?? cur?.client_id, c.bid, 'Client');
  const v = { client_id: client.id, name: reqStr(b.name, 'Project name', 200), status: oneOf(b.status, ['lead', 'active', 'on_hold', 'completed', 'cancelled'] as const, 'status', 'active'), start_date: optDate(b.start_date, 'Start date'), end_date: optDate(b.end_date, 'End date'),
    budget_cents: int(b.budget_cents, 'budget', { min: 0, optional: true }), currency: currencyCode(b.currency ?? cur?.currency ?? client.currency, (get(c.db, 'SELECT currency FROM businesses WHERE id=?', c.bid)!.currency as string)), scope: str(b.scope, 8000), notes: str(b.notes, 5000) };
  if (v.start_date && v.end_date && v.end_date < v.start_date) throw bad('End date is before the start date');
  const keys = Object.keys(v);
  if (cur) { run(c.db, `UPDATE projects SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => (v as any)[k]), cur.id); audit(c, 'project', cur.id, 'update'); return cur.id; }
  const nid = insert(c.db, `INSERT INTO projects (business_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, c.bid, ...keys.map((k) => (v as any)[k])); audit(c, 'project', nid, 'create'); return nid;
}
export function projectFinancials(c: Ctx, id: number) {
  const p = ensureOwned(c.db, 'projects', id, c.bid, 'Project');
  const inv = get(c.db, `SELECT COALESCE(SUM(total_cents),0) invoiced, COALESCE(SUM(amount_paid_cents),0) received, COALESCE(SUM(total_cents-amount_paid_cents-credited_cents),0) outstanding FROM documents WHERE project_id=? AND type='invoice' AND status='issued'`, id)!;
  const est = get(c.db, `SELECT COALESCE(SUM(total_cents),0) accepted FROM documents WHERE project_id=? AND type='estimate' AND status='accepted'`, id)!;
  const exp = get(c.db, `SELECT COALESCE(SUM(amount_cents - tax_cents),0) expenses, COALESCE(SUM(CASE WHEN billable=1 THEN amount_cents - tax_cents ELSE 0 END),0) billable FROM expenses WHERE project_id=? AND currency=?`, id, p.currency)!;
  const time = get(c.db, `SELECT COALESCE(SUM(minutes),0) minutes, COALESCE(SUM(CASE WHEN billable=1 THEN minutes*rate_cents/60 ELSE 0 END),0) value FROM time_entries WHERE project_id=?`, id)!;
  const unbilledTime = get(c.db, `SELECT COALESCE(SUM(t.minutes*t.rate_cents/60),0) v FROM time_entries t WHERE t.project_id=? AND t.billable=1 AND NOT EXISTS (SELECT 1 FROM billing_links l WHERE l.source_type='time' AND l.source_id=t.id AND l.released_at IS NULL)`, id)!;
  return { project: p, currency: p.currency, invoiced_cents: Number(inv.invoiced), received_cents: Number(inv.received), outstanding_cents: Number(inv.outstanding), accepted_estimates_cents: Number(est.accepted),
    expenses_cents: Number(exp.expenses), billable_expenses_cents: Number(exp.billable), time_minutes: Number(time.minutes), time_value_cents: Math.round(Number(time.value)), unbilled_time_value_cents: Math.round(Number(unbilledTime.v)),
    budget_cents: p.budget_cents, budget_remaining_cents: p.budget_cents == null ? null : p.budget_cents - Number(inv.invoiced),
    note: 'Invoiced and received are actual issued-invoice figures. Time value is an estimate until invoiced. Expenses exclude recoverable tax.' };
}
export function saveTime(c: Ctx, id: number | null, b: Row) {
  const client = ensureOwned(c.db, 'clients', b.client_id, c.bid, 'Client');
  let projectId: number | null = null;
  if (b.project_id) { const p = ensureOwned(c.db, 'projects', b.project_id, c.bid, 'Project'); if (p.client_id !== client.id) throw bad('Project belongs to a different client'); projectId = p.id; }
  const minutes = b.minutes !== undefined ? int(b.minutes, 'minutes', { min: 1, max: 24 * 60 })! : Math.round(Number(b.hours) * 60);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw bad('Duration must be between 1 minute and 24 hours');
  if (!optDate(b.entry_date, 'Date')) throw bad('Date is required');
  let rate = int(b.rate_cents, 'hourly rate', { min: 0, optional: true });
  let rcItem: number | null = b.rc_item_id ? int(b.rc_item_id, 'service', { min: 1 }) : null;
  if (rcItem) { ensureOwned(c.db, 'rc_items', rcItem, c.bid, 'Rate card item'); }
  if (rate === null) throw bad('Hourly rate is required');
  const data = { client_id: client.id, project_id: projectId, rc_item_id: rcItem, entry_date: b.entry_date, minutes, rate_cents: rate, notes: str(b.notes, 1000), billable: b.billable === undefined ? 1 : bool(b.billable) };
  const keys = Object.keys(data);
  if (id) {
    const locked = get(c.db, 'SELECT 1 FROM billing_links WHERE source_type=\'time\' AND source_id=? AND released_at IS NULL', id);
    if (locked) throw conflict('This time entry has been invoiced and can no longer be edited');
    ensureOwned(c.db, 'time_entries', id, c.bid, 'Time entry');
    run(c.db, `UPDATE time_entries SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => (data as any)[k]), id); return id;
  }
  return insert(c.db, `INSERT INTO time_entries (business_id, created_by, ${keys.join(',')}) VALUES (?,?, ${keys.map(() => '?').join(',')})`, c.bid, c.uid, ...keys.map((k) => (data as any)[k]));
}
export function listTime(c: Ctx, q: Row) {
  const where = ['t.business_id=?']; const p: any[] = [c.bid];
  if (q.client_id) { where.push('t.client_id=?'); p.push(Number(q.client_id)); } if (q.project_id) { where.push('t.project_id=?'); p.push(Number(q.project_id)); }
  if (q.unbilled === '1') where.push("t.billable=1 AND NOT EXISTS (SELECT 1 FROM billing_links l WHERE l.source_type='time' AND l.source_id=t.id AND l.released_at IS NULL)");
  return all(c.db, `SELECT t.*, cl.name AS client_name, pr.name AS project_name,
    (SELECT d.number FROM billing_links l JOIN documents d ON d.id=l.document_id WHERE l.source_type='time' AND l.source_id=t.id AND l.released_at IS NULL) AS invoice_number,
    (SELECT l.document_id FROM billing_links l WHERE l.source_type='time' AND l.source_id=t.id AND l.released_at IS NULL) AS invoice_id,
    ROUND(t.minutes * t.rate_cents / 60.0) AS value_cents FROM time_entries t JOIN clients cl ON cl.id=t.client_id LEFT JOIN projects pr ON pr.id=t.project_id WHERE ${where.join(' AND ')} ORDER BY t.entry_date DESC, t.id DESC LIMIT 1000`, ...p);
}

// ---- Expenses -----------------------------------------------------------------------------------------
export function saveExpense(c: Ctx, id: number | null, b: Row) {
  const cur = id ? ensureOwned(c.db, 'expenses', id, c.bid, 'Expense') : null;
  if (cur && get(c.db, "SELECT 1 FROM billing_links WHERE source_type='expense' AND source_id=? AND released_at IS NULL", id)) throw conflict('This expense has been invoiced to a client and can no longer be edited');
  const catId = b.category_id ? int(b.category_id, 'category', { min: 1 })! : null; if (catId) ensureOwned(c.db, 'expense_categories', catId, c.bid, 'Category');
  let clientId: number | null = null; if (b.client_id) clientId = ensureOwned(c.db, 'clients', b.client_id, c.bid, 'Client').id;
  let projectId: number | null = null; if (b.project_id) projectId = ensureOwned(c.db, 'projects', b.project_id, c.bid, 'Project').id;
  const amount = int(b.amount_cents, 'amount', { min: 0, max: 1e12 })!; const tax = int(b.tax_cents ?? 0, 'tax', { min: 0 })!;
  if (tax > amount) throw bad('Tax cannot exceed the total amount');
  const billable = bool(b.billable); if (billable && !clientId) throw bad('Billable expenses need a client');
  if (!optDate(b.expense_date, 'Date')) throw bad('Date is required');
  const v = { expense_date: b.expense_date, merchant: str(b.merchant, 200), description: str(b.description, 1000), category_id: catId, amount_cents: amount, tax_cents: tax,
    currency: currencyCode(b.currency, (get(c.db, 'SELECT currency FROM businesses WHERE id=?', c.bid)!.currency as string)), payment_method: str(b.payment_method, 60), client_id: clientId, project_id: projectId, billable,
    billable_markup_milli: int(b.billable_markup_milli ?? 0, 'markup', { min: 0, max: 1000000 })!, reimbursement_status: oneOf(b.reimbursement_status, ['none', 'pending', 'reimbursed'] as const, 'reimbursement', 'none'), notes: str(b.notes, 2000) };
  const keys = Object.keys(v);
  if (cur) { run(c.db, `UPDATE expenses SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => (v as any)[k]), cur.id); audit(c, 'expense', cur.id, 'update'); return cur.id; }
  const nid = insert(c.db, `INSERT INTO expenses (business_id, created_by, ${keys.join(',')}) VALUES (?,?, ${keys.map(() => '?').join(',')})`, c.bid, c.uid, ...keys.map((k) => (v as any)[k])); audit(c, 'expense', nid, 'create', { amount_cents: amount }); return nid;
}
export function listExpenses(c: Ctx, q: Row) {
  const where = ['e.business_id=?']; const p: any[] = [c.bid];
  if (q.from) { where.push('e.expense_date>=?'); p.push(q.from); } if (q.to) { where.push('e.expense_date<=?'); p.push(q.to); }
  if (q.client_id) { where.push('e.client_id=?'); p.push(Number(q.client_id)); } if (q.project_id) { where.push('e.project_id=?'); p.push(Number(q.project_id)); }
  if (q.category_id) { where.push('e.category_id=?'); p.push(Number(q.category_id)); } if (q.billable === '1') where.push('e.billable=1');
  if (q.unbilled === '1') where.push("e.billable=1 AND NOT EXISTS (SELECT 1 FROM billing_links l WHERE l.source_type='expense' AND l.source_id=e.id AND l.released_at IS NULL)");
  if (q.search) { where.push('(e.merchant LIKE ? OR e.description LIKE ?)'); const s = `%${String(q.search).replace(/[%_]/g, '')}%`; p.push(s, s); }
  return all(c.db, `SELECT e.*, cat.name AS category_name, cl.name AS client_name, pr.name AS project_name,
    (SELECT COUNT(*) FROM attachments a WHERE a.owner_type='expense' AND a.owner_id=e.id) AS attachment_count,
    (SELECT d.number FROM billing_links l JOIN documents d ON d.id=l.document_id WHERE l.source_type='expense' AND l.source_id=e.id AND l.released_at IS NULL) AS invoice_number
    FROM expenses e LEFT JOIN expense_categories cat ON cat.id=e.category_id LEFT JOIN clients cl ON cl.id=e.client_id LEFT JOIN projects pr ON pr.id=e.project_id
    WHERE ${where.join(' AND ')} ORDER BY e.expense_date DESC, e.id DESC LIMIT 2000`, ...p);
}

// ---- Attachments ----------------------------------------------------------------------------------------
const MAX_UPLOAD = 8 * 1024 * 1024;
const SNIFF: { mime: string; test: (b: Buffer) => boolean; ext: string[] }[] = [
  { mime: 'application/pdf', ext: ['pdf'], test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: ['png'], test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: ['jpg', 'jpeg'], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: ['webp'], test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'text/csv', ext: ['csv', 'txt'], test: (b) => !b.subarray(0, 4096).includes(0) },
];
/** Validate by content (magic bytes), never by the client-declared type. SVG/HTML are rejected by design. */
export function sniffUpload(filename: string, data: Buffer, allowed: string[]): { mime: string; filename: string } {
  if (!data.length) throw bad('Empty file'); if (data.length > MAX_UPLOAD) throw bad('File is larger than 8 MB');
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  const m = SNIFF.find((s) => allowed.includes(s.mime) && s.test(data));
  if (!m || !m.ext.includes(ext)) throw bad(`Unsupported or mismatched file type. Allowed: ${allowed.map((a) => a.split('/')[1]).join(', ')}`);
  if (m.mime === 'text/csv' && /<\s*(script|html|svg)/i.test(data.subarray(0, 4096).toString('utf8'))) throw bad('File content not allowed');
  const safe = filename.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  return { mime: m.mime, filename: safe };
}
export function addAttachment(c: Ctx, ownerType: 'expense' | 'invoice' | 'estimate' | 'project', ownerId: number, filename: string, data: Buffer) {
  const table = ownerType === 'expense' ? 'expenses' : ownerType === 'project' ? 'projects' : 'documents';
  ensureOwned(c.db, table, ownerId, c.bid, ownerType);
  const { mime, filename: safe } = sniffUpload(filename, data, ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
  const n = Number(get(c.db, 'SELECT COUNT(*) n FROM attachments WHERE owner_type=? AND owner_id=?', ownerType, ownerId)!.n); if (n >= 20) throw bad('Attachment limit reached');
  const id = insert(c.db, 'INSERT INTO attachments (business_id, owner_type, owner_id, filename, mime, size, sha256, data, created_by) VALUES (?,?,?,?,?,?,?,?,?)', c.bid, ownerType, ownerId, safe, mime, data.length, sha256(data), data, c.uid);
  audit(c, 'attachment', id, 'upload', { owner: ownerType, owner_id: ownerId, filename: safe });
  return id;
}
void fs; void saveSettings; void roundDiv;
