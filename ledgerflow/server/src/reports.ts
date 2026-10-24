import { all, get } from './db.ts';
import type { Row } from './db.ts';
import { type Ctx, bad, bizToday, addDays } from './core.ts';
import { csvCell } from './ratecard.ts';

export type ColType = 'text' | 'money' | 'date' | 'int' | 'pct';
export interface Report { name: string; title: string; columns: { key: string; label: string; type: ColType }[]; rows: Row[]; notes: string[]; filters: Row }

const monthOf = (d: string) => d.slice(0, 7);
interface F { from?: string; to?: string; client_id?: number; project_id?: number; currency?: string; category?: string }
function parseFilters(q: Row): F {
  const f: F = {};
  if (q.from) { if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from)) throw bad('Invalid from date'); f.from = q.from; }
  if (q.to) { if (!/^\d{4}-\d{2}-\d{2}$/.test(q.to)) throw bad('Invalid to date'); f.to = q.to; }
  if (q.client_id) f.client_id = Number(q.client_id); if (q.project_id) f.project_id = Number(q.project_id);
  if (q.currency) f.currency = String(q.currency).toUpperCase(); if (q.category) f.category = String(q.category);
  return f;
}
function docWhere(f: F, alias = 'd', dateCol = 'issue_date') {
  const w: string[] = []; const p: any[] = [];
  if (f.from) { w.push(`${alias}.${dateCol} >= ?`); p.push(f.from); } if (f.to) { w.push(`${alias}.${dateCol} <= ?`); p.push(f.to); }
  if (f.client_id) { w.push(`${alias}.client_id = ?`); p.push(f.client_id); } if (f.project_id) { w.push(`${alias}.project_id = ?`); p.push(f.project_id); }
  if (f.currency) { w.push(`${alias}.currency = ?`); p.push(f.currency); }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', p };
}
const SALES = "d.type IN ('invoice','credit_note') AND d.status = 'issued'";
const SIGN = "(CASE WHEN d.type='credit_note' THEN -1 ELSE 1 END)";
const CASH_NOTE = 'Cash figures are based on payments you recorded; they are not an accounting profit (no accruals, depreciation, owner draws, or tax filings are considered).';

export function dashboard(c: Ctx, q: Row) {
  const f = parseFilters(q); const today = bizToday(c.db, c.bid);
  const from = f.from ?? today.slice(0, 4) + '-01-01'; const to = f.to ?? today;
  const ff: F = { ...f, from, to };
  const dw = docWhere(ff);
  const currencies = all(c.db, `SELECT DISTINCT currency FROM (SELECT currency FROM documents WHERE business_id=? UNION SELECT currency FROM payments WHERE business_id=? UNION SELECT currency FROM expenses WHERE business_id=?)`, c.bid, c.bid, c.bid).map((r) => r.currency as string);
  const list = f.currency ? [f.currency] : currencies;
  const per = list.map((cur) => {
    const base = { ...ff, currency: cur }; const w = docWhere(base);
    const invoiced = get(c.db, `SELECT COALESCE(SUM(${SIGN}*d.total_cents),0) AS total, COALESCE(SUM(${SIGN}*(d.total_cents - d.tax_total_cents)),0) AS net FROM documents d WHERE d.business_id=? AND ${SALES}${w.sql}`, c.bid, ...w.p)!;
    const pw: string[] = ['p.business_id=?', 'p.currency=?', 'p.voided_at IS NULL', 'p.paid_date>=?', 'p.paid_date<=?']; const pp: any[] = [c.bid, cur, from, to];
    if (f.client_id) { pw.push('p.client_id=?'); pp.push(f.client_id); }
    const received = get(c.db, `SELECT COALESCE(SUM(p.amount_cents),0) s FROM payments p WHERE ${pw.join(' AND ')}`, ...pp)!;
    const ew: string[] = ['e.business_id=?', 'e.currency=?', 'e.expense_date>=?', 'e.expense_date<=?']; const ep: any[] = [c.bid, cur, from, to];
    if (f.client_id) { ew.push('e.client_id=?'); ep.push(f.client_id); } if (f.project_id) { ew.push('e.project_id=?'); ep.push(f.project_id); }
    const exp = get(c.db, `SELECT COALESCE(SUM(e.amount_cents),0) s, COALESCE(SUM(e.tax_cents),0) t FROM expenses e WHERE ${ew.join(' AND ')}`, ...ep)!;
    const out = get(c.db, `SELECT COALESCE(SUM(d.total_cents - d.amount_paid_cents - d.credited_cents),0) AS s, COUNT(*) AS n FROM documents d WHERE d.business_id=? AND d.type='invoice' AND d.status='issued' AND d.currency=? AND d.total_cents - d.amount_paid_cents - d.credited_cents > 0${f.client_id ? ' AND d.client_id=' + Number(f.client_id) : ''}`, c.bid, cur)!;
    const over = get(c.db, `SELECT COALESCE(SUM(d.total_cents - d.amount_paid_cents - d.credited_cents),0) AS s, COUNT(*) AS n FROM documents d WHERE d.business_id=? AND d.type='invoice' AND d.status='issued' AND d.currency=? AND d.total_cents - d.amount_paid_cents - d.credited_cents > 0 AND d.due_date < ?${f.client_id ? ' AND d.client_id=' + Number(f.client_id) : ''}`, c.bid, cur, today)!;
    const upcoming = get(c.db, `SELECT COALESCE(SUM(d.total_cents - d.amount_paid_cents - d.credited_cents),0) AS s, COUNT(*) AS n FROM documents d WHERE d.business_id=? AND d.type='invoice' AND d.status='issued' AND d.currency=? AND d.total_cents - d.amount_paid_cents - d.credited_cents > 0 AND d.due_date >= ? AND d.due_date <= ?${f.client_id ? ' AND d.client_id=' + Number(f.client_id) : ''}`, c.bid, cur, today, addDays(today, 30))!;
    return { currency: cur, invoiced_cents: Number(invoiced.total), invoiced_net_cents: Number(invoiced.net), received_cents: Number(received.s), expenses_cents: Number(exp.s), expense_tax_cents: Number(exp.t),
      cash_minus_expenses_cents: Number(received.s) - Number(exp.s), outstanding_cents: Number(out.s), outstanding_count: Number(out.n), overdue_cents: Number(over.s), overdue_count: Number(over.n), upcoming_cents: Number(upcoming.s), upcoming_count: Number(upcoming.n) };
  });
  const upcomingList = all(c.db, `SELECT d.id, d.number, d.currency, d.due_date, d.total_cents - d.amount_paid_cents - d.credited_cents AS balance_cents, cl.name AS client_name FROM documents d JOIN clients cl ON cl.id=d.client_id
    WHERE d.business_id=? AND d.type='invoice' AND d.status='issued' AND d.total_cents - d.amount_paid_cents - d.credited_cents > 0 ORDER BY d.due_date LIMIT 8`, c.bid);
  const recent = all(c.db, 'SELECT id, entity, entity_id, action, detail, created_at FROM audit_events WHERE business_id=? AND entity IN (\'invoice\',\'estimate\',\'payment\',\'expense\',\'client\',\'credit_note\') ORDER BY id DESC LIMIT 12', c.bid);
  const drafts = get(c.db, "SELECT SUM(type='invoice') invoices, SUM(type='estimate') estimates FROM documents WHERE business_id=? AND status='draft'", c.bid)!;
  const awaiting = get(c.db, "SELECT COUNT(*) n FROM documents WHERE business_id=? AND type='estimate' AND status='issued'", c.bid)!;
  void dw;
  return { period: { from, to }, currencies: per, upcoming: upcomingList, recent, drafts: { invoices: Number(drafts.invoices ?? 0), estimates: Number(drafts.estimates ?? 0) }, estimates_awaiting_response: Number(awaiting.n),
    notes: ['"Invoiced" is the value of issued invoices (less credit notes) dated in the period; "Received" is cash you recorded in the period. They are different numbers.', CASH_NOTE, 'Amounts in different currencies are never added together.'] };
}

function mkReport(name: string, title: string, columns: Report['columns'], rows: Row[], notes: string[], filters: Row): Report { return { name, title, columns, rows, notes, filters }; }

export const REPORTS = ['revenue_by_period', 'revenue_by_client', 'revenue_by_service', 'revenue_by_project', 'revenue_by_category', 'outstanding', 'aging', 'expenses_by_category', 'billable_expenses', 'tax_collected', 'tax_transactions', 'payments_received', 'recurring_vs_oneoff', 'project_budgets'] as const;

export function runReport(c: Ctx, name: string, q: Row): Report {
  const f = parseFilters(q); const w = docWhere(f); const today = bizToday(c.db, c.bid);
  const revNote = 'Revenue = issued invoices less credit notes, excluding tax. Drafts and voided documents are excluded.';
  switch (name) {
    case 'revenue_by_period': {
      const inv = all(c.db, `SELECT substr(d.issue_date,1,7) AS period, d.currency, SUM(${SIGN}*(d.total_cents - d.tax_total_cents)) AS invoiced_cents, SUM(${SIGN}*d.tax_total_cents) AS tax_cents FROM documents d WHERE d.business_id=? AND ${SALES}${w.sql} GROUP BY 1,2`, c.bid, ...w.p);
      const pw = ['p.business_id=?', 'p.voided_at IS NULL']; const pp: any[] = [c.bid];
      if (f.from) { pw.push('p.paid_date>=?'); pp.push(f.from); } if (f.to) { pw.push('p.paid_date<=?'); pp.push(f.to); } if (f.client_id) { pw.push('p.client_id=?'); pp.push(f.client_id); } if (f.currency) { pw.push('p.currency=?'); pp.push(f.currency); }
      const rec = all(c.db, `SELECT substr(p.paid_date,1,7) AS period, p.currency, SUM(p.amount_cents) AS received_cents FROM payments p WHERE ${pw.join(' AND ')} GROUP BY 1,2`, ...pp);
      const m = new Map<string, Row>();
      for (const r of inv) m.set(r.period + r.currency, { period: r.period, currency: r.currency, invoiced_cents: r.invoiced_cents, tax_cents: r.tax_cents, received_cents: 0 });
      for (const r of rec) { const k = r.period + r.currency; const e = m.get(k) ?? { period: r.period, currency: r.currency, invoiced_cents: 0, tax_cents: 0, received_cents: 0 }; e.received_cents = r.received_cents; m.set(k, e); }
      return mkReport(name, 'Revenue by period', [{ key: 'period', label: 'Month', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'invoiced_cents', label: 'Invoiced (excl. tax)', type: 'money' }, { key: 'tax_cents', label: 'Tax invoiced', type: 'money' }, { key: 'received_cents', label: 'Cash received (incl. tax)', type: 'money' }],
        [...m.values()].sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency)), [revNote, 'Cash received is by payment date and includes tax collected. ' + CASH_NOTE], f);
    }
    case 'revenue_by_client': {
      const rows = all(c.db, `SELECT cl.name AS client, d.currency, SUM(${SIGN}*(d.total_cents - d.tax_total_cents)) AS invoiced_cents, SUM(CASE WHEN d.type='invoice' THEN d.amount_paid_cents ELSE 0 END) AS paid_cents, SUM(CASE WHEN d.type='invoice' THEN d.total_cents - d.amount_paid_cents - d.credited_cents ELSE 0 END) AS outstanding_cents
        FROM documents d JOIN clients cl ON cl.id=d.client_id WHERE d.business_id=? AND ${SALES}${w.sql} GROUP BY cl.id, d.currency ORDER BY invoiced_cents DESC`, c.bid, ...w.p);
      return mkReport(name, 'Revenue by client', [{ key: 'client', label: 'Client', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'invoiced_cents', label: 'Invoiced (excl. tax)', type: 'money' }, { key: 'paid_cents', label: 'Paid (incl. tax)', type: 'money' }, { key: 'outstanding_cents', label: 'Outstanding (incl. tax)', type: 'money' }], rows, [revNote], f);
    }
    case 'revenue_by_service': case 'revenue_by_category': {
      const byCat = name === 'revenue_by_category';
      const key = byCat ? "COALESCE(l.category_name, 'Uncategorised / custom')" : "COALESCE(ri.name, l.description)";
      const catW = f.category ? ' AND l.category_name = ?' : '';
      const rows = all(c.db, `SELECT ${key} AS label, d.currency, ${byCat ? '' : "COALESCE(ri.unit, l.unit) AS unit,"} SUM(${SIGN}*l.qty_milli)/1000.0 AS qty, SUM(${SIGN}*l.taxable_cents) AS revenue_cents
        FROM document_lines l JOIN documents d ON d.id=l.document_id LEFT JOIN rc_items ri ON ri.id=l.rc_item_id WHERE d.business_id=? AND ${SALES} AND l.is_component=0${w.sql}${catW} GROUP BY 1, d.currency ${byCat ? '' : ', 3'} ORDER BY revenue_cents DESC`, c.bid, ...w.p, ...(f.category ? [f.category] : []));
      const cols: Report['columns'] = byCat ? [{ key: 'label', label: 'Category', type: 'text' }] : [{ key: 'label', label: 'Service', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }];
      return mkReport(name, byCat ? 'Revenue by rate-card category' : 'Revenue by service', [...cols, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'qty', label: 'Quantity', type: 'int' }, { key: 'revenue_cents', label: 'Revenue (excl. tax)', type: 'money' }], rows, [revNote, 'Grouped by the service name on the rate card; custom lines are grouped by their description. Discounts are included in revenue.'], f);
    }
    case 'revenue_by_project': {
      const rows = all(c.db, `SELECT COALESCE(pr.name,'(no project)') AS project, d.currency, SUM(${SIGN}*(d.total_cents - d.tax_total_cents)) AS revenue_cents FROM documents d LEFT JOIN projects pr ON pr.id=d.project_id WHERE d.business_id=? AND ${SALES}${w.sql} GROUP BY pr.id, d.currency ORDER BY revenue_cents DESC`, c.bid, ...w.p);
      return mkReport(name, 'Revenue by project', [{ key: 'project', label: 'Project', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'revenue_cents', label: 'Revenue (excl. tax)', type: 'money' }], rows, [revNote], f);
    }
    case 'outstanding': case 'aging': {
      const rows = all(c.db, `SELECT d.id, d.number, cl.name AS client, d.currency, d.issue_date, d.due_date, d.total_cents, d.amount_paid_cents, d.credited_cents, d.total_cents - d.amount_paid_cents - d.credited_cents AS balance_cents
        FROM documents d JOIN clients cl ON cl.id=d.client_id WHERE d.business_id=? AND d.type='invoice' AND d.status='issued' AND d.total_cents - d.amount_paid_cents - d.credited_cents > 0${w.sql.replace(/d\.issue_date/g, 'd.issue_date')} ORDER BY d.due_date`, c.bid, ...w.p);
      const days = (due: string) => Math.floor((Date.parse(today) - Date.parse(due)) / 864e5);
      if (name === 'outstanding') return mkReport(name, 'Outstanding invoices', [{ key: 'number', label: 'Invoice', type: 'text' }, { key: 'client', label: 'Client', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'due_date', label: 'Due', type: 'date' }, { key: 'days_overdue', label: 'Days overdue', type: 'int' }, { key: 'total_cents', label: 'Total', type: 'money' }, { key: 'balance_cents', label: 'Balance', type: 'money' }],
        rows.map((r) => ({ ...r, days_overdue: Math.max(0, days(r.due_date)) })), [`As of ${today}.`], f);
      const buckets = ['Current', '1–30', '31–60', '61–90', '90+'];
      const agg = new Map<string, Row>();
      for (const r of rows) { const d = days(r.due_date); const b = d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4; const k = r.client + '|' + r.currency; const e = agg.get(k) ?? { client: r.client, currency: r.currency, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0 }; e['b' + b] += r.balance_cents; e.total += r.balance_cents; agg.set(k, e); }
      return mkReport(name, 'Invoice aging', [{ key: 'client', label: 'Client', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, ...buckets.map((b, i) => ({ key: 'b' + i, label: i === 0 ? 'Not yet due' : b + ' days', type: 'money' as ColType })), { key: 'total', label: 'Total', type: 'money' }],
        [...agg.values()].sort((a, b) => b.total - a.total), [`Aged by days past the due date as of ${today}.`], f);
    }
    case 'expenses_by_category': case 'billable_expenses': {
      const ew: string[] = ['e.business_id=?']; const ep: any[] = [c.bid];
      if (f.from) { ew.push('e.expense_date>=?'); ep.push(f.from); } if (f.to) { ew.push('e.expense_date<=?'); ep.push(f.to); } if (f.client_id) { ew.push('e.client_id=?'); ep.push(f.client_id); } if (f.project_id) { ew.push('e.project_id=?'); ep.push(f.project_id); } if (f.currency) { ew.push('e.currency=?'); ep.push(f.currency); }
      if (name === 'expenses_by_category') {
        const rows = all(c.db, `SELECT COALESCE(cat.name,'Uncategorised') AS category, e.currency, COUNT(*) AS n, SUM(e.amount_cents) AS total_cents, SUM(e.tax_cents) AS tax_cents, SUM(e.amount_cents - e.tax_cents) AS net_cents FROM expenses e LEFT JOIN expense_categories cat ON cat.id=e.category_id WHERE ${ew.join(' AND ')} GROUP BY cat.id, e.currency ORDER BY total_cents DESC`, ...ep);
        return mkReport(name, 'Expenses by category', [{ key: 'category', label: 'Category', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'n', label: 'Count', type: 'int' }, { key: 'net_cents', label: 'Before tax', type: 'money' }, { key: 'tax_cents', label: 'Tax paid', type: 'money' }, { key: 'total_cents', label: 'Total', type: 'money' }], rows, ['Tax paid is shown separately; whether it is recoverable depends on your registration — confirm with your accountant.'], f);
      }
      const rows = all(c.db, `SELECT CASE WHEN e.billable=1 THEN 'Billable' ELSE 'Non-billable' END AS kind, e.currency, COUNT(*) AS n, SUM(e.amount_cents) AS total_cents,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM billing_links l WHERE l.source_type='expense' AND l.source_id=e.id AND l.released_at IS NULL) THEN e.amount_cents ELSE 0 END) AS invoiced_cents FROM expenses e WHERE ${ew.join(' AND ')} GROUP BY e.billable, e.currency`, ...ep);
      return mkReport(name, 'Billable vs non-billable expenses', [{ key: 'kind', label: 'Type', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'n', label: 'Count', type: 'int' }, { key: 'total_cents', label: 'Total', type: 'money' }, { key: 'invoiced_cents', label: 'Already invoiced to clients', type: 'money' }], rows, [], f);
    }
    case 'tax_collected': case 'tax_transactions': {
      const docs = all(c.db, `SELECT d.id, d.number, d.type, d.issue_date, d.currency, d.tax_summary, d.total_cents, d.tax_total_cents, d.prices_include_tax, cl.name AS client FROM documents d JOIN clients cl ON cl.id=d.client_id WHERE d.business_id=? AND ${SALES}${w.sql} ORDER BY d.issue_date, d.id`, c.bid, ...w.p);
      const note = ['Tax is reported on an invoice basis (by invoice issue date), net of credit notes. This is a bookkeeping summary only — you must confirm your tax registration, rates, place-of-supply rules, reporting method and filing obligations (e.g. with the CRA / Revenu Québec) yourself.'];
      if (name === 'tax_transactions') {
        const rows: Row[] = [];
        for (const d of docs) { const s = JSON.parse(d.tax_summary) as Row[]; const sign = d.type === 'credit_note' ? -1 : 1; if (!s.length) rows.push({ number: d.number, issue_date: d.issue_date, client: d.client, currency: d.currency, tax: '(no tax)', rate: 0, base_cents: sign * (d.total_cents - d.tax_total_cents), tax_cents: 0 });
          for (const t of s) rows.push({ number: d.number, issue_date: d.issue_date, client: d.client, currency: d.currency, tax: t.name, rate: t.rate_milli / 1000, base_cents: sign * t.base_cents, tax_cents: sign * t.tax_cents }); }
        return mkReport(name, 'Tax transactions', [{ key: 'number', label: 'Document', type: 'text' }, { key: 'issue_date', label: 'Date', type: 'date' }, { key: 'client', label: 'Client', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'tax', label: 'Tax', type: 'text' }, { key: 'rate', label: 'Rate %', type: 'pct' }, { key: 'base_cents', label: 'Taxable amount', type: 'money' }, { key: 'tax_cents', label: 'Tax', type: 'money' }], rows, note, f);
      }
      const agg = new Map<string, Row>();
      for (const d of docs) { const sign = d.type === 'credit_note' ? -1 : 1; for (const t of JSON.parse(d.tax_summary) as Row[]) { const k = `${monthOf(d.issue_date)}|${d.currency}|${t.name}|${t.rate_milli}`; const e = agg.get(k) ?? { period: monthOf(d.issue_date), currency: d.currency, tax: t.name, rate: t.rate_milli / 1000, base_cents: 0, tax_cents: 0 }; e.base_cents += sign * t.base_cents; e.tax_cents += sign * t.tax_cents; agg.set(k, e); } }
      const ew: string[] = ['e.business_id=?']; const ep: any[] = [c.bid]; if (f.from) { ew.push('e.expense_date>=?'); ep.push(f.from); } if (f.to) { ew.push('e.expense_date<=?'); ep.push(f.to); } if (f.currency) { ew.push('e.currency=?'); ep.push(f.currency); }
      for (const r of all(c.db, `SELECT substr(e.expense_date,1,7) AS period, e.currency, SUM(e.tax_cents) AS t FROM expenses e WHERE ${ew.join(' AND ')} AND e.tax_cents>0 GROUP BY 1,2`, ...ep)) agg.set(`${r.period}|${r.currency}|expense-tax-paid`, { period: r.period, currency: r.currency, tax: 'Tax paid on expenses (not collected)', rate: null, base_cents: 0, tax_cents: r.t });
      return mkReport(name, 'Tax collected by period', [{ key: 'period', label: 'Month', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'tax', label: 'Tax', type: 'text' }, { key: 'rate', label: 'Rate %', type: 'pct' }, { key: 'base_cents', label: 'Taxable amount', type: 'money' }, { key: 'tax_cents', label: 'Tax amount', type: 'money' }],
        [...agg.values()].sort((a, b) => a.period.localeCompare(b.period) || a.tax.localeCompare(b.tax)), note, f);
    }
    case 'payments_received': {
      const pw = ['p.business_id=?', 'p.voided_at IS NULL']; const pp: any[] = [c.bid];
      if (f.from) { pw.push('p.paid_date>=?'); pp.push(f.from); } if (f.to) { pw.push('p.paid_date<=?'); pp.push(f.to); } if (f.client_id) { pw.push('p.client_id=?'); pp.push(f.client_id); } if (f.currency) { pw.push('p.currency=?'); pp.push(f.currency); }
      const rows = all(c.db, `SELECT p.paid_date, p.receipt_number, cl.name AS client, p.currency, p.method, p.reference, p.kind, p.verification, p.amount_cents, (SELECT group_concat(d.number, ', ') FROM payment_allocations a JOIN documents d ON d.id=a.invoice_id WHERE a.payment_id=p.id AND a.voided_at IS NULL) AS invoices FROM payments p JOIN clients cl ON cl.id=p.client_id WHERE ${pw.join(' AND ')} ORDER BY p.paid_date, p.id`, ...pp);
      return mkReport(name, 'Payments received', [{ key: 'paid_date', label: 'Date', type: 'date' }, { key: 'receipt_number', label: 'Receipt', type: 'text' }, { key: 'client', label: 'Client', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'method', label: 'Method', type: 'text' }, { key: 'reference', label: 'Reference', type: 'text' }, { key: 'invoices', label: 'Invoices', type: 'text' }, { key: 'verification', label: 'Verification', type: 'text' }, { key: 'amount_cents', label: 'Amount', type: 'money' }], rows, ['Refunds appear as negative amounts. "manual" means you recorded the payment yourself; it was not verified by a payment provider.'], f);
    }
    case 'recurring_vs_oneoff': {
      const rows = all(c.db, `SELECT CASE WHEN d.recurring_schedule_id IS NOT NULL THEN 'Recurring (from schedules)' ELSE 'One-off / manual' END AS kind, d.currency, COUNT(*) AS n, SUM(${SIGN}*(d.total_cents - d.tax_total_cents)) AS revenue_cents FROM documents d WHERE d.business_id=? AND ${SALES}${w.sql} GROUP BY 1,2`, c.bid, ...w.p);
      return mkReport(name, 'Recurring vs one-off income', [{ key: 'kind', label: 'Type', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'n', label: 'Documents', type: 'int' }, { key: 'revenue_cents', label: 'Revenue (excl. tax)', type: 'money' }], rows, ['Only invoices generated from a recurring schedule are counted as recurring; manually created retainer invoices are listed as one-off.'], f);
    }
    case 'project_budgets': {
      const rows = all(c.db, `SELECT pr.name AS project, cl.name AS client, pr.currency, pr.budget_cents,
        COALESCE((SELECT SUM(d.total_cents - d.tax_total_cents) FROM documents d WHERE d.project_id=pr.id AND d.type='invoice' AND d.status='issued'),0) AS invoiced_cents,
        COALESCE((SELECT SUM(d.amount_paid_cents) FROM documents d WHERE d.project_id=pr.id AND d.type='invoice' AND d.status='issued'),0) AS received_cents,
        COALESCE((SELECT SUM(e.amount_cents - e.tax_cents) FROM expenses e WHERE e.project_id=pr.id AND e.currency=pr.currency),0) AS expenses_cents
        FROM projects pr JOIN clients cl ON cl.id=pr.client_id WHERE pr.business_id=?${f.client_id ? ' AND pr.client_id=' + Number(f.client_id) : ''}${f.currency ? ' AND pr.currency=\'' + f.currency.replace(/[^A-Z]/g, '') + '\'' : ''} ORDER BY pr.id DESC`, c.bid);
      return mkReport(name, 'Project budgets vs recorded costs', [{ key: 'project', label: 'Project', type: 'text' }, { key: 'client', label: 'Client', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'budget_cents', label: 'Agreed budget', type: 'money' }, { key: 'invoiced_cents', label: 'Invoiced (excl. tax)', type: 'money' }, { key: 'received_cents', label: 'Received (incl. tax)', type: 'money' }, { key: 'expenses_cents', label: 'Recorded expenses', type: 'money' }],
        rows, ['Budget comparison uses invoiced amounts (actual), not estimates. Expenses exclude tax. Time not yet invoiced is not counted.'], f);
    }
    default: throw bad('Unknown report');
  }
}

export function reportToCsv(r: Report): string {
  const lines = [r.columns.map((c) => csvCell(c.label)).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => {
    const v = row[c.key];
    if (v === null || v === undefined) return '';
    if (c.type === 'money') return (v / 100).toFixed(2);
    if (c.type === 'int') return String(Math.round(v * 1000) / 1000);
    return csvCell(v);
  }).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
