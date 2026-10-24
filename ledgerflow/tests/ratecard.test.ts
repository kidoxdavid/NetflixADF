import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, setupBusiness, Client, pdfText, money } from './helpers.ts';

let S: Awaited<ReturnType<typeof startServer>>; let c: Client;
before(async () => { S = await startServer(); c = await setupBusiness(S.base); });
after(async () => { await S.close(); });

const mk = async (b: any) => { const r = await c.post(c.b('/ratecard/items'), b); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id as number; };

test('create, edit and archive a service; price changes are versioned', async () => {
  const cat = (await c.post(c.b('/ratecard/categories'), { name: 'Video' })).body.id;
  const id = await mk({ name: 'Short-form video edit', category_id: cat, unit: 'video', pricing_type: 'fixed', rate_cents: money(150), short_desc: '30–60s edit', revisions: 2, public_visible: 1, cost_cents: 4000, internal_notes: 'margin note SECRET-INTERNAL' });
  let it = (await c.get(c.b(`/ratecard/items/${id}`))).body;
  assert.equal(it.version, 1); assert.equal(it.rate_cents, 15000); assert.equal(it.history.length, 1);
  await c.put(c.b(`/ratecard/items/${id}`), { rate_cents: money(175), change_note: '2026 increase' });
  it = (await c.get(c.b(`/ratecard/items/${id}`))).body;
  assert.equal(it.version, 2); assert.equal(it.rate_cents, 17500); assert.equal(it.history.length, 2); assert.equal(it.history[0].rate_cents, 17500); assert.equal(it.history[1].rate_cents, 15000);
  await c.put(c.b(`/ratecard/items/${id}`), { short_desc: 'edited description only' }); // non-price edit: no new version
  assert.equal((await c.get(c.b(`/ratecard/items/${id}`))).body.version, 2);
  await c.post(c.b(`/ratecard/items/${id}/status`), { status: 'archived' });
  assert.equal((await c.get(c.b('/ratecard/items'))).body.some((i: any) => i.id === id), false, 'archived hidden by default');
  assert.equal((await c.get(c.b('/ratecard/items?status=archived'))).body.some((i: any) => i.id === id), true);
});

test('validation: fixed price needs a rate; negative / non-integer rejected; custom quote may have none', async () => {
  assert.equal((await c.post(c.b('/ratecard/items'), { name: 'X', unit: 'hour', pricing_type: 'fixed' })).status, 400);
  assert.equal((await c.post(c.b('/ratecard/items'), { name: 'X', unit: 'hour', pricing_type: 'fixed', rate_cents: -5 })).status, 400);
  assert.equal((await c.post(c.b('/ratecard/items'), { name: 'X', unit: 'hour', pricing_type: 'fixed', rate_cents: 10.5 })).status, 400);
  assert.equal((await c.post(c.b('/ratecard/items'), { name: '', unit: 'hour', rate_cents: 1 })).status, 400);
  assert.equal((await c.post(c.b('/ratecard/items'), { name: 'Event design', unit: 'event', pricing_type: 'custom_quote' })).status, 201);
});

test('duplicate a service; SKU uniqueness', async () => {
  const id = await mk({ name: 'Photo session', unit: 'session', rate_cents: 40000, sku: 'PH-1' });
  const d = await c.post(c.b(`/ratecard/items/${id}/duplicate`)); assert.equal(d.status, 201);
  const copy = (await c.get(c.b(`/ratecard/items/${d.body.id}`))).body; assert.equal(copy.name, 'Photo session (copy)'); assert.equal(copy.status, 'inactive'); assert.equal(copy.sku, null);
  assert.equal((await c.post(c.b('/ratecard/items'), { name: 'Other', unit: 'x', rate_cents: 1, sku: 'PH-1' })).status, 409);
});

test('packages: fixed vs itemized, add-ons, nested packages rejected', async () => {
  const video = await mk({ name: 'Edit — reel', unit: 'reel', rate_cents: 9000 }); const post = await mk({ name: 'Social post', unit: 'post', rate_cents: 3500 }); const mgmt = await mk({ name: 'Monthly management', unit: 'month', rate_cents: 60000 });
  const addon = await mk({ name: 'Rush delivery', kind: 'addon', unit: 'project', rate_cents: 15000 });
  const pkg = await mk({ name: 'Growth package', kind: 'package', unit: 'package', pricing_type: 'fixed', pkg_price_mode: 'fixed', rate_cents: 120000, pkg_display: 'combined', pkg_valid_days: 30, pkg_billing_frequency: 'monthly', addon_ids: [addon], components: [{ item_id: video, qty_milli: 4000 }, { item_id: post, qty_milli: 12000 }, { item_id: mgmt, qty_milli: 1000 }] });
  const p = (await c.get(c.b(`/ratecard/items/${pkg}`))).body;
  assert.equal(p.components.length, 3); assert.equal(p.itemized_total_cents, 4 * 9000 + 12 * 3500 + 60000); assert.equal(p.addons[0].name, 'Rush delivery');
  assert.equal((await c.post(c.b('/ratecard/items'), { name: 'Nested', kind: 'package', unit: 'package', pkg_price_mode: 'fixed', rate_cents: 1, components: [{ item_id: pkg }] })).status, 400);
  assert.equal((await c.post(c.b('/ratecard/items'), { name: 'Empty', kind: 'package', unit: 'package', pkg_price_mode: 'fixed', rate_cents: 1 })).status, 400);
  const line = (await c.get(c.b(`/ratecard/line/${pkg}`))).body;
  assert.equal(line.unit_price_cents, 120000); assert.equal(line.children.length, 3); assert.ok(line.children.every((k: any) => k.is_component === 1 && k.unit_price_cents === 0));
  const itemized = await mk({ name: 'Itemized bundle', kind: 'package', unit: 'package', pricing_type: 'fixed', pkg_price_mode: 'itemized', components: [{ item_id: video, qty_milli: 2000 }, { item_id: post, qty_milli: 4000 }] });
  const l2 = (await c.get(c.b(`/ratecard/line/${itemized}`))).body; assert.equal(l2.group_only, 1); assert.deepEqual(l2.children.map((k: any) => k.unit_price_cents), [9000, 3500]);
});

test('pricing types: custom quote / on request / starting-from require explicit confirmation', async () => {
  const cq = await mk({ name: 'Wedding film', unit: 'event', pricing_type: 'custom_quote' });
  const sf = await mk({ name: 'Brand strategy', unit: 'project', pricing_type: 'starting_from', rate_cents: 250000 });
  const l1 = (await c.get(c.b(`/ratecard/line/${cq}`))).body; assert.equal(l1.needs_confirmation, 1); assert.equal(l1.price_confirmed, 0); assert.equal(l1.unit_price_cents, 0);
  const l2 = (await c.get(c.b(`/ratecard/line/${sf}`))).body; assert.equal(l2.needs_confirmation, 1); assert.equal(l2.unit_price_cents, 250000);
});

test('CSV import: mapping, warnings, ambiguity, duplicates, confirmation count, results retained', async () => {
  await mk({ name: 'Logo design', unit: 'project', rate_cents: 80000 });
  const csv = ['Service,Category,Price,Unit,Description', 'Logo design,Branding,$800.00,project,existing duplicate', 'Brand guide,Branding,"$1,200.00",project,PDF guide', 'Voiceover,Audio,$150/hr,,per hour', 'Podcast edit,Audio,500-900,episode,range!', 'Keynote design,Design,Custom quote,,', 'Mystery item,Design,,,', 'Rounding,Design,10.555,item,x', ',Design,50,item,no name'].join('\n');
  const pv = await c.post(c.b('/ratecard/import/preview'), { filename: 'rates.csv', data_base64: Buffer.from(csv).toString('base64') });
  assert.equal(pv.status, 200, JSON.stringify(pv.body)); assert.deepEqual(pv.body.headers.slice(0, 3), ['Service', 'Category', 'Price']); assert.equal(pv.body.mapping.name, 0); assert.equal(pv.body.mapping.rate, 2);
  const rows = pv.body.rows; const byName = (n: string) => rows.find((r: any) => r.item.name === n);
  assert.equal(byName('Logo design').duplicate_of.rate_cents, 80000); assert.equal(byName('Logo design').action, 'skip');
  assert.equal(byName('Brand guide').item.rate_cents, 120000); assert.equal(byName('Brand guide').action, 'create');
  assert.equal(byName('Voiceover').item.rate_cents, 15000); assert.equal(byName('Voiceover').item.unit, 'hour'); assert.ok(byName('Voiceover').issues.some((i: any) => /confirm/.test(i.msg)));
  assert.ok(byName('Podcast edit').issues.some((i: any) => i.level === 'error' && /ambiguous/.test(i.msg)));
  assert.equal(byName('Keynote design').item.pricing_type, 'custom_quote'); assert.equal(byName('Mystery item').item.pricing_type, 'on_request');
  assert.ok(byName('Rounding').issues.some((i: any) => i.level === 'error' && /decimal/.test(i.msg)), 'no silent rounding');
  assert.ok(rows.some((r: any) => r.issues.some((i: any) => /Missing service name/.test(i.msg))));
  const sel = rows.filter((r: any) => ['Brand guide', 'Voiceover', 'Keynote design', 'Mystery item', 'Podcast edit'].includes(r.item.name)).map((r: any) => ({ row_no: r.row_no, item: r.item, action: 'create' }));
  const wrong = await c.post(c.b('/ratecard/import/commit'), { rows: sel, confirm_count: 3 }); assert.equal(wrong.status, 400, 'must confirm the exact count');
  const ok = await c.post(c.b('/ratecard/import/commit'), { rows: sel, confirm_count: 5, source_base64: Buffer.from(csv).toString('base64'), source_filename: 'rates.csv' });
  assert.deepEqual(ok.body.summary, { created: 4, updated: 0, skipped: 0, errors: 1 }); // the ambiguous range row fails server validation (no rate)
  assert.ok(ok.body.results.find((r: any) => r.name === 'Podcast edit' && r.status === 'error'));
  assert.ok(ok.body.attachment_id); const dl = await c.bytes(c.b(`/attachments/${ok.body.attachment_id}`)); assert.equal(dl.status, 200); assert.equal(dl.buf.toString(), csv);
  const items = (await c.get(c.b('/ratecard/items'))).body; assert.ok(items.find((i: any) => i.name === 'Voiceover' && i.category_name === 'Audio'));
  // update path: re-importing a duplicate with action=update changes the rate and records history
  const logo = items.find((i: any) => i.name === 'Logo design');
  const up = await c.post(c.b('/ratecard/import/commit'), { rows: [{ row_no: 2, item: { ...byName('Logo design').item, rate_cents: 90000 }, action: 'update', update_id: logo.id }], confirm_count: 1 });
  assert.equal(up.body.summary.updated, 1); assert.equal((await c.get(c.b(`/ratecard/items/${logo.id}`))).body.history[0].rate_cents, 90000);
});

test('text/paste extraction flags every row for review; xlsx/images give actionable errors', async () => {
  const text = 'Video Services\nReel edit ........ $120\nLong-form edit  from $450\nPhotography\nHeadshot session   $200 per session\nThis line has no price';
  const pv = await c.post(c.b('/ratecard/import/preview'), { text, mode: 'text' }); assert.equal(pv.status, 200);
  assert.equal(pv.body.rows.length, 3); assert.ok(pv.body.rows.every((r: any) => r.needs_review)); assert.equal(pv.body.rows.find((r: any) => r.item.name.startsWith('Long')).item.pricing_type, 'starting_from');
  assert.equal(pv.body.rows.find((r: any) => /Headshot/.test(r.item.name)).item.unit, 'session');
  const x = await c.post(c.b('/ratecard/import/preview'), { filename: 'a.xlsx', data_base64: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]).toString('base64') }); assert.equal(x.status, 400); assert.match(x.body.error, /CSV/);
});

test('versions: snapshot and compare old vs new rates', async () => {
  const id = await mk({ name: 'Compare me', unit: 'hour', rate_cents: 10000 });
  const v1 = (await c.post(c.b('/ratecard/versions'), { label: '2026' })).body.id;
  await c.put(c.b(`/ratecard/items/${id}`), { rate_cents: 12000 });
  const added = await mk({ name: 'Brand new', unit: 'hour', rate_cents: 1000 });
  const diff = (await c.get(c.b(`/ratecard/compare?a=${v1}&b=current`))).body;
  const ch = diff.changed.find((x: any) => x.id === id); assert.equal(ch.before.rate_cents, 10000); assert.equal(ch.after.rate_cents, 12000); assert.equal(ch.change_pct, 20);
  assert.ok(diff.added.some((x: any) => x.id === added));
});

test('bulk adjust applies a percentage and logs history', async () => {
  const id = await mk({ name: 'Bulk target', unit: 'hour', rate_cents: 10000 });
  const r = await c.post(c.b('/ratecard/bulk-adjust'), { ids: [id], milli_pct: 5000, note: 'annual' }); assert.equal(r.body.updated, 1);
  assert.equal((await c.get(c.b(`/ratecard/items/${id}`))).body.rate_cents, 10500);
});

test('export CSV and public PDF: real PDF, hides internal notes, cost and unpublished items', async () => {
  const id = await mk({ name: 'Hidden service', unit: 'hour', rate_cents: 99900, public_visible: 0 });
  await mk({ name: 'No-price-shown service', unit: 'hour', rate_cents: 77700, show_price: 0 });
  const csv = await c.bytes(c.b('/ratecard/export.csv')); assert.equal(csv.status, 200); const t = csv.buf.toString('utf8'); assert.match(t, /Short-form video edit/); assert.match(t, /sku,category,kind,name/); assert.ok(!/SECRET-INTERNAL/.test(t));
  const pdf = await c.bytes(c.b('/ratecard/pdf')); assert.equal(pdf.status, 200); assert.equal(pdf.type, 'application/pdf'); assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  const txt = pdfText(pdf.buf);
  assert.match(txt, /Rate Card/); assert.match(txt, /Growth package/); assert.match(txt, /\$1,200\.00/); assert.match(txt, /Package contains: 4 × Edit/);
  assert.ok(!/SECRET-INTERNAL/.test(txt) && !/Hidden service/.test(txt) && !/999\.00/.test(txt) && !/777\.00/.test(txt) && !/40\.00/.test(txt), 'no internal/cost/unpublished data in the public PDF');
  assert.match(txt, /Contact us/); assert.match(txt, /Custom quotation/); assert.match(txt, /From \$2,500\.00/);
  void id;
});
