import { PCT_SCALE, lineAmount, pctOf, roundDiv, multiply } from './money.ts';

export interface TaxRef { id?: number | null; name: string; rate_milli: number }
export interface CalcLineIn {
  qty_milli: number;
  unit_price_cents: number;
  discount_type?: 'none' | 'percent' | 'fixed' | null;
  discount_value?: number | null; // percent: milli-percent; fixed: cents
  taxes?: TaxRef[];
  tax_exempt?: boolean;
  is_component?: boolean; // informational only, never priced
}
export interface CalcDocIn {
  lines: CalcLineIn[];
  prices_include_tax?: boolean;
  discount_type?: 'none' | 'percent' | 'fixed' | null;
  discount_value?: number | null;
  tax_exempt?: boolean;
}
export interface CalcLineOut {
  amount_cents: number;        // qty * price
  line_discount_cents: number;
  net_cents: number;           // amount - line discount (entered basis: tax-inclusive when prices_include_tax)
  doc_discount_cents: number;  // allocated share of document discount
  taxable_cents: number;       // base for tax (tax-exclusive)
  tax_cents: number;
  total_cents: number;         // what the customer pays for this line
}
export interface TaxSummaryRow { name: string; rate_milli: number; base_cents: number; tax_cents: number }
export interface CalcDocOut {
  lines: CalcLineOut[];
  subtotal_cents: number;      // sum of line nets, before document discount (entered basis)
  discount_cents: number;      // document-level discount
  tax_total_cents: number;
  total_cents: number;
  tax_summary: TaxSummaryRow[];
  prices_include_tax: boolean;
}

/** Split `total` across weights using largest remainder so parts always sum exactly to `total`. */
export function allocate(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sumW <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (BigInt(total) * BigInt(w)));
  const S = BigInt(sumW);
  const base = raw.map((r) => Number(r / S));
  let rem = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: Number(r % S) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rem > 0 && k < order.length; k++, rem--) base[order[k].i] += 1;
  return base;
}

export function calcDocument(doc: CalcDocIn): CalcDocOut {
  const inclusive = !!doc.prices_include_tax;
  const priced = doc.lines.map((l) => (l.is_component ? null : l));
  const out: CalcLineOut[] = doc.lines.map(() => ({ amount_cents: 0, line_discount_cents: 0, net_cents: 0, doc_discount_cents: 0, taxable_cents: 0, tax_cents: 0, total_cents: 0 }));

  priced.forEach((l, i) => {
    if (!l) return;
    if (!Number.isSafeInteger(l.qty_milli) || !Number.isSafeInteger(l.unit_price_cents)) throw new Error('Line values must be integers');
    const amount = lineAmount(l.qty_milli, l.unit_price_cents);
    let disc = 0;
    if (l.discount_type === 'percent') disc = pctOf(amount, l.discount_value ?? 0);
    else if (l.discount_type === 'fixed') disc = Math.min(Math.max(l.discount_value ?? 0, 0), Math.max(amount, 0));
    if (disc < 0) disc = 0;
    out[i].amount_cents = amount;
    out[i].line_discount_cents = disc;
    out[i].net_cents = amount - disc;
  });

  const subtotal = out.reduce((a, l) => a + l.net_cents, 0);
  let docDisc = 0;
  if (doc.discount_type === 'percent') docDisc = pctOf(subtotal, doc.discount_value ?? 0);
  else if (doc.discount_type === 'fixed') docDisc = Math.min(Math.max(doc.discount_value ?? 0, 0), Math.max(subtotal, 0));
  if (docDisc < 0) docDisc = 0;
  const shares = allocate(docDisc, out.map((l) => Math.max(l.net_cents, 0)));
  out.forEach((l, i) => { l.doc_discount_cents = shares[i]; });

  // tax
  const exclBase = new Map<string, { name: string; rate_milli: number; base: number }>();
  const inclAcc = new Map<string, { name: string; rate_milli: number; base: number; tax: number }>();
  const key = (t: TaxRef) => `${t.name}|${t.rate_milli}`;

  priced.forEach((l, i) => {
    if (!l) return;
    const o = out[i];
    const after = o.net_cents - o.doc_discount_cents;
    const taxes = (l.tax_exempt || doc.tax_exempt) ? [] : (l.taxes ?? []);
    if (!taxes.length) { o.taxable_cents = after; o.total_cents = after; return; }
    if (!inclusive) {
      o.taxable_cents = after; o.total_cents = after; // tax added below at code level
      for (const t of taxes) {
        const k = key(t); const e = exclBase.get(k) ?? { name: t.name, rate_milli: t.rate_milli, base: 0 };
        e.base += after; exclBase.set(k, e);
      }
    } else {
      const R = taxes.reduce((a, t) => a + t.rate_milli, 0);
      const net = roundDiv(multiply(after, PCT_SCALE), PCT_SCALE + R);
      const taxTotal = after - net;
      const parts = allocate(taxTotal, taxes.map((t) => t.rate_milli));
      o.taxable_cents = net; o.tax_cents = taxTotal; o.total_cents = after;
      taxes.forEach((t, j) => {
        const k = key(t); const e = inclAcc.get(k) ?? { name: t.name, rate_milli: t.rate_milli, base: 0, tax: 0 };
        e.base += net; e.tax += parts[j]; inclAcc.set(k, e);
      });
    }
  });

  const summary: TaxSummaryRow[] = [];
  for (const e of exclBase.values()) summary.push({ name: e.name, rate_milli: e.rate_milli, base_cents: e.base, tax_cents: pctOf(e.base, e.rate_milli) });
  for (const e of inclAcc.values()) summary.push({ name: e.name, rate_milli: e.rate_milli, base_cents: e.base, tax_cents: e.tax });
  summary.sort((a, b) => a.name.localeCompare(b.name) || a.rate_milli - b.rate_milli);
  const taxTotal = summary.reduce((a, r) => a + r.tax_cents, 0);

  // distribute exclusive tax back to lines for per-line reporting (informational)
  if (!inclusive) {
    priced.forEach((l, i) => {
      if (!l) return; const o = out[i];
      const taxes = (l.tax_exempt || doc.tax_exempt) ? [] : (l.taxes ?? []);
      o.tax_cents = taxes.reduce((a, t) => a + pctOf(o.taxable_cents, t.rate_milli), 0);
      o.total_cents = o.taxable_cents + o.tax_cents;
    });
  }
  const afterDisc = subtotal - docDisc;
  const total = inclusive ? afterDisc : afterDisc + taxTotal;
  return { lines: out, subtotal_cents: subtotal, discount_cents: docDisc, tax_total_cents: taxTotal, total_cents: total, tax_summary: summary, prices_include_tax: inclusive };
}
