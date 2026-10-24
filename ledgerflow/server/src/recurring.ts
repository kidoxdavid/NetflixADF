import { all, get, run, insert, tx } from './db.ts';
import type { DB, Row } from './db.ts';
import { type Ctx, bad, notFound, str, reqStr, int, bool, oneOf, optDate, addDays, addMonths, audit, ensureOwned, currencyCode, bizToday, getSettings, isDate } from './core.ts';
import { saveDraft, issueDocument, getDocument, balanceOf } from './documents.ts';
import { sendOrDraft, type Mailer } from './mail.ts';
import { formatMoney } from './money.ts';

export function advance(date: string, frequency: string, n: number, anchor: string): string {
  if (frequency === 'weekly') return addDays(date, 7 * n);
  const months = frequency === 'monthly' ? n : frequency === 'quarterly' ? 3 * n : 12 * n;
  const [y, m] = date.split('-').map(Number); const anchorDay = Number(anchor.slice(8, 10));
  const total = (m - 1) + months; const ny = y + Math.floor(total / 12); const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
}
void addMonths;

export function saveSchedule(c: Ctx, id: number | null, b: Row) {
  const client = ensureOwned(c.db, 'clients', b.client_id, c.bid, 'Client');
  if (b.project_id) { const p = ensureOwned(c.db, 'projects', b.project_id, c.bid, 'Project'); if (p.client_id !== client.id) throw bad('Project belongs to a different client'); }
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Add at least one service line');
  const start = optDate(b.start_date, 'Start date'); if (!start) throw bad('Start date is required');
  const end = optDate(b.end_date, 'End date'); if (end && end < start) throw bad('End date is before the start date');
  const cur = id ? ensureOwned(c.db, 'recurring_schedules', id, c.bid, 'Schedule') : null;
  // validate line shape by dry-running through the draft builder inside a rolled-back savepoint
  const probe = (() => { try { return tx(c.db, () => { const pid = saveDraft(c, null, 'invoice', { client_id: client.id, currency: b.currency ?? client.currency, lines: b.lines, prices_include_tax: b.prices_include_tax }); const d = getDocument(c, pid, { includeStale: false }); throw Object.assign(new Error('rollback'), { probe: d }); }); } catch (e: any) { if (e.probe) return e.probe; throw e; } })();
  if (probe.total_cents <= 0) throw bad('The schedule total must be greater than zero');
  const v = { name: reqStr(b.name, 'Name', 120), client_id: client.id, project_id: b.project_id ? Number(b.project_id) : null, frequency: oneOf(b.frequency, ['weekly', 'monthly', 'quarterly', 'yearly'] as const, 'frequency'),
    interval_n: int(b.interval_n ?? 1, 'interval', { min: 1, max: 24 })!, start_date: start, end_date: end, auto_issue: bool(b.auto_issue), payment_terms_days: int(b.payment_terms_days ?? getSettings(c.db, c.bid).payment_terms_days, 'payment terms', { min: 0, max: 365 })!,
    currency: currencyCode(b.currency ?? client.currency, (get(c.db, 'SELECT currency FROM businesses WHERE id=?', c.bid)!.currency as string)), prices_include_tax: bool(b.prices_include_tax), lines: JSON.stringify(b.lines), notes: str(b.notes, 3000), terms: str(b.terms, 3000), active: b.active === undefined ? 1 : bool(b.active) };
  if (cur) { const keys = Object.keys(v); run(c.db, `UPDATE recurring_schedules SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => (v as any)[k]), cur.id);
    if (start !== cur.start_date && !get(c.db, 'SELECT 1 FROM recurring_runs WHERE schedule_id=?', cur.id)) run(c.db, 'UPDATE recurring_schedules SET next_run_date=? WHERE id=?', start, cur.id);
    audit(c, 'recurring', cur.id, 'update'); return cur.id; }
  const nid = insert(c.db, `INSERT INTO recurring_schedules (business_id, next_run_date, ${Object.keys(v).join(',')}) VALUES (?,?, ${Object.keys(v).map(() => '?').join(',')})`, c.bid, start, ...Object.values(v) as any[]);
  audit(c, 'recurring', nid, 'create'); return nid;
}
export function listSchedules(c: Ctx) {
  return all(c.db, `SELECT s.*, cl.name AS client_name, (SELECT COUNT(*) FROM recurring_runs r WHERE r.schedule_id=s.id) AS runs FROM recurring_schedules s JOIN clients cl ON cl.id=s.client_id WHERE s.business_id=? ORDER BY s.active DESC, s.next_run_date`, c.bid).map((s) => ({ ...s, lines: JSON.parse(s.lines) }));
}

/** Idempotent: safe to run any number of times. Never charges anyone; it only creates (and optionally issues) invoices. */
export function runRecurring(db: DB, today: string, businessId?: number): { created: number[]; issued: number[]; errors: string[] } {
  const res = { created: [] as number[], issued: [] as number[], errors: [] as string[] };
  const schedules = all(db, `SELECT * FROM recurring_schedules WHERE active=1 AND next_run_date <= ? ${businessId ? 'AND business_id=' + Number(businessId) : ''}`, today);
  for (const s of schedules) {
    const c: Ctx = { db, bid: s.business_id, uid: null, role: 'owner' };
    let guard = 0;
    let cur = get(db, 'SELECT * FROM recurring_schedules WHERE id=?', s.id)!;
    while (cur.active && cur.next_run_date <= today && (!cur.end_date || cur.next_run_date <= cur.end_date) && guard++ < 24) {
      const runDate: string = cur.next_run_date;
      try {
        tx(db, () => {
          // unique(schedule_id, run_date) guarantees a retry cannot create a second invoice for the same period
          const claimed = run(db, 'INSERT OR IGNORE INTO recurring_runs (schedule_id, run_date) VALUES (?,?)', s.id, runDate);
          if (Number(claimed.changes) === 1) {
            const lines = JSON.parse(cur.lines).map((l: Row) => ({ ...l, id: undefined }));
            const id = saveDraft(c, null, 'invoice', { client_id: cur.client_id, project_id: cur.project_id, currency: cur.currency, prices_include_tax: cur.prices_include_tax, notes: cur.notes, terms: cur.terms, lines,
              issue_date: runDate, due_date: addDays(runDate, cur.payment_terms_days), title: cur.name });
            run(db, 'UPDATE documents SET recurring_schedule_id=? WHERE id=?', cur.id, id);
            run(db, 'UPDATE recurring_runs SET invoice_id=? WHERE schedule_id=? AND run_date=?', id, cur.id, runDate);
            res.created.push(id);
            if (cur.auto_issue) { issueDocument(c, id, { issue_date: runDate, due_date: addDays(runDate, cur.payment_terms_days) }); res.issued.push(id); }
            audit(c, 'recurring', cur.id, 'run', { run_date: runDate, invoice_id: id, issued: !!cur.auto_issue });
          }
          const runs = Number(get(db, 'SELECT COUNT(*) n FROM recurring_runs WHERE schedule_id=?', s.id)!.n);
          const next = advance(cur.start_date, cur.frequency, cur.interval_n * runs, cur.start_date);
          run(db, 'UPDATE recurring_schedules SET next_run_date=?, active=CASE WHEN end_date IS NOT NULL AND ? > end_date THEN 0 ELSE active END WHERE id=?', next, next, s.id);
        });
      } catch (e: any) { res.errors.push(`schedule ${s.id} ${runDate}: ${e.message}`); break; }
      cur = get(db, 'SELECT * FROM recurring_schedules WHERE id=?', s.id)!;
    }
  }
  return res;
}

/** Prepare (and, if email is configured, send) payment reminders. Idempotent via communications.dedupe_key. */
export async function runReminders(db: DB, today: string, mailer: Mailer, businessId?: number) {
  const out = { prepared: 0, sent: 0, failed: 0, skipped: 0 };
  const bizs = all(db, `SELECT id FROM businesses ${businessId ? 'WHERE id=' + Number(businessId) : ''}`);
  for (const b of bizs) {
    const s = getSettings(db, b.id); if (!s.reminders.enabled) continue;
    const c: Ctx = { db, bid: b.id, uid: null, role: 'owner' };
    const biz = get(db, 'SELECT legal_name, trading_name, currency, locale FROM businesses WHERE id=?', b.id)!;
    const invs = all(db, `SELECT d.*, cl.name AS client_name, cl.email AS client_email FROM documents d JOIN clients cl ON cl.id=d.client_id WHERE d.business_id=? AND d.type='invoice' AND d.status='issued' AND d.total_cents - d.amount_paid_cents - d.credited_cents > 0 AND d.due_date IS NOT NULL AND d.disputed=0`, b.id);
    for (const inv of invs) {
      for (const off of s.reminders.offsets) {
        const target = addDays(inv.due_date, off);
        if (target > today || target < addDays(today, -3)) continue;
        const key = `reminder:${inv.id}:${off}`;
        const bal = balanceOf(inv);
        const when = off < 0 ? `is due on ${inv.due_date}` : off === 0 ? 'is due today' : `was due on ${inv.due_date} and is now ${off} day(s) overdue`;
        const body = `Hello ${inv.client_name},\n\nThis is a friendly reminder that invoice ${inv.number} (${formatMoney(bal, inv.currency, biz.locale)} outstanding) ${when}.\n\nPlease let us know if you have already sent payment or have any questions.\n\nThank you,\n${biz.trading_name || biz.legal_name}`;
        const r = await sendOrDraft(c, mailer, { document_id: inv.id, client_id: inv.client_id, kind: off < 0 ? 'reminder_upcoming' : off === 0 ? 'reminder_due' : 'reminder_overdue', to: inv.client_email, subject: `Reminder: invoice ${inv.number}`, body, dedupe_key: key, send: true });
        if (r.status === 'duplicate') out.skipped++; else if (r.status === 'sent') out.sent++; else if (r.status === 'failed') out.failed++; else out.prepared++;
      }
    }
  }
  return out;
}
void notFound; void isDate; void bizToday;
