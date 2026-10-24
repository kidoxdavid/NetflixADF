import test from 'node:test';
import assert from 'node:assert/strict';
import { roundDiv, lineAmount, parseMoney, parseQty, pctOf, formatMoney } from '../server/src/money.ts';
import { calcDocument, allocate } from '../server/src/calc.ts';

const GST = { name: 'GST', rate_milli: 5000 }, QST = { name: 'QST', rate_milli: 9975 }, HST = { name: 'HST', rate_milli: 13000 }, PST = { name: 'PST (BC)', rate_milli: 7000 };

test('roundDiv rounds half away from zero, exactly', () => {
  assert.equal(roundDiv(5, 2), 3); assert.equal(roundDiv(-5, 2), -3); assert.equal(roundDiv(4, 3), 1); assert.equal(roundDiv(1, 3), 0); assert.equal(roundDiv(-1, 3), 0); assert.equal(roundDiv(0, 7), 0);
  assert.ok(!Object.is(roundDiv(-1, 3), -0));
});
test('line amount: quantity × unit price with 3-decimal quantities', () => {
  assert.equal(lineAmount(1000, 12345), 12345);          // 1 × 123.45
  assert.equal(lineAmount(1500, 8000), 12000);           // 1.5 h × $80
  assert.equal(lineAmount(2250, 3333), 7499);            // 2.25 × 33.33 = 74.9925 → 74.99
  assert.equal(lineAmount(333, 100), 33);                // 0.333 × $1.00 = 0.333 → 0.33
  assert.equal(lineAmount(100, 5), 1);                   // 0.1 × 0.05 = 0.005 → 0.01 (half away from zero)
});
test('parseMoney is strict: never rounds silently', () => {
  assert.deepEqual(parseMoney('$1,234.56'), { ok: true, value: 123456 });
  assert.deepEqual(parseMoney('99'), { ok: true, value: 9900 });
  assert.deepEqual(parseMoney('(12.50)'), { ok: true, value: -1250 });
  assert.deepEqual(parseMoney('12,50'), { ok: true, value: 1250 });
  assert.deepEqual(parseMoney('10.500'), { ok: true, value: 1050 });
  assert.equal(parseMoney('10.555').ok, false);
  assert.equal(parseMoney('abc').ok, false); assert.equal(parseMoney('').ok, false); assert.equal(parseMoney('1.2.3').ok, false);
  assert.deepEqual(parseQty('1.5'), { ok: true, value: 1500 }); assert.equal(parseQty('1.2345').ok, false);
});
test('float trap: 0.1 + 0.2 style sums stay exact in cents', () => {
  const r = calcDocument({ lines: [{ qty_milli: 3000, unit_price_cents: 10 }, { qty_milli: 1000, unit_price_cents: 20 }] });
  assert.equal(r.total_cents, 50);
});
test('hourly and daily rates', () => {
  const r = calcDocument({ lines: [{ qty_milli: 7500, unit_price_cents: 9500 }, { qty_milli: 2000, unit_price_cents: 85000 }] });
  assert.equal(r.lines[0].amount_cents, 71250); assert.equal(r.lines[1].amount_cents, 170000); assert.equal(r.total_cents, 241250);
});
test('tax exclusive: GST 5% and HST 13%', () => {
  const g = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 100000, taxes: [GST] }] });
  assert.equal(g.tax_total_cents, 5000); assert.equal(g.total_cents, 105000);
  const h = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 33333, taxes: [HST] }] });
  assert.equal(h.tax_total_cents, 4333); assert.equal(h.total_cents, 37666); // 4333.29 → 4333
});
test('multiple taxes: GST + QST (not compounded) and GST + PST', () => {
  const r = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 100000, taxes: [GST, QST] }] });
  assert.equal(r.tax_summary.find((t) => t.name === 'GST')!.tax_cents, 5000);
  assert.equal(r.tax_summary.find((t) => t.name === 'QST')!.tax_cents, 9975);
  assert.equal(r.total_cents, 114975);
  const p = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 20000, taxes: [GST, PST] }] });
  assert.equal(p.total_cents, 20000 + 1000 + 1400);
});
test('tax rounds once per tax per document, not per line', () => {
  const lines = Array.from({ length: 10 }, () => ({ qty_milli: 1000, unit_price_cents: 333, taxes: [GST] }));
  const r = calcDocument({ lines });
  assert.equal(r.tax_total_cents, 167); // 3330 × 5% = 166.5 → 167 (per-line rounding would give 170)
});
test('tax-exempt lines and exempt documents', () => {
  const r = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 10000, taxes: [GST] }, { qty_milli: 1000, unit_price_cents: 10000, taxes: [GST], tax_exempt: true }] });
  assert.equal(r.tax_total_cents, 500); assert.equal(r.total_cents, 20500);
  const e = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 10000, taxes: [GST] }], tax_exempt: true });
  assert.equal(e.tax_total_cents, 0); assert.equal(e.total_cents, 10000);
});
test('tax-inclusive pricing extracts tax and total equals the entered price', () => {
  const r = calcDocument({ prices_include_tax: true, lines: [{ qty_milli: 1000, unit_price_cents: 11300, taxes: [HST] }] });
  assert.equal(r.total_cents, 11300); assert.equal(r.tax_total_cents, 1300); assert.equal(r.tax_summary[0].base_cents, 10000);
  const m = calcDocument({ prices_include_tax: true, lines: [{ qty_milli: 1000, unit_price_cents: 11498, taxes: [GST, QST] }] });
  assert.equal(m.total_cents, 11498); assert.equal(m.tax_total_cents, 11498 - 10000); assert.equal(m.tax_summary.reduce((a, t) => a + t.tax_cents, 0), 1498);
});
test('line discounts (percent / fixed) and document discounts allocate exactly', () => {
  const r = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 10000, discount_type: 'percent', discount_value: 10000, taxes: [GST] }, { qty_milli: 1000, unit_price_cents: 5000, taxes: [GST] }] });
  assert.equal(r.lines[0].line_discount_cents, 1000); assert.equal(r.subtotal_cents, 14000); assert.equal(r.tax_total_cents, 700); assert.equal(r.total_cents, 14700);
  const f = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 10000, discount_type: 'fixed', discount_value: 99999999 }] });
  assert.equal(f.total_cents, 0, 'fixed discount is capped at the line amount');
  const d = calcDocument({ discount_type: 'fixed', discount_value: 1001, lines: [{ qty_milli: 1000, unit_price_cents: 3333, taxes: [GST] }, { qty_milli: 1000, unit_price_cents: 3333, taxes: [] }, { qty_milli: 1000, unit_price_cents: 3334, taxes: [GST] }] });
  assert.equal(d.discount_cents, 1001); assert.equal(d.lines.reduce((a, l) => a + l.doc_discount_cents, 0), 1001);
  assert.equal(d.total_cents, d.subtotal_cents - 1001 + d.tax_total_cents);
  const p = calcDocument({ discount_type: 'percent', discount_value: 15000, lines: [{ qty_milli: 1000, unit_price_cents: 20000, taxes: [GST] }] });
  assert.equal(p.discount_cents, 3000); assert.equal(p.tax_total_cents, 850); assert.equal(p.total_cents, 17850);
});
test('package components are informational and never double count', () => {
  const r = calcDocument({ lines: [{ qty_milli: 1000, unit_price_cents: 150000, taxes: [GST] }, { qty_milli: 3000, unit_price_cents: 50000, is_component: true, taxes: [GST] }, { qty_milli: 12000, unit_price_cents: 9000, is_component: true }] });
  assert.equal(r.total_cents, 157500);
});
test('allocate keeps the exact total', () => {
  for (const [t, w] of [[100, [1, 1, 1]], [1, [5, 5, 5]], [0, [1, 2]], [7, [0, 0, 3]], [999, [333, 333, 333]], [10, [3, 3, 4]]] as [number, number[]][]) {
    const a = allocate(t, w); assert.equal(a.reduce((x, y) => x + y, 0), w.every((x) => x === 0) ? 0 : t);
  }
});
test('negative/zero edge values and huge quantities do not corrupt', () => {
  assert.equal(calcDocument({ lines: [] }).total_cents, 0);
  assert.throws(() => calcDocument({ lines: [{ qty_milli: 1.5, unit_price_cents: 100 }] }));
  assert.equal(pctOf(10000, 1), 0);  // 0.001% of $100 = $0.001 → 0
  assert.equal(formatMoney(123456, 'CAD'), '$1,234.56'); assert.equal(formatMoney(-5, 'CAD'), '-$0.05');
});
