/**
 * Money primitives. All authoritative amounts are integer minor units (cents).
 * Quantities are integer thousandths (qty_milli). Percentages are integer
 * thousandths of a percent ("milli-percent": 5% = 5000, 9.975% = 9975).
 * Rounding rule everywhere: half away from zero, computed with BigInt.
 */
export const PCT_SCALE = 100000; // 100% in milli-percent

export function roundDiv(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d === 0) throw new Error('roundDiv: invalid integer input');
  const N = BigInt(n), D = BigInt(d);
  const neg = (N < 0n) !== (D < 0n);
  const aN = N < 0n ? -N : N, aD = D < 0n ? -D : D;
  let q = aN / aD;
  if ((aN % aD) * 2n >= aD) q += 1n;
  const r = Number(neg ? -q : q);
  return r === 0 ? 0 : r; // avoid -0
}

/** amount = qty_milli * unit_cents / 1000 */
export function lineAmount(qtyMilli: number, unitCents: number): number {
  return roundDiv(multiply(qtyMilli, unitCents), 1000);
}
export function multiply(a: number, b: number): number {
  const r = BigInt(a) * BigInt(b);
  if (r > BigInt(Number.MAX_SAFE_INTEGER) || r < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount too large');
  return Number(r);
}
/** percent (milli-percent) of an amount */
export function pctOf(amount: number, milliPct: number): number {
  return roundDiv(multiply(amount, milliPct), PCT_SCALE);
}

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

/** Parse a decimal string like "1,234.56", "$99", "(12.00)" into integer minor units. Never rounds silently. */
export function parseMoney(input: string | number | null | undefined, decimals = 2): ParseResult {
  if (input === null || input === undefined) return { ok: false, error: 'empty' };
  let s = String(input).trim();
  if (!s) return { ok: false, error: 'empty' };
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/^[A-Za-z]{3}\s*/, '').replace(/[\s$€£]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); // 12,50 style
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: `not a number: "${input}"` };
  const [i, f = ''] = s.split('.');
  if (f.length > decimals && /[1-9]/.test(f.slice(decimals))) return { ok: false, error: `more than ${decimals} decimal places: "${input}"` };
  const cents = Number(i + f.slice(0, decimals).padEnd(decimals, '0'));
  if (!Number.isSafeInteger(cents)) return { ok: false, error: 'too large' };
  return { ok: true, value: neg ? -cents : cents };
}

/** Parse quantity string to milli-units (max 3 decimals). */
export function parseQty(input: string | number | null | undefined): ParseResult {
  const r = parseMoney(input, 3);
  return r;
}

export function formatMoney(cents: number, currency = 'CAD', locale = 'en-CA'): string {
  const neg = cents < 0; const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100), frac = String(abs % 100).padStart(2, '0');
  let s: string;
  try {
    const w = new Intl.NumberFormat(locale).format(whole);
    const dec = new Intl.NumberFormat(locale).format(1.1).charAt(1);
    s = `${w}${dec}${frac}`;
  } catch { s = `${whole}.${frac}`; }
  const sym: Record<string, string> = { CAD: '$', USD: '$', AUD: '$', NZD: '$', EUR: '€', GBP: '£' };
  const code = currency !== 'CAD' ? ` ${currency}` : '';
  return `${neg ? '-' : ''}${sym[currency] ?? currency + ' '}${s}${sym[currency] ? code : ''}`.trim();
}
export function formatQty(milli: number): string {
  const s = (milli / 1000).toFixed(3).replace(/\.?0+$/, '');
  return s;
}
export function formatPct(milli: number): string {
  return (milli / 1000).toFixed(3).replace(/\.?0+$/, '') + '%';
}
export const toISODate = (d: Date) => d.toISOString().slice(0, 10);
