import PDFDocument from 'pdfkit';
import { all, get } from './db.ts';
import type { Row } from './db.ts';
import { type Ctx, getSettings, bizToday, notFound, addDays } from './core.ts';
import { formatMoney, formatQty, formatPct } from './money.ts';
import { hydrate, balanceOf, displayStatus } from './documents.ts';
import { listItems, getItem } from './ratecard.ts';
import { getPayment } from './payments.ts';
import type { Report } from './reports.ts';

type Tpl = 'minimal' | 'editorial' | 'creative' | 'formal';
interface Style { body: string; bold: string; head: string; headBold: string; accent: string; ink: string; muted: string; rule: string; zebra: boolean; boxed: boolean; banner: boolean; titleSize: number; center: boolean }
function styleFor(t: Tpl, accent: string): Style {
  const base = { accent, ink: '#1c1c1c', muted: '#6b6b6b', rule: '#d8d8d8' };
  switch (t) {
    case 'editorial': return { ...base, body: 'Helvetica', bold: 'Helvetica-Bold', head: 'Times-Roman', headBold: 'Times-Bold', zebra: false, boxed: false, banner: false, titleSize: 34, center: false };
    case 'creative': return { ...base, body: 'Helvetica', bold: 'Helvetica-Bold', head: 'Helvetica-Bold', headBold: 'Helvetica-Bold', zebra: true, boxed: false, banner: true, titleSize: 26, center: false };
    case 'formal': return { ...base, rule: '#888888', body: 'Times-Roman', bold: 'Times-Bold', head: 'Times-Bold', headBold: 'Times-Bold', zebra: false, boxed: true, banner: false, titleSize: 22, center: true };
    default: return { ...base, body: 'Helvetica', bold: 'Helvetica-Bold', head: 'Helvetica', headBold: 'Helvetica-Bold', zebra: false, boxed: false, banner: false, titleSize: 22, center: false };
  }
}
const CP1252_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
/** Standard PDF fonts only cover Latin-1/WinAnsi; replace anything else so the output is never garbled. */
export function clean(s: unknown): string {
  if (s === null || s === undefined) return '';
  let out = '';
  for (const ch of String(s).replace(/\r\n?/g, '\n')) { const cp = ch.codePointAt(0)!; out += cp <= 0xff || CP1252_EXTRA.has(cp) || ch === '\n' ? ch : (cp === 0x2192 ? '->' : cp === 0x2212 ? '-' : '?'); }
  return out;
}

const PAGE = { w: 612, h: 792, m: 48 };
class Doc {
  pdf: InstanceType<typeof PDFDocument>; y = PAGE.m; st: Style; footerText = ''; pageHeader: (() => void) | null = null; accent: string;
  constructor(public tpl: Tpl, accent: string, info: { title: string; author: string }) {
    this.pdf = new PDFDocument({ size: 'LETTER', margins: { top: PAGE.m, bottom: PAGE.m + 14, left: PAGE.m, right: PAGE.m }, bufferPages: true, info: { Title: clean(info.title), Author: clean(info.author), Producer: 'LedgerFlow' } });
    this.accent = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#1f4e5f';
    this.st = styleFor(tpl, this.accent);
  }
  get left() { return PAGE.m; } get right() { return PAGE.w - PAGE.m; } get width() { return PAGE.w - 2 * PAGE.m; } get bottom() { return PAGE.h - PAGE.m - 14; }
  font(f: string, size: number, color = this.st.ink) { this.pdf.font(f).fontSize(size).fillColor(color); return this.pdf; }
  h(text: string, f: string, size: number, w: number) { this.font(f, size); return this.pdf.heightOfString(clean(text), { width: w }); }
  need(h: number) { if (this.y + h > this.bottom) { this.newPage(); return true; } return false; }
  newPage() { this.pdf.addPage(); this.y = PAGE.m; if (this.pageHeader) this.pageHeader(); }
  text(t: string, x: number, y: number, w: number, o: { f?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center' } = {}) {
    this.font(o.f ?? this.st.body, o.size ?? 9.5, o.color ?? this.st.ink); this.pdf.text(clean(t), x, y, { width: w, align: o.align ?? 'left', lineBreak: true });
  }
  /** Write a block of wrapped text at the current y, splitting across pages by paragraph. */
  para(t: string, o: { f?: string; size?: number; color?: string; gap?: number; x?: number; w?: number } = {}) {
    const x = o.x ?? this.left, w = o.w ?? this.width; const size = o.size ?? 9.5; const f = o.f ?? this.st.body;
    for (const p of clean(t).split(/\n/)) {
      const hh = this.h(p || ' ', f, size, w); this.need(hh + 2);
      this.text(p || ' ', x, this.y, w, { f, size, color: o.color }); this.y += hh + 2;
    }
    this.y += o.gap ?? 4;
  }
  section(title: string) { this.need(40); this.y += 6; this.text(title.toUpperCase(), this.left, this.y, this.width, { f: this.st.bold, size: 8, color: this.st.accent }); this.y += 13; this.pdf.moveTo(this.left, this.y - 2).lineTo(this.right, this.y - 2).strokeColor(this.st.rule).lineWidth(0.5).stroke(); this.y += 3; }
  rule(color?: string, w = 0.5) { this.pdf.moveTo(this.left, this.y).lineTo(this.right, this.y).strokeColor(color ?? this.st.rule).lineWidth(w).stroke(); }
  finish(): Promise<Buffer> {
    const range = this.pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.pdf.switchToPage(range.start + i);
      this.pdf.page.margins.bottom = 0; // allow footer text below the content area without triggering a new page
      this.font(this.st.body, 7.5, this.st.muted);
      this.pdf.text(clean(this.footerText), this.left, PAGE.h - PAGE.m + 2, { width: this.width - 80, align: 'left', lineBreak: false });
      this.pdf.text(`Page ${i + 1} of ${range.count}`, this.right - 80, PAGE.h - PAGE.m + 2, { width: 80, align: 'right', lineBreak: false });
    }
    return new Promise((res, rej) => { const bufs: Buffer[] = []; this.pdf.on('data', (b: Buffer) => bufs.push(b)); this.pdf.on('end', () => res(Buffer.concat(bufs))); this.pdf.on('error', rej); this.pdf.end(); });
  }
}

function logoFor(c: Ctx): Buffer | null {
  const r = get(c.db, 'SELECT logo, logo_mime FROM businesses WHERE id=?', c.bid);
  return r?.logo && ['image/png', 'image/jpeg'].includes(r.logo_mime) ? Buffer.from(r.logo) : null;
}
function bizLines(b: Row): string[] {
  return [b.address, [b.email, b.phone].filter(Boolean).join('  ·  '), b.website, b.registration_info, b.tax_registration_number ? `${b.tax_registration_label || 'Tax no.'}: ${b.tax_registration_number}` : null].filter(Boolean) as string[];
}

/** Draw the letterhead and return after setting d.y. */
function letterhead(d: Doc, c: Ctx, biz: Row, title: string, meta: [string, string][], opts: { stamp?: string | null } = {}) {
  const logo = logoFor(c); const st = d.st;
  const name = biz.trading_name || biz.legal_name;
  if (st.banner) { d.pdf.rect(0, 0, PAGE.w, 108).fill(d.accent); d.pdf.fillColor('#ffffff'); }
  const nameColor = st.banner ? '#ffffff' : st.ink; const subColor = st.banner ? '#e8eef0' : st.muted;
  let x = d.left; const top = st.banner ? 28 : PAGE.m;
  if (logo) { try { d.pdf.image(logo, x, top, { fit: [110, 54] }); x += 0; } catch { /* unreadable logo: skip */ } }
  const nameY = logo ? top + 60 : top;
  d.text(name, d.left, nameY, 300, { f: st.headBold, size: 15, color: nameColor });
  let ly = nameY + 21;
  if (biz.trading_name && biz.trading_name !== biz.legal_name) { d.text(biz.legal_name, d.left, ly, 300, { size: 8, color: subColor }); ly += 11; }
  for (const l of bizLines(biz)) { const hh = d.h(l, st.body, 8, 300); d.text(l, d.left, ly, 300, { size: 8, color: subColor }); ly += hh + 1; }
  // title block on the right
  const rx = d.left + 320, rw = d.width - 320;
  let tsize = st.titleSize > 24 ? 22 : st.titleSize; d.font(st.headBold, tsize); while (tsize > 11 && d.pdf.widthOfString(clean(title.toUpperCase())) > rw) { tsize -= 1; d.font(st.headBold, tsize); }
  d.text(title.toUpperCase(), rx, top, rw, { f: st.headBold, size: tsize, color: st.banner ? '#ffffff' : d.accent, align: 'right' });
  let my = top + (st.titleSize > 24 ? 32 : 28);
  for (const [k, v] of meta) { d.text(k, rx, my, 90, { size: 8, color: subColor, align: 'right' }); d.text(v, rx + 96, my, rw - 96, { f: st.bold, size: 9, color: nameColor, align: 'right' }); my += Math.max(12, d.h(v, st.bold, 9, rw - 96) + 2); }
  d.y = Math.max(ly, my, logo ? top + 60 : 0) + 14;
  if (st.banner) d.y = Math.max(d.y, 124);
  if (opts.stamp) {
    d.pdf.save(); d.pdf.rotate(-18, { origin: [PAGE.w / 2, 360] });
    d.font(st.bold, 78, '#e9e9e9'); d.pdf.opacity(0.55).text(opts.stamp, 60, 330, { width: PAGE.w - 120, align: 'center', lineBreak: false }); d.pdf.restore(); d.pdf.opacity(1);
  }
}

function partyBlock(d: Doc, left: { label: string; lines: string[] }, right?: { label: string; lines: string[] }) {
  const w = right ? d.width / 2 - 10 : d.width; const startY = d.y;
  const draw = (blk: { label: string; lines: string[] }, x: number) => {
    d.text(blk.label.toUpperCase(), x, startY, w, { f: d.st.bold, size: 7.5, color: d.st.accent }); let y = startY + 12;
    blk.lines.filter(Boolean).forEach((l, i) => { const hh = d.h(l, i === 0 ? d.st.bold : d.st.body, 9.5, w); d.text(l, x, y, w, { f: i === 0 ? d.st.bold : d.st.body, size: 9.5 }); y += hh + 1.5; });
    return y;
  };
  const y1 = draw(left, d.left); const y2 = right ? draw(right, d.left + d.width / 2 + 10) : y1;
  d.y = Math.max(y1, y2) + 10;
}

function money(cents: number, cur: string, locale: string) { return formatMoney(cents, cur, locale); }

interface Col { key: string; label: string; w: number; align: 'left' | 'right' | 'center' }
function tableHeader(d: Doc, cols: Col[]) {
  const st = d.st; const h = 18;
  if (st.boxed) d.pdf.rect(d.left, d.y, d.width, h).fillAndStroke('#f2f2f2', st.rule);
  else if (st.banner) d.pdf.rect(d.left, d.y, d.width, h).fill(d.accent);
  let x = d.left;
  for (const c of cols) { d.text(c.label, x + 4, d.y + 5, c.w - 8, { f: st.bold, size: 8, color: st.banner ? '#ffffff' : st.muted, align: c.align }); x += c.w; }
  if (!st.boxed && !st.banner) { d.pdf.moveTo(d.left, d.y + h).lineTo(d.right, d.y + h).strokeColor(st.ink).lineWidth(0.8).stroke(); }
  d.y += h + 2;
}

interface RowCell { text: string; f?: string; color?: string }
interface TRow { cells: Record<string, RowCell>; sub?: { text: string; color?: string; italic?: boolean }[]; indent?: number; heading?: boolean; shade?: boolean }
const rf = (d: Doc, f?: string, heading?: boolean) => (f === '$bold' ? d.st.bold : f ?? (heading ? d.st.bold : d.st.body));
function rowHeight(d: Doc, cols: Col[], r: TRow) {
  let h = 0; const dk = cols[0].key;
  for (const c of cols) { const cell = r.cells[c.key]; if (!cell) continue; const w = c.w - 8 - (c.key === dk ? (r.indent ?? 0) : 0); h = Math.max(h, d.h(cell.text, rf(d, cell.f, r.heading), 9, w)); }
  for (const s of r.sub ?? []) h += d.h(s.text, d.st.body, 8, cols[0].w - 8 - (r.indent ?? 0)) + 1;
  return h + 9;
}
function drawRow(d: Doc, cols: Col[], r: TRow, idx: number) {
  const h = rowHeight(d, cols, r); const st = d.st;
  if (st.zebra && idx % 2 === 1) d.pdf.rect(d.left, d.y - 1, d.width, h).fill('#f6f7f8');
  if (r.shade) d.pdf.rect(d.left, d.y - 1, d.width, h).fill('#f4f4f4');
  let x = d.left; const dk = cols[0].key;
  for (const c of cols) {
    const cell = r.cells[c.key]; const ind = c.key === dk ? (r.indent ?? 0) : 0;
    if (cell) d.text(cell.text, x + 4 + ind, d.y + 4, c.w - 8 - ind, { f: rf(d, cell.f, r.heading), size: 9, color: cell.color, align: c.align });
    x += c.w;
  }
  const dc = cols[0]; let sy = d.y + 4 + d.h(r.cells[dk]?.text ?? '', rf(d, r.cells[dk]?.f, r.heading), 9, dc.w - 8 - (r.indent ?? 0)) + 1;
  for (const s of r.sub ?? []) { d.text(s.text, d.left + 4 + (r.indent ?? 0), sy, dc.w - 8 - (r.indent ?? 0), { size: 8, color: s.color ?? st.muted }); sy += d.h(s.text, st.body, 8, dc.w - 8 - (r.indent ?? 0)) + 1; }
  d.pdf.moveTo(d.left, d.y + h - 1).lineTo(d.right, d.y + h - 1).strokeColor(st.boxed ? st.rule : '#ececec').lineWidth(0.5).stroke();
  d.y += h;
  return h;
}

/** Decide what appears on the page for each stored line, honouring package display mode. */
function presentLines(lines: Row[], cur: string, loc: string, showTaxCol: boolean): TRow[] {
  const rows: TRow[] = [];
  const taxNames = (l: Row) => (l.tax_exempt ? 'Exempt' : (l.taxes as Row[]).map((t) => t.name).join(' + ') || '—');
  const stdNote = (l: Row) => (l.price_source === 'client_agreement' && l.standard_price_cents != null && l.standard_price_cents !== l.unit_price_cents ? { text: `Standard rate ${money(l.standard_price_cents, cur, loc)} / ${l.unit ?? 'unit'} · agreed client rate ${money(l.unit_price_cents, cur, loc)}`, color: '#5b7a3d' } : null);
  const base = (l: Row, indent = 0, opts: { price?: boolean } = {}): TRow => {
    const sub: TRow['sub'] = []; if (l.detail) sub.push({ text: l.detail }); const sn = stdNote(l); if (sn) sub.push(sn);
    if (l.discount_type !== 'none' && l.line_discount_cents) sub.push({ text: `Discount: ${l.discount_type === 'percent' ? formatPct(l.discount_value) : money(l.discount_value, cur, loc)} (−${money(l.line_discount_cents, cur, loc)})` });
    return { indent, sub, cells: { desc: { text: l.description }, qty: { text: `${formatQty(l.qty_milli)}${l.unit ? ' ' + l.unit : ''}` }, price: { text: opts.price === false ? '' : money(l.unit_price_cents, cur, loc) }, tax: { text: showTaxCol ? taxNames(l) : '' }, amount: { text: opts.price === false ? '' : money(l.net_cents, cur, loc), f: '$bold' } } };
  };
  for (const l of lines) {
    if (!l.package_id) { rows.push(base(l)); continue; }
    const kids: Row[] = l.children;
    const fixed = l.unit_price_cents !== 0 || kids.some((k) => k.is_component);
    if (fixed) {
      const r = base(l); r.sub = [...(r.sub ?? [])];
      if (l.package_display === 'combined') r.sub.push({ text: 'Includes: ' + kids.map((k) => `${formatQty(k.qty_milli)}${k.unit ? ' ' + k.unit : ''} ${k.description}`).join('; ') });
      rows.push(r);
      if (l.package_display === 'itemized') for (const k of kids) rows.push({ indent: 14, cells: { desc: { text: k.description, color: '#555' }, qty: { text: `${formatQty(k.qty_milli)}${k.unit ? ' ' + k.unit : ''}` }, price: { text: 'included', color: '#777' }, tax: { text: '' }, amount: { text: '' } } });
    } else if (l.package_display === 'combined') {
      const sum = kids.reduce((a, k) => a + k.net_cents, 0);
      const r = base({ ...l, unit_price_cents: sum, qty_milli: 1000, unit: 'package', tax_exempt: kids.every((k) => k.tax_exempt), taxes: kids[0]?.taxes ?? [], net_cents: sum });
      r.cells.tax = { text: showTaxCol ? [...new Set(kids.flatMap((k) => (k.tax_exempt ? ['Exempt'] : k.taxes.map((t: Row) => t.name))))].join(' + ') || '—' : '' };
      r.sub = [...(r.sub ?? []), { text: 'Includes: ' + kids.map((k) => `${formatQty(k.qty_milli)}${k.unit ? ' ' + k.unit : ''} ${k.description}`).join('; ') }]; rows.push(r);
    } else {
      rows.push({ heading: true, cells: { desc: { text: l.description }, qty: { text: '' }, price: { text: '' }, tax: { text: '' }, amount: { text: '' } }, sub: l.detail ? [{ text: l.detail }] : [] });
      for (const k of kids) rows.push(base(k, 14));
    }
  }
  return rows;
}

export async function renderDocumentPdf(c: Ctx, id: number, variant: 'document' | 'sow' = 'document'): Promise<{ buffer: Buffer; filename: string }> {
  const raw = get(c.db, 'SELECT * FROM documents WHERE id=? AND business_id=?', id, c.bid); if (!raw) throw notFound('Document');
  const doc = hydrate(c, raw, { includeStale: false });
  const live = get(c.db, 'SELECT * FROM businesses WHERE id=?', c.bid)!;
  const biz: Row = doc.business_snapshot ?? live; const cli: Row = doc.client_snapshot ?? get(c.db, 'SELECT * FROM clients WHERE id=?', doc.client_id)!;
  const s = getSettings(c.db, c.bid); const tpl = (doc.template ?? s.template) as Tpl; const loc = biz.locale || 'en-CA'; const cur = doc.currency;
  const kind = doc.type === 'estimate' ? (variant === 'sow' ? 'Statement of Work' : 'Estimate') : doc.type === 'credit_note' ? 'Credit Note' : 'Invoice';
  const numberLabel = doc.number ?? 'DRAFT';
  const d = new Doc(tpl, s.accent, { title: `${kind} ${numberLabel}`, author: biz.trading_name || biz.legal_name });
  d.footerText = `${biz.trading_name || biz.legal_name}  ·  ${kind} ${numberLabel}${doc.status === 'draft' ? ' (draft — not issued)' : ''}`;
  const today = bizToday(c.db, c.bid);
  const status = doc.display_status as string;
  const stamp = doc.status === 'draft' ? 'DRAFT' : doc.status === 'void' ? 'VOID' : status === 'paid' ? 'PAID' : null;
  const meta: [string, string][] = [[variant === 'sow' && doc.type === 'estimate' ? 'Estimate no.' : `${kind} no.`, numberLabel]];
  if (doc.issue_date) meta.push(['Issue date', doc.issue_date]);
  if (doc.type === 'invoice' && doc.due_date) meta.push(['Due date', doc.due_date]);
  if (doc.type === 'estimate' && doc.valid_until) meta.push(['Valid until', doc.valid_until]);
  if (doc.type === 'estimate' && doc.revision_no > 1) meta.push(['Revision', String(doc.revision_no)]);
  if (doc.po_ref) meta.push(['PO / reference', doc.po_ref]);
  if (doc.project_id) { const p = get(c.db, 'SELECT name FROM projects WHERE id=?', doc.project_id); if (p) meta.push(['Project', p.name]); }
  if (doc.credit_for_invoice_id) { const iv = get(c.db, 'SELECT number FROM documents WHERE id=?', doc.credit_for_invoice_id); if (iv) meta.push(['Against invoice', iv.number]); }
  letterhead(d, c, biz, kind, meta, { stamp });
  d.pageHeader = () => { d.text(`${kind} ${numberLabel} — ${cli.name}`, d.left, d.y, d.width, { size: 8, color: d.st.muted }); d.y += 16; };

  partyBlock(d, { label: doc.type === 'estimate' ? 'Prepared for' : 'Bill to', lines: [cli.company ? `${cli.name}` : cli.name, cli.company, cli.billing_address, cli.email].filter(Boolean) },
    doc.title ? { label: 'Regarding', lines: [doc.title] } : undefined);

  if (doc.type === 'estimate' && variant === 'sow') {
    d.para(s.statement_of_work_note, { size: 8, color: d.st.muted });
    for (const [t, v] of [['Scope of work', doc.scope], ['Deliverables', doc.deliverables], ['Assumptions', doc.assumptions], ['Exclusions', doc.exclusions], ['Revision terms', doc.revision_terms]] as const) if (v) { d.section(t); d.para(v); }
  }

  // Line items
  const showTax = (doc.lines as Row[]).some((l) => (l.taxes.length || l.children.some((k: Row) => k.taxes.length)) && !doc.tax_exempt);
  const wTax = showTax ? 62 : 0;
  const cols: Col[] = [{ key: 'desc', label: 'Description', w: d.width - 74 - 74 - 80 - wTax, align: 'left' }, { key: 'qty', label: 'Qty', w: 74, align: 'right' }, { key: 'price', label: 'Unit price', w: 74, align: 'right' }, ...(showTax ? [{ key: 'tax', label: 'Tax', w: wTax, align: 'center' as const }] : []), { key: 'amount', label: `Amount (${cur})`, w: 80, align: 'right' }];
  const rows = presentLines(doc.lines, cur, loc, showTax);
  d.need(60); tableHeader(d, cols);
  const totalsH = totalsHeight(doc);
  rows.forEach((r, i) => {
    const h = rowHeight(d, cols, r);
    const isLast = i === rows.length - 1;
    // keep the totals block together with the final row; never orphan a section heading from its first child
    const needed = isLast ? h + totalsH : (r.heading ? h + rowHeight(d, cols, rows[i + 1] ?? r) : h);
    if (d.y + needed > d.bottom) { d.newPage(); tableHeader(d, cols); }
    drawRow(d, cols, r, i);
  });
  d.y += 8;
  drawTotals(d, doc, cur, loc);

  if (doc.type === 'invoice' && doc.status !== 'draft') {
    const paid = doc.amount_paid_cents; const pays = (doc.payments as Row[]).filter((p) => !p.voided_at && !p.allocation_voided_at);
    if (pays.length) { d.section('Payments received'); for (const p of pays) d.para(`${p.paid_date}  ·  ${p.method}${p.reference ? ' (' + p.reference + ')' : ''}  ·  ${money(p.allocated_cents, cur, loc)}${p.receipt_number ? '  ·  Receipt ' + p.receipt_number : ''}`, { gap: 1 }); void paid; }
  }
  if (doc.type === 'estimate' && doc.stages.length && variant !== 'sow') {
    d.section('Payment schedule');
    for (const st of doc.stages as Row[]) d.para(`${st.label}  —  ${st.kind === 'percent' ? formatPct(st.value) + ' of total' : st.kind === 'fixed' ? money(st.value, cur, loc) : 'Remaining balance'}${st.due_days != null ? `  (due ${st.due_days} days after invoice)` : ''}`, { gap: 1 });
  }
  if (doc.type === 'estimate' && variant !== 'sow') for (const [t, v] of [['Scope of work', doc.scope], ['Deliverables', doc.deliverables], ['Assumptions', doc.assumptions], ['Exclusions', doc.exclusions], ['Revision terms', doc.revision_terms]] as const) if (v) { d.section(t); d.para(v); }
  if (doc.type === 'estimate' && variant === 'sow' && doc.stages.length) { d.section('Payment schedule'); for (const st of doc.stages as Row[]) d.para(`${st.label}  —  ${st.kind === 'percent' ? formatPct(st.value) + ' of total' : st.kind === 'fixed' ? money(st.value, cur, loc) : 'Remaining balance'}`, { gap: 1 }); }
  if (doc.deposit_note) { d.section('Deposit'); d.para(doc.deposit_note); }
  if (doc.type === 'invoice' && doc.payment_instructions) { d.section('How to pay'); d.para(doc.payment_instructions); }
  else if (doc.type === 'estimate' && doc.payment_instructions) { d.section('Payment instructions'); d.para(doc.payment_instructions); }
  if (doc.tax_exempt && doc.tax_exempt_note) { d.section('Tax exemption'); d.para(doc.tax_exempt_note); }
  if (doc.notes) { d.section('Notes'); d.para(doc.notes); }
  if (doc.terms) { d.section('Terms'); d.para(doc.terms, { size: 8.5, color: d.st.muted }); }
  if (doc.type === 'estimate' && doc.status === 'accepted') { d.section('Acceptance'); d.para(`Accepted${doc.accepted_by ? ' by ' + doc.accepted_by : ''} on ${String(doc.accepted_at).slice(0, 10)} (${doc.acceptance_method === 'public_link' ? 'via secure link' : 'recorded manually by the business'}).`); }
  if (doc.status === 'void') { d.section('Void'); d.para(`This document was voided on ${String(doc.voided_at).slice(0, 10)}: ${doc.void_reason ?? ''}`); }
  void today; void addDays; void displayStatus;
  return { buffer: await d.finish(), filename: `${kind.replace(/ /g, '-')}-${numberLabel}.pdf` };
}

function totalsRows(doc: Row, cur: string, loc: string): [string, string, boolean?][] {
  const rows: [string, string, boolean?][] = [];
  const inc = !!doc.prices_include_tax;
  rows.push([inc ? 'Subtotal (tax included)' : 'Subtotal', money(doc.subtotal_cents, cur, loc)]);
  if (doc.discount_cents) rows.push([`Discount${doc.discount_type === 'percent' ? ' (' + formatPct(doc.discount_value) + ')' : ''}`, '−' + money(doc.discount_cents, cur, loc)]);
  if (inc) { for (const t of doc.tax_summary as Row[]) rows.push([`Includes ${t.name} (${formatPct(t.rate_milli)})`, money(t.tax_cents, cur, loc)]); }
  else for (const t of doc.tax_summary as Row[]) rows.push([`${t.name} (${formatPct(t.rate_milli)}) on ${money(t.base_cents, cur, loc)}`, money(t.tax_cents, cur, loc)]);
  rows.push([doc.type === 'credit_note' ? 'Credit total' : 'Total', money(doc.total_cents, cur, loc), true]);
  if (doc.type === 'invoice' && doc.status !== 'draft') {
    if (doc.credited_cents) rows.push(['Credit notes applied', '−' + money(doc.credited_cents, cur, loc)]);
    if (doc.amount_paid_cents) rows.push(['Amount paid', '−' + money(doc.amount_paid_cents, cur, loc)]);
    rows.push(['Balance due', money(doc.total_cents - doc.amount_paid_cents - doc.credited_cents, cur, loc), true]);
  }
  return rows;
}
function totalsHeight(doc: Row) { return totalsRows(doc, doc.currency, 'en-CA').length * 15 + 20; }
function drawTotals(d: Doc, doc: Row, cur: string, loc: string) {
  const rows = totalsRows(doc, cur, loc); const w = 250; const x = d.right - w;
  d.need(rows.length * 15 + 10);
  for (const [k, v, strong] of rows) {
    if (strong) { d.pdf.moveTo(x, d.y - 1).lineTo(d.right, d.y - 1).strokeColor(d.st.ink).lineWidth(0.6).stroke(); }
    d.text(k, x, d.y + 2, w - 90, { f: strong ? d.st.bold : d.st.body, size: strong ? 10.5 : 9, color: strong ? d.st.ink : d.st.muted });
    d.text(v, x + w - 100, d.y + 2, 100, { f: strong ? d.st.bold : d.st.body, size: strong ? 10.5 : 9, align: 'right' });
    d.y += strong ? 17 : 14;
  }
  d.y += 4;
}

// ---- Receipt ------------------------------------------------------------------------------------
export async function renderReceiptPdf(c: Ctx, paymentId: number) {
  const p = getPayment(c, paymentId);
  const live = get(c.db, 'SELECT * FROM businesses WHERE id=?', c.bid)!; const s = getSettings(c.db, c.bid);
  const cli = get(c.db, 'SELECT * FROM clients WHERE id=?', p.client_id)!; const loc = live.locale || 'en-CA';
  const d = new Doc(s.template, s.accent, { title: `Receipt ${p.receipt_number}`, author: live.trading_name || live.legal_name });
  d.footerText = `${live.trading_name || live.legal_name}  ·  Receipt ${p.receipt_number}`;
  const title = p.kind === 'refund' ? 'Refund Receipt' : 'Receipt';
  letterhead(d, c, live, title, [['Receipt no.', p.receipt_number], ['Date received', p.paid_date], ['Method', p.method], ...(p.reference ? [['Reference', p.reference] as [string, string]] : [])], { stamp: p.voided_at ? 'VOID' : null });
  partyBlock(d, { label: p.kind === 'refund' ? 'Refunded to' : 'Received from', lines: [cli.name, cli.company, cli.billing_address] });
  d.section(p.kind === 'refund' ? 'Amount refunded' : 'Amount received');
  d.text(money(Math.abs(p.amount_cents), p.currency, loc), d.left, d.y, d.width, { f: d.st.headBold, size: 24, color: d.accent }); d.y += 34;
  d.para(p.verification === 'provider_verified' ? `Payment verified by payment provider (${p.provider ?? ''}).` : 'Payment recorded manually by the business. It has not been verified by a payment provider.', { size: 8.5, color: d.st.muted });
  const allocs = (p.allocations as Row[]).filter((a) => !a.voided_at);
  if (allocs.length) {
    d.section('Applied to');
    const cols: Col[] = [{ key: 'desc', label: 'Invoice', w: d.width - 3 * 90, align: 'left' }, { key: 'qty', label: 'Applied', w: 90, align: 'right' }, { key: 'price', label: 'Invoice total', w: 90, align: 'right' }, { key: 'amount', label: 'Balance now', w: 90, align: 'right' }];
    tableHeader(d, cols);
    allocs.forEach((a, i) => drawRow(d, cols, { cells: { desc: { text: a.invoice_number }, qty: { text: money(Math.abs(a.amount_cents), p.currency, loc) }, price: { text: money(a.total_cents, p.currency, loc) }, amount: { text: money(a.total_cents - a.amount_paid_cents - a.credited_cents, p.currency, loc) } } }, i));
  }
  if (p.unallocated_cents > 0) d.para(`Unapplied amount held on account: ${money(p.unallocated_cents, p.currency, loc)}`, { size: 9 });
  if (p.notes) { d.section('Notes'); d.para(p.notes); }
  if (p.voided_at) { d.section('Void'); d.para(`This payment record was voided on ${String(p.voided_at).slice(0, 10)}: ${p.void_reason}`); }
  return { buffer: await d.finish(), filename: `Receipt-${p.receipt_number}.pdf` };
}

// ---- Rate card ---------------------------------------------------------------------------------------
export function rateCardPriceText(i: Row, cur: string, loc: string): string {
  if (!i.show_price) return 'Contact us';
  const unit = i.unit && i.unit !== 'project' && i.unit !== 'package' ? ` / ${i.unit}` : '';
  if (i.pricing_type === 'custom_quote') return 'Custom quotation';
  if (i.pricing_type === 'on_request') return 'Price on request';
  if (i.rate_cents == null) return 'Contact us';
  return `${i.pricing_type === 'starting_from' ? 'From ' : ''}${money(i.rate_cents, i.currency || cur, loc)}${unit}`;
}
export async function renderRateCardPdf(c: Ctx, opts: { itemIds?: number[] } = {}) {
  const live = get(c.db, 'SELECT * FROM businesses WHERE id=?', c.bid)!; const s = getSettings(c.db, c.bid); const rc = s.rate_card; const loc = live.locale || 'en-CA';
  let items = listItems(c, { status: 'active' }).filter((i) => i.public_visible);
  if (opts.itemIds) items = items.filter((i) => opts.itemIds!.includes(i.id));
  const d = new Doc(s.template, s.accent, { title: rc.title, author: live.trading_name || live.legal_name });
  d.footerText = `${live.trading_name || live.legal_name}  ·  ${rc.title}`;
  const today = bizToday(c.db, c.bid);
  const meta: [string, string][] = [['Issued', today], ['Valid until', addDays(today, rc.validity_days)], ['Currency', live.currency]];
  letterhead(d, c, live, rc.title, meta);
  if (rc.intro) d.para(rc.intro, { size: 10, gap: 8 });
  const byCat = new Map<string, Row[]>(); for (const i of items) { const k = i.category_name ?? 'Other services'; byCat.set(k, [...(byCat.get(k) ?? []), i]); }
  const cols: Col[] = [{ key: 'desc', label: 'Service', w: d.width - 150, align: 'left' }, { key: 'price', label: 'Rate', w: 150, align: 'right' }];
  d.pageHeader = () => { d.text(rc.title, d.left, d.y, d.width, { size: 8, color: d.st.muted }); d.y += 16; };
  for (const [cat, list] of byCat) {
    d.need(70); d.text(cat, d.left, d.y, d.width, { f: d.st.headBold, size: 13, color: d.accent }); d.y += 20; tableHeader(d, cols);
    list.forEach((i, idx) => {
      const full = getItem(c, i.id); const sub: TRow['sub'] = [];
      if (rc.show_descriptions && (i.long_desc || i.short_desc)) sub.push({ text: i.long_desc || i.short_desc });
      const facts = [i.duration && `Duration: ${i.duration}`, i.delivery_time && `Delivery: ${i.delivery_time}`, i.revisions != null && `${i.revisions} revision${i.revisions === 1 ? '' : 's'} included`, i.platforms != null && `${i.platforms} platform${i.platforms === 1 ? '' : 's'}`, i.deliverable_count != null && `${i.deliverable_count} deliverable${i.deliverable_count === 1 ? '' : 's'}`, i.min_qty_milli && `Minimum ${formatQty(i.min_qty_milli)} ${i.unit}`, i.min_amount_cents && i.show_price && `Minimum booking ${money(i.min_amount_cents, i.currency, loc)}`].filter(Boolean).join('  ·  ');
      if (facts) sub.push({ text: facts });
      if (rc.show_deliverables && i.included) sub.push({ text: 'Includes: ' + i.included });
      if (i.exclusions) sub.push({ text: 'Not included: ' + i.exclusions });
      if (i.usage_rights) sub.push({ text: 'Usage: ' + i.usage_rights });
      if (i.kind === 'package' && full.components?.length) sub.push({ text: 'Package contains: ' + full.components.map((k: Row) => `${formatQty(k.qty_milli)} × ${k.name}`).join('; ') });
      if (i.pkg_valid_days) sub.push({ text: `Package valid for ${i.pkg_valid_days} days${i.pkg_billing_frequency ? ' · billed ' + i.pkg_billing_frequency : ''}` });
      if (full.addons?.length) sub.push({ text: 'Optional add-ons: ' + full.addons.filter((a: Row) => a.status === 'active').map((a: Row) => `${a.name}${a.pricing_type === 'fixed' && a.rate_cents != null ? ' (' + money(a.rate_cents, i.currency, loc) + (a.unit !== 'project' ? ' / ' + a.unit : '') + ')' : ''}`).join('; ') });
      const r: TRow = { sub, cells: { desc: { text: i.name, f: '$bold' }, price: { text: rateCardPriceText(i, live.currency, loc), f: '$bold' } } };
      const h = rowHeight(d, cols, r); if (d.y + h > d.bottom) { d.newPage(); tableHeader(d, cols); }
      drawRow(d, cols, r, idx);
    });
    d.y += 10;
  }
  if (!items.length) d.para('No public services are published on this rate card yet.');
  if (rc.conditions) { d.section('Pricing conditions'); d.para(rc.conditions); }
  if (rc.terms) { d.section('Terms and exclusions'); d.para(rc.terms, { size: 8.5, color: d.st.muted }); }
  d.para(`Prices in ${live.currency}${s.default_tax_ids.length ? '' : '; applicable taxes are added where they apply'}. Valid until ${addDays(today, rc.validity_days)}. Prices are subject to change; the rates on an accepted estimate are fixed for that estimate.`, { size: 8, color: d.st.muted });
  return { buffer: await d.finish(), filename: 'Rate-Card.pdf' };
}

// ---- Report ----------------------------------------------------------------------------------------------
export async function renderReportPdf(c: Ctx, r: Report) {
  const live = get(c.db, 'SELECT * FROM businesses WHERE id=?', c.bid)!; const s = getSettings(c.db, c.bid); const loc = live.locale || 'en-CA';
  const d = new Doc(s.template, s.accent, { title: r.title, author: live.trading_name || live.legal_name });
  d.footerText = `${live.trading_name || live.legal_name}  ·  ${r.title}  ·  generated ${bizToday(c.db, c.bid)}`;
  const f = Object.entries(r.filters).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k.replace('_', ' ')}: ${v}`).join(', ');
  letterhead(d, c, live, 'Report', [['Report', r.title], ['Generated', bizToday(c.db, c.bid)], ...(f ? [['Filters', f] as [string, string]] : [])]);
  const total = d.width; const fixed = r.columns.filter((x) => x.type !== 'text'); const texts = r.columns.filter((x) => x.type === 'text');
  const numW = Math.min(90, Math.max(60, Math.floor((total * 0.55) / Math.max(1, fixed.length)))); const textW = (total - numW * fixed.length) / Math.max(1, texts.length);
  const cols: Col[] = r.columns.map((x) => ({ key: x.key, label: x.label, w: x.type === 'text' ? textW : numW, align: x.type === 'text' ? 'left' : 'right' }));
  tableHeader(d, cols);
  d.pageHeader = () => { d.text(r.title, d.left, d.y, d.width, { size: 8, color: d.st.muted }); d.y += 16; };
  r.rows.forEach((row, i) => {
    const cells: Record<string, RowCell> = {};
    for (const col of r.columns) { const v = row[col.key]; cells[col.key] = { text: v == null ? '' : col.type === 'money' ? money(v, row.currency || live.currency, loc) : col.type === 'int' ? String(Math.round(v * 1000) / 1000) : col.type === 'pct' ? String(v) + '%' : String(v) }; }
    const h = rowHeight(d, cols, { cells }); if (d.y + h > d.bottom) { d.newPage(); tableHeader(d, cols); }
    drawRow(d, cols, { cells }, i);
  });
  if (!r.rows.length) d.para('No data for the selected filters.');
  d.y += 6; for (const n of r.notes) d.para(n, { size: 8, color: d.st.muted });
  return { buffer: await d.finish(), filename: `${r.name}.pdf` };
}
void all; void balanceOf;
