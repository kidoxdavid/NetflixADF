import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, setupBusiness, Client, fakeMailer, money, pdfText } from './helpers.ts';
import { runRecurring, runReminders, advance } from '../server/src/recurring.ts';
import { get, all } from '../server/src/db.ts';
import { nextNumber } from '../server/src/core.ts';
import { tx } from '../server/src/db.ts';

let S: Awaited<ReturnType<typeof startServer>>; let A: Client; let B: Client; const mailer = fakeMailer(true);
before(async () => { S = await startServer({ mailer, allowRegistration: true }); A = await setupBusiness(S.base, 'a@example.test', 'Business A'); B = await setupBusiness(S.base, 'b@example.test', 'Business B'); });
after(async () => { await S.close(); });

const seed = async (c: Client) => {
  const cl = (await c.post(c.b('/clients'), { name: 'Client of ' + c.bid, email: 'cl@example.test' })).body.id;
  const it = (await c.post(c.b('/ratecard/items'), { name: 'Svc', unit: 'hour', rate_cents: money(100) })).body.id;
  const line = (await c.get(c.b(`/ratecard/line/${it}`))).body;
  const doc = (await c.post(c.b('/documents'), { type: 'invoice', client_id: cl, lines: [line] })).body.id;
  await c.post(c.b(`/documents/${doc}/issue`));
  return { cl, it, doc };
};

test('authentication is required for every business route; sessions are HttpOnly', async () => {
  const anon = new Client(S.base); anon.bid = A.bid;
  for (const u of ['/clients', '/ratecard/items', '/invoices', '/payments', '/dashboard', '/business', '/export/business.zip', '/audit']) assert.equal((await anon.get(anon.b(u))).status, 401, u);
  const login = await anon.raw('POST', '/api/auth/login', { email: 'a@example.test', password: 'correct horse battery' });
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/); assert.match(login.headers.get('set-cookie')!, /SameSite=Lax/);
  assert.equal((await new Client(S.base).post('/api/auth/login', { email: 'a@example.test', password: 'wrong password!!' })).status, 401);
});

test('cross-business isolation: B can never read or touch A\'s records (IDs guessed)', async () => {
  const a = await seed(A); const b = await seed(B);
  assert.equal((await B.get(`/api/b/${A.bid}/clients`)).status, 404, 'other workspace is invisible');
  assert.equal((await B.post(`/api/b/${A.bid}/clients`, { name: 'x' })).status, 404);
  // right workspace, other tenant's IDs
  assert.equal((await B.get(B.b(`/documents/${a.doc}`))).status, 404);
  assert.equal((await B.get(B.b(`/clients/${a.cl}`))).status, 404);
  assert.equal((await B.get(B.b(`/ratecard/items/${a.it}`))).status, 404);
  assert.equal((await B.bytes(B.b(`/documents/${a.doc}/pdf`))).status, 404);
  assert.equal((await B.post(B.b(`/documents/${a.doc}/void`), { reason: 'x' })).status, 404);
  assert.equal((await B.post(B.b('/documents'), { type: 'invoice', client_id: a.cl, lines: [] })).status, 404, 'cannot bill another business\'s client');
  const line = (await B.get(B.b(`/ratecard/line/${b.it}`))).body;
  assert.equal((await B.post(B.b('/documents'), { type: 'invoice', client_id: b.cl, lines: [{ ...line, rc_item_id: a.it }] })).status, 404, 'cannot reference another business\'s rate card item');
  assert.equal((await B.post(B.b('/payments'), { paid_date: '2026-01-01', method: 'Cash', amount_cents: 100, allocations: [{ invoice_id: a.doc, amount_cents: 100 }] })).status, 404);
  assert.equal((await B.get(B.b('/invoices'))).body.some((d: any) => d.id === a.doc), false);
  assert.equal((await B.get(B.b('/clients'))).body.some((d: any) => d.id === a.cl), false);
  assert.equal((await B.post(B.b('/payments'), { paid_date: '2026-01-01', method: 'Cash', amount_cents: 100, allocations: [{ invoice_id: b.doc, amount_cents: 100 }] })).status, 201);
  assert.throws(() => S.db.prepare('INSERT INTO payments (business_id, client_id, amount_cents, currency, paid_date, method) VALUES (?,?,?,?,?,?)').run(A.bid, a.cl, 100, 'CAD', '2026-01-01', 'x') && S.db.prepare('INSERT INTO payment_allocations (payment_id, invoice_id, amount_cents) VALUES ((SELECT MAX(id) FROM payments), ?, 100)').run(b.doc), /different businesses/, 'the database rejects cross-tenant allocations too');
});

test('roles: viewers are read-only, staff cannot change settings, void or export', async () => {
  const mk = async (email: string, role: string) => { await A.post(A.b('/members'), { email, name: role, password: 'a-long-password-1', role }); const c = new Client(S.base, A.bid); await c.post('/api/auth/login', { email, password: 'a-long-password-1' }); return c; };
  const viewer = await mk('v@example.test', 'viewer'); const staff = await mk('s@example.test', 'staff');
  assert.equal((await viewer.get(viewer.b('/clients'))).status, 200);
  assert.equal((await viewer.post(viewer.b('/clients'), { name: 'nope' })).status, 403);
  assert.equal((await staff.post(staff.b('/clients'), { name: 'ok' })).status, 201);
  for (const [m, u] of [['PUT', '/business/settings'], ['POST', '/taxes'], ['POST', '/members'], ['POST', '/ratecard/versions']] as const) assert.equal((await staff.req(m, staff.b(u), {})).status, 403, u);
  assert.equal((await staff.get(staff.b('/export/business.zip'))).status, 403); assert.equal((await staff.get(staff.b('/audit'))).status, 403);
  const { doc } = await seed(A); assert.equal((await staff.post(staff.b(`/documents/${doc}/void`), { reason: 'x' })).status, 403);
  assert.equal((await staff.post(staff.b('/backups'))).status, 403);
});

test('CSRF: mutations without the custom header or from a foreign origin are refused', async () => {
  const r = await fetch(S.base + A.b('/clients'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie }, body: JSON.stringify({ name: 'csrf' }) }); assert.equal(r.status, 403);
  const r2 = await fetch(S.base + A.b('/clients'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-lf-request': '1', origin: 'https://evil.example', cookie: A.cookie }, body: JSON.stringify({ name: 'csrf' }) }); assert.equal(r2.status, 403);
  assert.ok(!(await A.get(A.b('/clients'))).body.some((c: any) => c.name === 'csrf'));
});

test('registration closes after the first user unless explicitly enabled', async () => {
  const s2 = await startServer(); try { const c = new Client(s2.base); assert.equal((await c.post('/api/auth/register', { email: 'x@example.test', name: 'X', password: 'long enough pw' })).status, 201); assert.equal((await new Client(s2.base).post('/api/auth/register', { email: 'y@example.test', name: 'Y', password: 'long enough pw' })).status, 403); assert.equal((await new Client(s2.base).post('/api/auth/register', { email: 'z@example.test', name: 'Z', password: 'short' })).status, 403); } finally { await s2.close(); }
  assert.equal((await new Client(S.base).post('/api/auth/register', { email: 'weak@example.test', name: 'W', password: 'short' })).status, 400);
});

test('invoice number collisions: sequential and concurrent allocation never duplicate', async () => {
  const cl = (await A.post(A.b('/clients'), { name: 'Race' })).body.id;
  const ids: number[] = []; for (let i = 0; i < 12; i++) ids.push((await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'x', qty_milli: 1000, unit_price_cents: 100 + i }] })).body.id);
  const res = await Promise.all(ids.map((id) => A.post(A.b(`/documents/${id}/issue`)))); assert.ok(res.every((r) => r.status === 200));
  const nums = res.map((r) => r.body.number); assert.equal(new Set(nums).size, 12, 'all unique'); const sorted = [...nums].sort(); assert.equal(sorted[11].slice(0, 4), 'INV-');
  const seqs = nums.map((n: string) => Number(n.slice(4))).sort((a: number, b: number) => a - b); for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, 'gap-free');
  assert.throws(() => S.db.prepare("UPDATE documents SET number = ? WHERE id = ?").run(nums[0], ids[1]), /immutable|UNIQUE/);
  const dup = nums[0]; assert.throws(() => S.db.prepare("INSERT INTO documents (business_id, type, number, client_id, currency) VALUES (?,?,?,?,?)").run(A.bid, 'invoice', dup, cl, 'CAD'), /UNIQUE/, 'database enforces uniqueness');
  assert.throws(() => tx(S.db, () => { nextNumber(S.db, A.bid, 'invoice'); throw new Error('rollback me'); }), /rollback me/);
  const highest = Math.max(...seqs); assert.equal(Number(get(S.db, "SELECT next_number n FROM number_sequences WHERE business_id=? AND kind='invoice'", A.bid)!.n), highest + 1, 'a rolled-back allocation does not burn a number');
});

test('duplicate submissions: issuing twice and paying with a reused key are safe', async () => {
  const { doc } = await seed(A); assert.equal((await A.post(A.b(`/documents/${doc}/issue`))).status, 409);
  const h = { 'Idempotency-Key': 'k-123' }; const body = { paid_date: '2026-01-02', method: 'Cash', amount_cents: 5000, allocations: [{ invoice_id: doc, amount_cents: 5000 }] };
  const [r1, r2] = await Promise.all([A.post(A.b('/payments'), body, h), A.post(A.b('/payments'), body, h)]); assert.equal(r1.body.id, r2.body.id);
  assert.equal(Number(get(S.db, 'SELECT COUNT(*) n FROM payments WHERE business_id=? AND idempotency_key=?', A.bid, 'k-123')!.n), 1);
  assert.equal((await A.get(A.b(`/documents/${doc}`))).body.amount_paid_cents, 5000);
});

test('invalid amounts, over-payment and over-allocation are rejected server-side', async () => {
  const { doc, cl } = await seed(A); const pay = (b: any) => A.post(A.b('/payments'), { paid_date: '2026-01-02', method: 'Cash', ...b });
  assert.equal((await pay({ amount_cents: 0, allocations: [] , client_id: cl })).status, 400); assert.equal((await pay({ amount_cents: -5, client_id: cl })).status, 400); assert.equal((await pay({ amount_cents: 10.5, client_id: cl })).status, 400); assert.equal((await pay({ amount_cents: 'abc', client_id: cl })).status, 400);
  assert.equal((await pay({ amount_cents: 100, allocations: [{ invoice_id: doc, amount_cents: 200 }] })).status, 400, 'allocation > payment');
  assert.equal((await pay({ amount_cents: 99999999, allocations: [{ invoice_id: doc, amount_cents: 99999999 }] })).status, 400, 'payment > balance');
  assert.equal((await pay({ amount_cents: 100, allocations: [{ invoice_id: doc, amount_cents: 50 }, { invoice_id: doc, amount_cents: 50 }] })).status, 400, 'same invoice twice');
  assert.equal((await pay({ paid_date: '2999-01-01', amount_cents: 100, allocations: [{ invoice_id: doc, amount_cents: 100 }] })).status, 400, 'future date');
  const draft = (await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'd', qty_milli: 1000, unit_price_cents: 100 }] })).body.id; assert.equal((await pay({ amount_cents: 100, allocations: [{ invoice_id: draft, amount_cents: 100 }] })).status, 400, 'drafts cannot receive payments');
  assert.equal((await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'bad', qty_milli: 0, unit_price_cents: 100 }] })).status, 400);
  assert.equal((await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'bad', qty_milli: 1000, unit_price_cents: 1.5 }] })).status, 400);
  assert.equal((await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'neg', qty_milli: 1000, unit_price_cents: -500 }] })).status, 400, 'negative total refused');
  assert.equal((await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, discount_type: 'percent', discount_value: 200000, lines: [{ description: 'x', qty_milli: 1000, unit_price_cents: 100 }] })).status, 400);
  assert.equal((await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'x', qty_milli: 1000, unit_price_cents: 100, taxes: [{ id: 99999 }] }] })).status, 400, 'unknown tax id');
});

test('tax rates and rate-card prices come from the server, not the browser', async () => {
  const t = (await A.post(A.b('/taxes'), { name: 'GST', rate_milli: 5000 })).body.id; const cl = (await A.post(A.b('/clients'), { name: 'TaxTest' })).body.id;
  const it = (await A.post(A.b('/ratecard/items'), { name: 'Fixed', unit: 'item', rate_cents: 10000 })).body.id;
  const id = (await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'Fixed', rc_item_id: it, qty_milli: 1000, unit_price_cents: 10000, taxes: [{ id: t, name: 'FAKE', rate_milli: 1 }], standard_price_cents: 1 }] })).body.id;
  const d = (await A.get(A.b(`/documents/${id}`))).body; assert.equal(d.tax_summary[0].name, 'GST'); assert.equal(d.tax_summary[0].tax_cents, 500); assert.equal(d.lines[0].standard_price_cents, 10000); assert.equal(d.lines[0].price_source, 'rate_card');
  const id2 = (await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'Fixed', rc_item_id: it, qty_milli: 1000, unit_price_cents: 7000, price_source: 'rate_card' }] })).body.id; assert.equal((await A.get(A.b(`/documents/${id2}`))).body.lines[0].price_source, 'custom', 'an edited price is labelled custom');
  const cq = (await A.post(A.b('/ratecard/items'), { name: 'Quote me', unit: 'event', pricing_type: 'custom_quote' })).body.id;
  const id3 = (await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'Quote me', rc_item_id: cq, qty_milli: 1000, unit_price_cents: 5000 }] })).body.id;
  const iss = await A.post(A.b(`/documents/${id3}/issue`)); assert.equal(iss.status, 400); assert.match(iss.body.error, /price must be confirmed/);
  await A.put(A.b(`/documents/${id3}`), { client_id: cl, lines: [{ description: 'Quote me', rc_item_id: cq, qty_milli: 1000, unit_price_cents: 5000, price_confirmed: 1 }] }); assert.equal((await A.post(A.b(`/documents/${id3}/issue`))).status, 200);
});

test('tax-inclusive and tax-exempt clients through the API; changing tax defaults never alters issued documents', async () => {
  const t = get(S.db, "SELECT id FROM tax_codes WHERE business_id=? AND name='GST'", A.bid)!.id as number;
  const ex = (await A.post(A.b('/clients'), { name: 'Exempt Co', tax_exempt: true, tax_exempt_note: 'Status card 123' })).body.id; assert.equal((await A.post(A.b('/clients'), { name: 'NoNote', tax_exempt: true })).status, 400);
  const lines = [{ description: 'x', qty_milli: 1000, unit_price_cents: 10000, taxes: [{ id: t }] }];
  const d1 = (await A.post(A.b('/documents'), { type: 'invoice', client_id: ex, lines })).body.id; const doc1 = (await A.get(A.b(`/documents/${d1}`))).body; assert.equal(doc1.tax_total_cents, 0); assert.equal(doc1.total_cents, 10000);
  const cl = (await A.post(A.b('/clients'), { name: 'Incl' })).body.id; const d2 = (await A.post(A.b('/documents'), { type: 'invoice', client_id: cl, prices_include_tax: true, lines })).body.id; await A.post(A.b(`/documents/${d2}/issue`));
  const before = (await A.get(A.b(`/documents/${d2}`))).body; assert.equal(before.total_cents, 10000); assert.equal(before.tax_total_cents, 476);
  await A.put(A.b(`/taxes/${t}`), { name: 'GST', rate_milli: 15000, active: 1 });
  const after = (await A.get(A.b(`/documents/${d2}`))).body; assert.equal(after.tax_total_cents, 476); assert.equal(after.lines[0].taxes[0].rate_milli, 5000, 'issued line keeps its tax snapshot'); assert.equal(after.tax_summary[0].rate_milli, 5000);
  await A.put(A.b(`/taxes/${t}`), { name: 'GST', rate_milli: 5000, active: 1 });
});

test('recurring invoices: retries never duplicate; end date respected; never charges', async () => {
  const cl = (await A.post(A.b('/clients'), { name: 'Retainer Co' })).body.id; const it = (await A.post(A.b('/ratecard/items'), { name: 'Retainer', unit: 'month', rate_cents: money(500) })).body.id;
  const line = (await A.get(A.b(`/ratecard/line/${it}`))).body;
  const sch = (await A.post(A.b('/recurring'), { name: 'Monthly retainer', client_id: cl, frequency: 'monthly', start_date: '2026-01-31', end_date: '2026-04-30', auto_issue: 1, payment_terms_days: 10, lines: [line] })); assert.equal(sch.status, 201);
  const r1 = runRecurring(S.db, '2026-03-15', A.bid); assert.equal(r1.created.length, 2, 'Jan + Feb catch-up'); assert.equal(r1.issued.length, 2);
  const r2 = runRecurring(S.db, '2026-03-15', A.bid); assert.equal(r2.created.length, 0, 'retry creates nothing');
  const r3 = runRecurring(S.db, '2026-03-15', A.bid); assert.equal(r3.created.length, 0);
  const inv = all(S.db, 'SELECT issue_date, due_date, status, recurring_schedule_id FROM documents WHERE recurring_schedule_id=? ORDER BY issue_date', sch.body.id); assert.deepEqual(inv.map((x) => x.issue_date), ['2026-01-31', '2026-02-28']); assert.equal(inv[0].due_date, '2026-02-10'); assert.ok(inv.every((x) => x.status === 'issued'));
  assert.throws(() => S.db.prepare('INSERT INTO recurring_runs (schedule_id, run_date) VALUES (?,?)').run(sch.body.id, '2026-01-31'), /UNIQUE/, 'database-level guard');
  const r4 = runRecurring(S.db, '2026-12-31', A.bid); assert.equal(r4.created.length, 2, 'Mar 31 + Apr 30 then stops at the end date'); assert.equal(Number(get(S.db, 'SELECT active a FROM recurring_schedules WHERE id=?', sch.body.id)!.a), 0);
  assert.equal(advance('2026-01-31', 'monthly', 1, '2026-01-31'), '2026-02-28'); assert.equal(advance('2026-01-31', 'monthly', 2, '2026-01-31'), '2026-03-31'); assert.equal(advance('2024-02-29', 'yearly', 1, '2024-02-29'), '2025-02-28');
  assert.equal(Number(get(S.db, "SELECT COUNT(*) n FROM payments WHERE client_id=?", cl)!.n), 0, 'recurring invoicing creates no payments');
  const draftSch = (await A.post(A.b('/recurring'), { name: 'Draft mode', client_id: cl, frequency: 'weekly', start_date: '2026-06-01', auto_issue: 0, lines: [line] })).body.id; const r5 = runRecurring(S.db, '2026-06-01', A.bid); assert.equal(r5.created.length, 1); assert.equal(r5.issued.length, 0); void draftSch;
});

test('reminders: once per invoice+offset, never for paid/void/disputed, honest about sending', async () => {
  await A.put(A.b('/business/settings'), { reminders: { enabled: true, offsets: [0, 7] } });
  const cl = (await A.post(A.b('/clients'), { name: 'Slow Payer', email: 'slow@example.test' })).body.id; const noMail = (await A.post(A.b('/clients'), { name: 'No Email' })).body.id;
  const mk = async (client: number, due: string) => { const id = (await A.post(A.b('/documents'), { type: 'invoice', client_id: client, issue_date: '2026-01-01', due_date: due, lines: [{ description: 'x', qty_milli: 1000, unit_price_cents: 10000 }] })).body.id; await A.post(A.b(`/documents/${id}/issue`), { issue_date: '2026-01-01', due_date: due }); return id; };
  const open = await mk(cl, '2026-05-01'); const paid = await mk(cl, '2026-05-01'); const disp = await mk(cl, '2026-05-01'); const nm = await mk(noMail, '2026-05-01'); const voided = await mk(cl, '2026-05-01');
  await A.post(A.b('/payments'), { paid_date: '2026-04-30', method: 'Cash', amount_cents: 10000, allocations: [{ invoice_id: paid, amount_cents: 10000 }] }); await A.post(A.b(`/documents/${disp}/dispute`), { disputed: true, note: 'x' }); await A.post(A.b(`/documents/${voided}/void`), { reason: 'x' });
  const sentBefore = mailer.sent.length; const r1 = await runReminders(S.db, '2026-05-01', mailer, A.bid); assert.equal(r1.sent, 1, 'only the open invoice with an email'); assert.equal(r1.prepared, 1, 'no-email client gets a prepared (unsent) message'); assert.equal(mailer.sent.length, sentBefore + 1);
  const r2 = await runReminders(S.db, '2026-05-01', mailer, A.bid); assert.equal(r2.sent + r2.prepared, 0, 'retry sends nothing new'); assert.equal(mailer.sent.length, sentBefore + 1);
  const r3 = await runReminders(S.db, '2026-05-08', mailer, A.bid); assert.equal(r3.sent, 1, 'the +7 day overdue notice goes out once');
  const status = (await A.get(A.b(`/documents/${nm}`))).body.communications[0]; assert.equal(status.status, 'drafted'); void open;
  mailer.failNext = true; const open2 = await mk(cl, '2026-06-01'); const r4 = await runReminders(S.db, '2026-06-01', mailer, A.bid); assert.equal(r4.failed, 1); assert.equal((await A.get(A.b(`/documents/${open2}`))).body.communications[0].status, 'failed');
  assert.equal(get(S.db, 'SELECT error FROM communications WHERE document_id=?', open2)!.error, 'SMTP connection refused');
});

test('email: draft vs sent vs failed are reported accurately; unconfigured servers never claim to send', async () => {
  const { doc } = await seed(A); mailer.failNext = true;
  const f = await A.post(A.b(`/documents/${doc}/email`), { to: 'cl@example.test' }); assert.equal(f.status, 502); assert.equal(f.body.status, 'failed');
  const ok = await A.post(A.b(`/documents/${doc}/email`), { to: 'cl@example.test' }); assert.equal(ok.body.status, 'sent'); assert.equal(mailer.sent.at(-1)!.attachments![0].filename.endsWith('.pdf'), true);
  const dr = await A.post(A.b(`/documents/${doc}/email`), { to: 'cl@example.test', send: false }); assert.equal(dr.body.status, 'drafted');
  assert.deepEqual((await A.get(A.b(`/documents/${doc}`))).body.communications.map((c: any) => c.status).sort(), ['drafted', 'failed', 'sent']);
  const s2 = await startServer(); try { const c = await setupBusiness(s2.base); const cl = (await c.post(c.b('/clients'), { name: 'X', email: 'x@y.test' })).body.id; const id = (await c.post(c.b('/documents'), { type: 'invoice', client_id: cl, lines: [{ description: 'a', qty_milli: 1000, unit_price_cents: 100 }] })).body.id; await c.post(c.b(`/documents/${id}/issue`)); const r = await c.post(c.b(`/documents/${id}/email`), { to: 'x@y.test' }); assert.equal(r.body.status, 'drafted'); assert.match(r.body.note, /NOT sent/); } finally { await s2.close(); }
  assert.equal((await A.post(A.b(`/documents/${(await A.post(A.b('/documents'), { type: 'invoice', client_id: (await seed(A)).cl, lines: [] })).body.id}/email`), {})).status, 400, 'drafts cannot be emailed');
});

test('public links: unguessable, expiring, revocable, minimal, and acceptance is verified server-side', async () => {
  const cl = (await A.post(A.b('/clients'), { name: 'Public Co', email: 'p@example.test', billing_address: 'PRIVATE ADDRESS 1' })).body.id;
  const est = (await A.post(A.b('/documents'), { type: 'estimate', client_id: cl, lines: [{ description: 'Pub', qty_milli: 1000, unit_price_cents: 10000 }], internal: 'x' })).body.id;
  assert.equal((await A.post(A.b(`/documents/${est}/public-link`))).status, 400, 'drafts cannot be shared'); await A.post(A.b(`/documents/${est}/issue`));
  const l = (await A.post(A.b(`/documents/${est}/public-link`), {})).body; const token = l.url.split('/p/')[1]; assert.ok(token.length >= 40);
  const anon = new Client(S.base);
  assert.equal((await anon.get('/api/public/' + 'x'.repeat(43))).status, 404); assert.equal((await anon.get('/api/public/short')).status, 404);
  const view = await anon.get('/api/public/' + token); assert.equal(view.status, 200); assert.equal(view.body.can_respond, true); assert.ok(!JSON.stringify(view.body).includes('PRIVATE ADDRESS') && !JSON.stringify(view.body).includes('p@example.test'), 'no client contact data leaks');
  assert.equal((await A.get(A.b(`/documents/${est}`))).body.public_viewed_at !== null, true, 'view is recorded only because it really happened');
  assert.equal((await anon.bytes('/api/public/' + token + '/pdf')).type, 'application/pdf'); assert.equal((await anon.get(`/api/b/${A.bid}/documents/${est}`)).status, 401, 'token grants no API access');
  assert.equal((await anon.post('/api/public/' + token + '/accept', { name: '' })).status, 400);
  assert.equal((await anon.post('/api/public/' + token + '/accept', { name: 'Pat Client' })).status, 200);
  const acc = (await A.get(A.b(`/documents/${est}`))).body; assert.equal(acc.status, 'accepted'); assert.equal(acc.acceptance_method, 'public_link'); assert.equal(acc.accepted_by, 'Pat Client');
  assert.equal((await anon.post('/api/public/' + token + '/accept', { name: 'Again' })).status, 409, 'cannot accept twice');
  await A.del(A.b(`/documents/${est}/public-link`)); assert.equal((await anon.get('/api/public/' + token)).status, 404, 'revoked');
  const l2 = (await A.post(A.b(`/documents/${est}/public-link`), { days: 1 })).body; S.db.prepare("UPDATE documents SET public_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(est); assert.equal((await anon.get('/api/public/' + l2.url.split('/p/')[1])).status, 404, 'expired');
  const manual = (await A.post(A.b('/documents'), { type: 'estimate', client_id: cl, lines: [{ description: 'M', qty_milli: 1000, unit_price_cents: 100 }] })).body.id; await A.post(A.b(`/documents/${manual}/issue`)); await A.post(A.b(`/documents/${manual}/accept`), { by: 'Phone call' });
  assert.equal((await A.get(A.b(`/documents/${manual}`))).body.acceptance_method, 'manual', 'manual acceptance is labelled as such');
});

test('unsafe uploads: content sniffing, size limit, dangerous names and downloads', async () => {
  const cl = (await A.post(A.b('/clients'), { name: 'Up' })).body.id; const e = (await A.post(A.b('/expenses'), { expense_date: '2026-01-01', amount_cents: 100, client_id: cl })).body.id;
  const up = (name: string, buf: Buffer) => A.post(A.b(`/expenses/${e}/attachments`), { filename: name, data_base64: buf.toString('base64') });
  assert.equal((await up('a.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status, 400); assert.equal((await up('a.html', Buffer.from('<html><script>alert(1)</script>'))).status, 400);
  assert.equal((await up('shell.php.png', Buffer.from('<?php system($_GET[0]); ?>'))).status, 400); assert.equal((await up('fake.pdf', Buffer.from('MZ\x90\x00 not a pdf'))).status, 400); assert.equal((await up('empty.png', Buffer.alloc(0))).status, 400);
  assert.equal((await up('big.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(9 * 1024 * 1024)]))).status, 400);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'); const ok = await up('../../etc/pass wd?.pdf', pdf); assert.equal(ok.status, 201);
  const dl = await A.raw('GET', A.b(`/attachments/${ok.body.id}`)); assert.equal(dl.headers.get('content-type'), 'application/pdf'); assert.match(dl.headers.get('content-disposition')!, /^attachment; filename="[\w.\- ]+"$/); assert.equal(dl.headers.get('x-content-type-options'), 'nosniff'); assert.match(dl.headers.get('content-security-policy')!, /sandbox/);
  assert.equal((await B.raw('GET', B.b(`/attachments/${ok.body.id}`))).status, 404);
  assert.equal((await A.post(A.b('/business/logo'), { data_base64: Buffer.from('<svg/>').toString('base64') })).status, 400);
});

test('spreadsheet formula injection is neutralised in CSV exports', async () => {
  await A.post(A.b('/clients'), { name: '=HYPERLINK("http://evil","x")', email: 'f@example.test' });
  const csv = (await A.bytes(A.b('/clients/export.csv'))).buf.toString('utf8'); assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), csv);
});

test('security headers and error hygiene', async () => {
  const r = await fetch(S.base + '/api/health'); assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/); assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN'); assert.equal(r.headers.get('x-powered-by'), null);
    const j = await fetch(S.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lf-request': '1' }, body: '{bad json' }); assert.equal(j.status, 400);
  const sqli = await A.get(A.b("/clients?search=' OR 1=1 --")); assert.equal(sqli.status, 200); assert.equal(sqli.body.length, 0);
  const sqli2 = await A.get(A.b("/invoices?search=%27%3B%20DROP%20TABLE%20documents%3B--")); assert.equal(sqli2.status, 200); assert.ok(Number(get(S.db, 'SELECT COUNT(*) n FROM documents')!.n) > 0);
});

test('login throttling', async () => {
  const c = new Client(S.base); let last = 0; for (let i = 0; i < 10; i++) last = (await c.post('/api/auth/login', { email: 'a@example.test', password: 'nope-nope-nope' + i })).status; assert.equal(last, 429);
  assert.equal((await new Client(S.base).post('/api/auth/login', { email: 'a@example.test', password: 'correct horse battery' })).status, 429, 'correct password is also throttled during lockout window');
});
void pdfText;
