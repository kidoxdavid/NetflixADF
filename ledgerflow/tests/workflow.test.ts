import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, setupBusiness, Client, pdfText, pdfPages, money, fakeMailer } from './helpers.ts';
import { createBackup, verifyBackup, restoreBackup } from '../server/src/backup.ts';
import { openDb, all, get } from '../server/src/db.ts';
import { recalcStored, verifyDocument } from '../server/src/documents.ts';

let S: Awaited<ReturnType<typeof startServer>>; let c: Client;
const mailer = fakeMailer(true);
before(async () => { S = await startServer({ mailer }); c = await setupBusiness(S.base); });
after(async () => { await S.close(); });
const ctx = () => ({ db: S.db, bid: c.bid, uid: 1, role: 'owner' as const });

const st: Record<string, any> = {};
const lineFor = async (itemId: number, extra: any = {}) => ({ ...(await c.get(c.b(`/ratecard/line/${itemId}?client_id=${st.client}`))).body, ...extra });

test('1-2. business profile, Canadian tax, and a rate card', async () => {
  const biz = (await c.get(c.b('/business'))).body; assert.equal(biz.legal_name, 'Test Studio Inc.'); assert.equal(biz.currency, 'CAD'); assert.equal(biz.sequences.length, 4);
  st.gst = (await c.post(c.b('/taxes'), { name: 'GST', rate_milli: 5000 })).body.id;
  await c.put(c.b('/business/settings'), { default_tax_ids: [st.gst], payment_instructions: 'E-transfer to pay@teststudio.test', payment_terms_days: 14, template: 'minimal' });
  const cat = (await c.post(c.b('/ratecard/categories'), { name: 'Content' })).body.id;
  const mk = async (b: any) => (await c.post(c.b('/ratecard/items'), { category_id: cat, ...b })).body.id;
  st.reel = await mk({ name: 'Edit — reel', unit: 'reel', rate_cents: money(90), short_desc: 'Up to 60 seconds' });
  st.mgmt = await mk({ name: 'Social media management', unit: 'month', rate_cents: money(600), long_desc: 'Posting, community management and monthly report.' });
  const post = await mk({ name: 'Social post', unit: 'post', rate_cents: money(35) });
  st.pkg = await mk({ name: 'Growth package', kind: 'package', unit: 'package', pkg_price_mode: 'fixed', pkg_display: 'combined', rate_cents: money(1200), components: [{ item_id: st.reel, qty_milli: 4000 }, { item_id: post, qty_milli: 12000 }] });
  st.consult = await mk({ name: 'Consulting', unit: 'hour', rate_cents: money(120), tax_code_ids: [st.gst] });
});

test('3. client with negotiated rate, and project', async () => {
  st.client = (await c.post(c.b('/clients'), { name: 'Maple Events', company: 'Maple Events Ltd.', email: 'ap@maple.test', billing_address: '9 King St', tags: ['events'], contacts: [{ name: 'Sam', email: 'sam@maple.test', is_primary: 1 }] })).body.id;
  assert.equal((await c.post(c.b('/clients'), { name: 'Bad', email: 'nope' })).status, 400);
  const cp = await c.post(c.b(`/clients/${st.client}/prices`), { item_id: st.mgmt, rate_cents: money(500), note: 'Annual retainer agreement' }); assert.equal(cp.status, 201);
  st.project = (await c.post(c.b('/projects'), { client_id: st.client, name: 'Spring Gala 2026', budget_cents: money(5000), start_date: '2026-03-01' })).body.id;
  const search = (await c.get(c.b(`/ratecard/search?q=social&client_id=${st.client}`))).body.find((i: any) => i.id === st.mgmt);
  assert.equal(search.rate_cents, 50000); assert.equal(search.standard_rate_cents, 60000); assert.equal(search.source, 'client_agreement');
  const std = (await c.get(c.b(`/ratecard/search?q=social`))).body.find((i: any) => i.id === st.mgmt); assert.equal(std.rate_cents, 60000, 'global rate card untouched by the client agreement');
});

test('5-6. estimate from the rate card; totals; PDF', async () => {
  const lines = [await lineFor(st.reel, { qty_milli: 4000 }), await lineFor(st.mgmt), await lineFor(st.pkg), { description: 'Venue scouting', unit: 'visit', qty_milli: 1000, unit_price_cents: money(250), taxes: [{ id: st.gst }], detail: 'Two site visits' }];
  assert.equal(lines[1].price_source, 'client_agreement'); assert.equal(lines[1].unit_price_cents, 50000); assert.equal(lines[1].standard_price_cents, 60000);
  const r = await c.post(c.b('/documents'), { type: 'estimate', client_id: st.client, project_id: st.project, title: 'Spring Gala content', lines, discount_type: 'percent', discount_value: 5000, scope: 'Full coverage and edits for the gala.', deliverables: '4 reels, 12 posts', assumptions: 'Client supplies the venue access.', exclusions: 'Travel outside the GTA.',
    stages: [{ label: 'Deposit', kind: 'percent', value: 30000, due_days: 7 }, { label: 'Final balance', kind: 'balance' }] }, { 'Idempotency-Key': 'est-1' });
  assert.equal(r.status, 201, JSON.stringify(r.body)); st.est = r.body.id;
  const again = await c.post(c.b('/documents'), { type: 'estimate', client_id: st.client, lines, scope: 'dup' }, { 'Idempotency-Key': 'est-1' }); assert.equal(again.body.id, st.est, 'retry with same key does not create a second document');
  const d = (await c.get(c.b(`/documents/${st.est}`))).body;
  assert.equal(d.subtotal_cents, 36000 + 50000 + 120000 + 25000); assert.equal(d.discount_cents, 11550); assert.equal(d.tax_total_cents, 10973); assert.equal(d.total_cents, 230423);
  assert.equal(d.status, 'draft'); assert.equal(d.number, null);
  const calc = await c.post(c.b('/documents/calc'), { type: 'estimate', client_id: st.client, lines, discount_type: 'percent', discount_value: 5000 }); assert.equal(calc.body.total_cents, 230423, 'live calc endpoint agrees with saved totals');
  const iss = await c.post(c.b(`/documents/${st.est}/issue`)); assert.equal(iss.status, 200, JSON.stringify(iss.body)); assert.equal(iss.body.number, 'EST-0001'); assert.equal(iss.body.status, 'issued'); assert.ok(iss.body.valid_until);
  const pdf = await c.bytes(c.b(`/documents/${st.est}/pdf`)); assert.equal(pdf.type, 'application/pdf'); const t = pdfText(pdf.buf);
  for (const s of ['ESTIMATE', 'EST-0001', 'Maple Events', 'Edit — reel', 'Standard rate $600.00', 'agreed client rate $500.00', 'Includes: 4 reel Edit', '$2,304.23', 'GST (5%)', '$109.73', 'PAYMENT SCHEDULE', 'Deposit', 'SCOPE OF WORK', 'Venue scouting', '123456789 RT0001']) assert.ok(t.includes(s), `estimate PDF should contain "${s}"\n${t}`);
  const sow = pdfText((await c.bytes(c.b(`/documents/${st.est}/pdf?variant=sow`))).buf); assert.match(sow, /STATEMENT OF WORK/); assert.match(sow, /not a legally binding contract/);
});

test('7. issued estimates are immutable; cannot convert before acceptance; revision keeps history', async () => {
  assert.equal((await c.put(c.b(`/documents/${st.est}`), { client_id: st.client, lines: [] })).status, 409);
  assert.throws(() => S.db.prepare('UPDATE documents SET total_cents = 1 WHERE id = ?').run(st.est), /immutable/);
  assert.throws(() => S.db.prepare('UPDATE document_lines SET unit_price_cents = 1 WHERE document_id = ?').run(st.est), /immutable/);
  assert.throws(() => S.db.prepare('DELETE FROM documents WHERE id = ?').run(st.est), /Only draft/);
  assert.equal((await c.post(c.b(`/documents/${st.est}/convert`), { mode: 'full' })).status, 409);
  const rev = await c.post(c.b(`/documents/${st.est}/revise`)); assert.equal(rev.status, 201);
  const rd = (await c.get(c.b(`/documents/${rev.body.id}`))).body; assert.equal(rd.revision_no, 2); assert.equal(rd.status, 'draft');
  assert.equal((await c.post(c.b(`/documents/${st.est}/revise`))).status, 409, 'only one open revision');
  await c.del(c.b(`/documents/${rev.body.id}`)); // discard the revision; original stays current
  assert.equal((await c.get(c.b(`/documents/${st.est}`))).body.status, 'issued');
});

test('8-9. accept, convert stage-by-stage; prices survive a later rate card increase', async () => {
  assert.equal((await c.post(c.b(`/documents/${st.est}/accept`), { by: 'Sam at Maple', note: 'Email confirmation 2026-03-02' })).status, 200);
  const dep = await c.post(c.b(`/documents/${st.est}/convert`), { mode: 'stage', stage_id: (await c.get(c.b(`/documents/${st.est}`))).body.stages[0].id }); assert.equal(dep.status, 201, JSON.stringify(dep.body)); st.dep = dep.body.id;
  const depDoc = (await c.get(c.b(`/documents/${st.dep}`))).body; assert.equal(depDoc.total_cents, 65835 + 3292); assert.equal(depDoc.source_estimate_id, st.est);
  assert.equal((await c.post(c.b(`/documents/${st.est}/convert`), { mode: 'stage', stage_id: (await c.get(c.b(`/documents/${st.est}`))).body.stages[0].id })).status, 409, 'deposit cannot be billed twice');
  assert.equal((await c.post(c.b(`/documents/${st.est}/convert`), { mode: 'full' })).status, 409, 'cannot full-convert after a stage was billed');
  const bal = await c.post(c.b(`/documents/${st.est}/convert`), { mode: 'stage', stage_id: (await c.get(c.b(`/documents/${st.est}`))).body.stages[1].id }); st.bal = bal.body.id;
  const balDoc = (await c.get(c.b(`/documents/${st.bal}`))).body; assert.equal(balDoc.total_cents, 153615 + 7681);
  assert.equal(depDoc.tax_total_cents + balDoc.tax_total_cents, 10973, 'stage taxes add up to the estimate tax exactly');
  assert.equal(depDoc.total_cents + balDoc.total_cents, 230423, 'stage invoices add up to the estimate total exactly');
  // increase the rate card, then confirm the agreed prices on the estimate are unchanged
  await c.put(c.b(`/ratecard/items/${st.reel}`), { rate_cents: money(120) });
  const est = (await c.get(c.b(`/documents/${st.est}`))).body; assert.equal(est.lines[0].unit_price_cents, 9000); assert.equal(est.total_cents, 230423);
  assert.equal((await c.get(c.b(`/documents/${st.est}`))).body.stale, undefined, 'issued docs never report stale pricing');
  assert.equal((await c.post(c.b(`/documents/${st.dep}/issue`))).body.number, 'INV-0001'); assert.equal((await c.post(c.b(`/documents/${st.bal}/issue`))).body.number, 'INV-0002');
});

test('drafts show stale pricing and refresh only when asked; full conversion copies agreed lines', async () => {
  const d = await c.post(c.b('/documents'), { type: 'estimate', client_id: st.client, lines: [await lineFor(st.reel, { qty_milli: 2000 })] }); st.est2 = d.body.id;
  await c.put(c.b(`/ratecard/items/${st.reel}`), { rate_cents: money(130) });
  let doc = (await c.get(c.b(`/documents/${st.est2}`))).body; assert.equal(doc.stale.length, 1); assert.equal(doc.stale[0].current_price_cents, 12000); assert.equal(doc.stale[0].new_rate_cents, 13000); assert.equal(doc.total_cents, 24000 + 1200);
  await c.post(c.b(`/documents/${st.est2}/refresh-pricing`), { line_ids: [doc.lines[0].id] });
  doc = (await c.get(c.b(`/documents/${st.est2}`))).body; assert.equal(doc.lines[0].unit_price_cents, 13000); assert.equal(doc.stale.length, 0);
  await c.post(c.b(`/documents/${st.est2}/issue`)); await c.post(c.b(`/documents/${st.est2}/accept`), { by: 'Sam' });
  await c.put(c.b(`/ratecard/items/${st.reel}`), { rate_cents: money(200) });
  const full = await c.post(c.b(`/documents/${st.est2}/convert`), { mode: 'full' }); const inv = (await c.get(c.b(`/documents/${full.body.id}`))).body;
  assert.equal(inv.lines[0].unit_price_cents, 13000, 'invoice keeps agreed price after another increase'); assert.equal(inv.total_cents, 27300);
  assert.equal((await c.post(c.b(`/documents/${st.est2}/convert`), { mode: 'full' })).status, 409, 'no duplicate billing');
  st.full = inv.id;
  await c.del(c.b(`/documents/${st.full}`)); // delete the draft → estimate can be converted again
  assert.equal((await c.post(c.b(`/documents/${st.est2}/convert`), { mode: 'full' })).status, 201);
});

test('10. invoice PDF', async () => {
  const pdf = await c.bytes(c.b(`/documents/${st.dep}/pdf`)); const t = pdfText(pdf.buf);
  for (const s of ['INVOICE', 'INV-0001', 'Due date', 'Balance due', '$691.27', 'E-transfer to pay@teststudio.test', 'Deposit (Estimate EST-0001']) assert.ok(t.includes(s), `invoice PDF should contain "${s}"\n${t}`);
});

test('11-14. partial payment, remaining balance, final payment, receipts, idempotency, over-payment', async () => {
  const pay = (body: any, h?: any) => c.post(c.b('/payments'), { paid_date: '2026-03-05', method: 'E-transfer', ...body }, h);
  const over = await pay({ amount_cents: 70000, allocations: [{ invoice_id: st.dep, amount_cents: 70000 }] }); assert.equal(over.status, 400); assert.match(over.body.error, /exceeds the outstanding balance/);
  const p1 = await pay({ amount_cents: 30000, reference: 'ET-1001', allocations: [{ invoice_id: st.dep, amount_cents: 30000 }] }, { 'Idempotency-Key': 'pay-1' }); assert.equal(p1.status, 201); st.p1 = p1.body.id;
  const dup = await pay({ amount_cents: 30000, reference: 'ET-1001', allocations: [{ invoice_id: st.dep, amount_cents: 30000 }] }, { 'Idempotency-Key': 'pay-1' }); assert.equal(dup.body.id, st.p1, 'double-click / retry does not double-record');
  let inv = (await c.get(c.b(`/documents/${st.dep}`))).body; assert.equal(inv.amount_paid_cents, 30000); assert.equal(inv.balance_cents, 39127); assert.equal(inv.display_status, 'partially_paid');
  const p2 = await pay({ amount_cents: 39127, allocations: [{ invoice_id: st.dep, amount_cents: 39127 }], paid_date: '2026-03-20' }); assert.equal(p2.status, 201); st.p2 = p2.body.id;
  inv = (await c.get(c.b(`/documents/${st.dep}`))).body; assert.equal(inv.balance_cents, 0); assert.equal(inv.display_status, 'paid');
  assert.equal((await pay({ amount_cents: 1, allocations: [{ invoice_id: st.dep, amount_cents: 1 }] })).status, 400, 'paid invoice accepts no more');
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM payments').get()!.n, 2);
  assert.throws(() => S.db.prepare('INSERT INTO payment_allocations (payment_id, invoice_id, amount_cents) VALUES (?,?,?)').run(st.p1, st.dep, 1), /exceeds/, 'the database itself refuses over-allocation');
  const rc = await c.bytes(c.b(`/payments/${st.p2}/receipt`)); assert.equal(rc.type, 'application/pdf'); const rt = pdfText(rc.buf);
  for (const s of ['RECEIPT', 'RCT-0002', '$391.27', 'INV-0001', 'recorded manually']) assert.ok(rt.includes(s), `receipt should contain ${s}\n${rt}`);
  const em = await c.post(c.b(`/payments/${st.p2}/email-receipt`), {}); assert.equal(em.body.status, 'sent'); assert.equal(mailer.sent.at(-1)!.to, 'ap@maple.test'); assert.equal(mailer.sent.at(-1)!.attachments![0].contentType, 'application/pdf');
  // unallocated deposit held on account then applied
  const adv = await pay({ amount_cents: 20000, client_id: st.client }); assert.equal((await c.get(c.b(`/payments/${adv.body.id}`))).body.unallocated_cents, 20000);
  const al = await c.post(c.b(`/payments/${adv.body.id}/allocate`), { invoice_id: st.bal, amount_cents: 20000 }); assert.equal(al.status, 200); assert.equal(al.body.unallocated_cents, 0);
  assert.equal((await c.get(c.b(`/documents/${st.bal}`))).body.amount_paid_cents, 20000);
  // refund and void
  const rf = await pay({ kind: 'refund', amount_cents: 5000, allocations: [{ invoice_id: st.bal, amount_cents: 5000 }], paid_date: '2026-03-25' }); assert.equal(rf.status, 201);
  assert.equal((await c.get(c.b(`/documents/${st.bal}`))).body.amount_paid_cents, 15000);
  assert.equal((await c.post(c.b(`/payments/${adv.body.id}/void`), { reason: 'x' })).status, 409, 'cannot void a payment that has a live refund');
  await c.post(c.b(`/payments/${rf.body.id}/void`), { reason: 'refund entered by mistake' }); await c.post(c.b(`/payments/${adv.body.id}/void`), { reason: 'bounced' });
  assert.equal((await c.get(c.b(`/documents/${st.bal}`))).body.amount_paid_cents, 0);
  assert.equal((await c.post(c.b(`/documents/${st.dep}/void`), { reason: 'oops' })).status, 409, 'invoice with payments cannot be voided');
});

test('15-16. expenses, receipts upload, dashboard distinguishes invoiced from received', async () => {
  const cats = (await c.get(c.b('/expense-categories'))).body; assert.ok(cats.length >= 10);
  const e = await c.post(c.b('/expenses'), { expense_date: '2026-03-10', merchant: 'Rental House', description: 'Lens rental', category_id: cats.find((x: any) => x.name === 'Equipment').id, amount_cents: 10500, tax_cents: 500, client_id: st.client, project_id: st.project, billable: 1 }); assert.equal(e.status, 201); st.exp = e.body.id;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await c.post(c.b(`/expenses/${st.exp}/attachments`), { filename: 'receipt.png', data_base64: png.toString('base64') })).status, 201);
  assert.equal((await c.post(c.b(`/expenses/${st.exp}/attachments`), { filename: 'evil.png', data_base64: Buffer.from('<svg onload=alert(1)>').toString('base64') })).status, 400, 'content sniffing rejects fake images');
  assert.equal((await c.post(c.b(`/expenses/${st.exp}/attachments`), { filename: 'x.html', data_base64: Buffer.from('<html>').toString('base64') })).status, 400);
  const dash = (await c.get(c.b('/dashboard?from=2026-01-01&to=2026-12-31'))).body.currencies.find((x: any) => x.currency === 'CAD');
  assert.equal(dash.invoiced_cents, 69127 + 161296, 'invoiced = issued invoices'); assert.equal(dash.received_cents, 69127, 'received = cash recorded (voided payments excluded)');
  assert.equal(dash.expenses_cents, 10500); assert.equal(dash.cash_minus_expenses_cents, 69127 - 10500); assert.equal(dash.outstanding_cents, 161296);
});

test('billable expense and time go onto an invoice once only', async () => {
  const t = await c.post(c.b('/time'), { client_id: st.client, project_id: st.project, entry_date: '2026-03-11', hours: 2.5, rate_cents: money(120), notes: 'Planning call', billable: 1 }); assert.equal(t.status, 201);
  const inv = (await c.post(c.b('/documents'), { type: 'invoice', client_id: st.client, project_id: st.project, lines: [] })).body.id;
  const add = await c.post(c.b(`/documents/${inv}/billable`), { time_entry_ids: [t.body.id], expense_ids: [st.exp] }); assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.total_cents, 30000 + 10000 + 2000, 'time $300 + expense $100 (pre-tax) + 5% GST = $420');
  const inv2 = (await c.post(c.b('/documents'), { type: 'invoice', client_id: st.client, lines: [] })).body.id;
  const dupe = await c.post(c.b(`/documents/${inv2}/billable`), { time_entry_ids: [t.body.id] }); assert.equal(dupe.status, 409);
  assert.equal((await c.put(c.b(`/time/${t.body.id}`), { client_id: st.client, entry_date: '2026-03-11', hours: 1, rate_cents: 1 })).status, 409, 'invoiced time is locked');
  const forced = await c.post(c.b(`/documents/${inv2}/billable`), { time_entry_ids: [t.body.id], override: true }); assert.equal(forced.status, 200, 'explicit override allowed');
  assert.ok((await c.get(c.b('/ratecard/items'))).body.length > 0);
  assert.equal((await c.del(c.b(`/documents/${inv2}`))).status, 200); assert.equal((await c.del(c.b(`/documents/${inv}`))).status, 200);
  const free = (await c.get(c.b('/time?unbilled=1'))).body; assert.ok(free.some((x: any) => x.id === t.body.id), 'deleting the draft releases the time entry');
});

test('credit notes reduce the balance; disputes and due-date changes are explicit', async () => {
  const cn = await c.post(c.b(`/documents/${st.bal}/credit-note`), { mode: 'full', reason: 'Event scaled down' }); assert.equal(cn.status, 201);
  const issued = await c.post(c.b(`/documents/${cn.body.id}/issue`)); assert.equal(issued.body.number, 'CN-0001'); assert.equal(issued.body.total_cents, 161296);
  const bal = (await c.get(c.b(`/documents/${st.bal}`))).body; assert.equal(bal.balance_cents, 0); assert.equal(bal.display_status, 'credited'); assert.equal(bal.credited_cents, 161296);
  const over = await c.post(c.b(`/documents/${st.bal}/credit-note`), { mode: 'full' }); await c.post(c.b(`/documents/${over.body.id}/issue`)).then((r) => assert.equal(r.status, 400, 'cannot credit more than is outstanding'));
  assert.equal((await c.post(c.b('/payments'), { paid_date: '2026-04-01', method: 'Cash', amount_cents: 100, allocations: [{ invoice_id: st.bal, amount_cents: 100 }] })).status, 400);
  const tax = (await c.get(c.b('/reports/tax_collected?from=2026-01-01&to=2026-12-31'))).body; const gst = tax.rows.filter((r: any) => r.tax === 'GST').reduce((a: number, r: any) => a + r.tax_cents, 0);
  assert.equal(gst, 3292 + 7681 - 7681, 'tax report nets the credit note');
  await c.post(c.b(`/documents/${over.body.id}`)).catch(() => 0); await c.del(c.b(`/documents/${over.body.id}`));
  assert.equal((await c.post(c.b(`/documents/${st.dep}/dispute`), { disputed: true, note: 'Client questions line 2' })).status, 200);
});

test('17. exports respect data and include related records', async () => {
  const csv = await c.bytes(c.b('/reports/revenue_by_service?format=csv&from=2026-01-01&to=2026-12-31')); const t = csv.buf.toString('utf8');
  assert.match(csv.type, /text\/csv/); assert.match(t, /Service,Unit,Currency,Quantity,Revenue \(excl\. tax\)/);
  const pays = (await c.bytes(c.b('/reports/payments_received?format=csv'))).buf.toString(); assert.match(pays, /ET-1001/); assert.match(pays, /manual/);
  const aging = (await c.get(c.b('/reports/aging'))).body; assert.ok(Array.isArray(aging.rows));
  for (const name of (await c.get(c.b('/reports'))).body) { const r = await c.get(c.b(`/reports/${name}`)); assert.equal(r.status, 200, name); const csvR = await c.bytes(c.b(`/reports/${name}?format=csv`)); assert.equal(csvR.status, 200, name); }
  const pdfRep = await c.bytes(c.b('/reports/revenue_by_client?format=pdf')); assert.equal(pdfRep.buf.subarray(0, 5).toString(), '%PDF-'); assert.match(pdfText(pdfRep.buf), /Revenue by client/);
  const zip = await c.bytes(c.b('/export/business.zip')); assert.equal(zip.type, 'application/zip');
  const f = path.join(S.dir, 'export.zip'); fs.writeFileSync(f, zip.buf);
  const listing = execFileSync('unzip', ['-l', f], { encoding: 'utf8' }); for (const n of ['manifest.json', 'data.json', 'csv/clients.csv', 'csv/invoices.csv', 'csv/payments.csv', 'csv/document_lines.csv', 'csv/rate_card_items.csv', 'csv/expenses.csv']) assert.ok(listing.includes(n), n);
  execFileSync('unzip', ['-tq', f]); const data = JSON.parse(execFileSync('unzip', ['-p', f, 'data.json'], { encoding: 'utf8', maxBuffer: 5e7 })); assert.ok(data.invoices.length >= 2); assert.ok(!JSON.stringify(data).includes('password'));
  assert.ok(!JSON.stringify(data).includes('public_token_hash":"'), 'no tokens exported');
});

test('18. backup → verify → corrupt → restore round trip', async () => {
  const b = createBackup(S.db, path.join(S.dir, 'bk')); const v = verifyBackup(b.file);
  assert.equal(v.ok, true, JSON.stringify(v.checks)); assert.equal(v.counts!.documents, b.counts.documents);
  const bad = path.join(S.dir, 'bk', 'corrupt.db'); const buf = fs.readFileSync(b.file); buf.fill(0, 4096, 4096 + 2048); fs.writeFileSync(bad, buf);
  assert.equal(verifyBackup(bad).ok, false, 'corrupted backup is detected');
  fs.writeFileSync(b.file + '.x', ''); fs.rmSync(b.file + '.x');
  const live = path.join(S.dir, 'restored.db'); fs.writeFileSync(live, 'garbage'); const r = restoreBackup(b.file, live);
  const db2 = openDb(live); assert.equal(Number(get(db2, 'SELECT COUNT(*) n FROM documents')!.n), b.counts.documents); assert.equal(Number(get(db2, 'SELECT COUNT(*) n FROM payments')!.n), b.counts.payments);
  for (const d of all(db2, "SELECT id FROM documents WHERE status<>'draft'")) assert.ok(verifyDocument({ db: db2, bid: c.bid, uid: 1, role: 'owner' }, d.id).ok);
  assert.ok(fs.existsSync(r.previous)); db2.close();
  assert.throws(() => restoreBackup(bad, live), /refusing to restore/);
});

test('every stored document recalculates to its stored totals (integrity sweep)', () => {
  for (const d of all(S.db, "SELECT id, number FROM documents WHERE status<>'draft'")) { const v = verifyDocument(ctx(), d.id); assert.ok(v.ok, `${d.number}: ${JSON.stringify(v)}`); }
  void recalcStored; void pdfPages;
});
