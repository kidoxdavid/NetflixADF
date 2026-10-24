import { all, get, run, insert, tx } from './db.ts';
import type { Row } from './db.ts';
import { type Ctx, bad, notFound, conflict, str, reqStr, int, oneOf, audit, nextNumber, bizToday, isDate, getSettings } from './core.ts';
import { balanceOf } from './documents.ts';

export function recordPayment(c: Ctx, b: Row): { id: number; duplicate: boolean } {
  return tx(c.db, () => {
    const key = str(b.idempotency_key, 100);
    if (key) { const ex = get(c.db, 'SELECT id FROM payments WHERE business_id=? AND idempotency_key=?', c.bid, key); if (ex) return { id: ex.id, duplicate: true }; }
    const kind = oneOf(b.kind, ['payment', 'refund'] as const, 'kind', 'payment');
    const allocsIn: { invoice_id: number; amount_cents: number }[] = Array.isArray(b.allocations) ? b.allocations.map((a: Row) => ({ invoice_id: int(a.invoice_id, 'invoice', { min: 1 })!, amount_cents: int(a.amount_cents, 'allocation amount', { min: 1, max: 1e12 })! })) : [];
    if (new Set(allocsIn.map((a) => a.invoice_id)).size !== allocsIn.length) throw bad('An invoice appears more than once in the allocation');
    const total = int(b.amount_cents, 'amount', { min: 1, max: 1e12 })!;
    const sum = allocsIn.reduce((a, x) => a + x.amount_cents, 0);
    if (sum > total) throw bad('Allocated amounts exceed the payment amount');
    if (kind === 'refund' && sum !== total) throw bad('A refund must be fully allocated to invoices');
    if (!isDate(b.paid_date)) throw bad('Payment date is required (YYYY-MM-DD)');
    if (b.paid_date > bizToday(c.db, c.bid) && !b.allow_future) throw bad('Payment date is in the future');
    const method = reqStr(b.method, 'Payment method', 60);
    let clientId = b.client_id ? int(b.client_id, 'client', { min: 1 })! : null;
    let currency: string | null = b.currency ? String(b.currency).toUpperCase() : null;
    const invs: Row[] = allocsIn.map((a) => {
      const inv = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=? AND type=\'invoice\'', a.invoice_id, c.bid);
      if (!inv) throw notFound('Invoice');
      if (['draft', 'void'].includes(inv.status)) throw bad(`Invoice ${inv.number ?? '#' + inv.id} is ${inv.status}; payments can only be recorded against issued invoices`);
      if (clientId && inv.client_id !== clientId) throw bad('All invoices must belong to the payment\'s client');
      clientId = inv.client_id; if (currency && currency !== inv.currency) throw bad('Invoice currency differs from the payment currency'); currency = inv.currency;
      if (kind === 'payment' && a.amount_cents > balanceOf(inv)) throw bad(`Payment of ${(a.amount_cents / 100).toFixed(2)} exceeds the outstanding balance of invoice ${inv.number} (${(balanceOf(inv) / 100).toFixed(2)})`);
      if (kind === 'refund' && a.amount_cents > inv.amount_paid_cents) throw bad(`Refund exceeds the amount paid on invoice ${inv.number}`);
      return inv;
    });
    if (!clientId) throw bad('Choose a client or an invoice');
    const client = get(c.db, 'SELECT id, currency FROM clients WHERE id=? AND business_id=?', clientId, c.bid); if (!client) throw notFound('Client');
    currency ||= (client.currency as string) || (get(c.db, 'SELECT currency FROM businesses WHERE id=?', c.bid)!.currency as string);
    const sign = kind === 'refund' ? -1 : 1;
    const receipt = nextNumber(c.db, c.bid, 'receipt');
    let id: number;
    try {
      id = insert(c.db, `INSERT INTO payments (business_id, client_id, kind, amount_cents, currency, paid_date, method, reference, notes, receipt_number, idempotency_key, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, c.bid, clientId, kind, sign * total, currency, b.paid_date, method, str(b.reference, 200), str(b.notes, 2000), receipt, key, c.uid);
      for (const a of allocsIn) insert(c.db, 'INSERT INTO payment_allocations (payment_id, invoice_id, amount_cents) VALUES (?,?,?)', id, a.invoice_id, sign * a.amount_cents);
    } catch (e: any) {
      if (/UNIQUE constraint failed: payments.business_id, payments.idempotency_key|ux_pay_idem/.test(String(e.message))) { const ex = get(c.db, 'SELECT id FROM payments WHERE business_id=? AND idempotency_key=?', c.bid, key); if (ex) return { id: ex.id, duplicate: true }; }
      throw e;
    }
    audit(c, 'payment', id, kind === 'refund' ? 'refund' : 'record', { amount_cents: sign * total, invoices: invs.map((i) => i.number), method });
    return { id, duplicate: false };
  });
}

/** Apply (part of) an existing unallocated payment to an invoice. */
export function allocateExisting(c: Ctx, paymentId: number, invoiceId: number, amount: number) {
  return tx(c.db, () => {
    const p = get(c.db, 'SELECT * FROM payments WHERE id=? AND business_id=?', paymentId, c.bid); if (!p) throw notFound('Payment');
    if (p.voided_at) throw conflict('Payment is void'); if (p.kind !== 'payment') throw bad('Only payments can be allocated');
    const inv = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=? AND type=\'invoice\'', invoiceId, c.bid); if (!inv) throw notFound('Invoice');
    if (inv.client_id !== p.client_id) throw bad('Invoice belongs to a different client');
    const amt = int(amount, 'amount', { min: 1 })!;
    const allocated = Number(get(c.db, 'SELECT COALESCE(SUM(amount_cents),0) s FROM payment_allocations WHERE payment_id=? AND voided_at IS NULL', paymentId)!.s);
    if (amt > p.amount_cents - allocated) throw bad('Amount exceeds the unallocated part of the payment');
    if (amt > balanceOf(inv)) throw bad('Amount exceeds the invoice balance');
    insert(c.db, 'INSERT INTO payment_allocations (payment_id, invoice_id, amount_cents) VALUES (?,?,?)', paymentId, invoiceId, amt);
    audit(c, 'payment', paymentId, 'allocate', { invoice: inv.number, amount_cents: amt });
  });
}

export function voidPayment(c: Ctx, id: number, reason: string) {
  return tx(c.db, () => {
    const p = get(c.db, 'SELECT * FROM payments WHERE id=? AND business_id=?', id, c.bid); if (!p) throw notFound('Payment');
    if (p.voided_at) throw conflict('Already void');
    const why = reqStr(reason, 'A reason', 500);
    if (p.kind === 'payment') {
      // voiding must not leave an invoice with a negative paid amount through later refunds
      const refunds = get(c.db, `SELECT COUNT(*) n FROM payment_allocations a JOIN payments r ON r.id=a.payment_id
        WHERE r.kind='refund' AND r.voided_at IS NULL AND a.voided_at IS NULL AND a.invoice_id IN (SELECT invoice_id FROM payment_allocations WHERE payment_id=? AND voided_at IS NULL)`, id)!.n;
      if (Number(refunds) > 0) throw conflict('Void the related refunds first');
    }
    run(c.db, "UPDATE payment_allocations SET voided_at=datetime('now') WHERE payment_id=? AND voided_at IS NULL", id);
    run(c.db, "UPDATE payments SET voided_at=datetime('now'), void_reason=? WHERE id=?", why, id);
    audit(c, 'payment', id, 'void', { reason: why });
  });
}

export function getPayment(c: Ctx, id: number) {
  const p = get(c.db, `SELECT p.*, cl.name AS client_name FROM payments p JOIN clients cl ON cl.id=p.client_id WHERE p.id=? AND p.business_id=?`, id, c.bid);
  if (!p) throw notFound('Payment');
  p.allocations = all(c.db, `SELECT a.id, a.invoice_id, a.amount_cents, a.voided_at, d.number AS invoice_number, d.total_cents, d.amount_paid_cents, d.credited_cents FROM payment_allocations a JOIN documents d ON d.id=a.invoice_id WHERE a.payment_id=?`, id);
  p.unallocated_cents = p.voided_at ? 0 : Math.abs(p.amount_cents) - p.allocations.filter((a: Row) => !a.voided_at).reduce((s: number, a: Row) => s + Math.abs(a.amount_cents), 0);
  return p;
}
export function listPayments(c: Ctx, q: Row) {
  const where = ['p.business_id = ?']; const par: any[] = [c.bid];
  if (q.client_id) { where.push('p.client_id=?'); par.push(Number(q.client_id)); }
  if (q.from) { where.push('p.paid_date>=?'); par.push(q.from); } if (q.to) { where.push('p.paid_date<=?'); par.push(q.to); }
  if (q.method) { where.push('p.method=?'); par.push(q.method); }
  if (q.invoice_id) { where.push('p.id IN (SELECT payment_id FROM payment_allocations WHERE invoice_id=?)'); par.push(Number(q.invoice_id)); }
  return all(c.db, `SELECT p.*, cl.name AS client_name,
      (SELECT group_concat(d.number, ', ') FROM payment_allocations a JOIN documents d ON d.id=a.invoice_id WHERE a.payment_id=p.id AND a.voided_at IS NULL) AS invoices,
      ABS(p.amount_cents) - COALESCE((SELECT SUM(ABS(a.amount_cents)) FROM payment_allocations a WHERE a.payment_id=p.id AND a.voided_at IS NULL),0) AS unallocated_cents
    FROM payments p JOIN clients cl ON cl.id=p.client_id WHERE ${where.join(' AND ')} ORDER BY p.paid_date DESC, p.id DESC LIMIT 1000`, ...par);
}
void getSettings;
