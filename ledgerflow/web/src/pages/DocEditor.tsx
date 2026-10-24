import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { fmt, get, newKey, post, put, useFetch, today, pctFromMilli } from '../api';
import { ErrorBox, Field, Loading, Modal, MoneyInput, NumInput, PageTop, PdfView, useAction, useBiz, useToast, Badge } from '../ui';

interface L { key: string; [k: string]: any; children?: L[] }
let seq = 0; const k = () => `l${++seq}`;
const blank = (): L => ({ key: k(), description: '', detail: '', unit: '', qty_milli: 1000, unit_price_cents: 0, price_source: 'custom', needs_confirmation: 0, price_confirmed: 1, discount_type: 'none', discount_value: 0, taxes: [], tax_exempt: 0 });
const fromServer = (l: any): L => ({ ...l, key: k(), children: (l.children ?? []).map((c: any) => ({ ...c, key: k() })) });
const toServer = (l: L): any => { const { key, children, warnings, price_note, _parts, ...rest } = l; return { ...rest, children: children?.map(toServer) }; };

export function DocEditor({ type: typeProp }: { type?: 'estimate' | 'invoice' }) {
  const { id } = useParams(); const [sp] = useSearchParams(); const nav = useNavigate(); const toast = useToast(); const { b, biz } = useBiz();
  const { data: existing, error: loadErr, loading } = useFetch<any>(id ? b(`/documents/${id}`) : null, [id]);
  const { data: clients } = useFetch<any[]>(b('/clients')); const { data: taxes } = useFetch<any[]>(b('/taxes')); const { data: settings } = useFetch<any>(b('/business'));
  const [f, setF] = useState<any>(null); const [lines, setLines] = useState<L[]>([]); const [stages, setStages] = useState<any[]>([]); const [calc, setCalc] = useState<any>(null); const [calcErr, setCalcErr] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null); const key = useRef(newKey()); const { busy, error, run, setError } = useAction(); const [docId, setDocId] = useState<number | null>(id ? Number(id) : null);
  const type: 'estimate' | 'invoice' = existing?.type ?? typeProp ?? 'invoice'; const { data: projects } = useFetch<any[]>(f?.client_id ? b(`/projects?client_id=${f.client_id}`) : null, [f?.client_id]);
  const [dirty, setDirty] = useState(false); const [bill, setBill] = useState(false);

  useEffect(() => { // initialise
    if (id && existing) { if (existing.status !== 'draft') { nav(`/documents/${id}`, { replace: true }); return; } setF({ ...existing }); setLines(existing.lines.map(fromServer)); setStages(existing.stages ?? []); }
    else if (!id && settings && clients) { const cl = clients.find((c) => c.id === Number(sp.get('client'))); setF({ client_id: cl?.id ?? '', project_id: '', currency: cl?.currency ?? biz.currency, prices_include_tax: settings.settings.prices_include_tax ? 1 : 0, tax_exempt: cl?.tax_exempt ?? 0, tax_exempt_note: cl?.tax_exempt_note ?? '', discount_type: 'none', discount_value: 0, notes: '', terms: '', payment_instructions: '', title: '', po_ref: '', issue_date: '', due_date: '', valid_until: '', scope: '', deliverables: '', assumptions: '', exclusions: '', revision_terms: '' }); }
  }, [existing, settings, clients]); // eslint-disable-line
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); }; window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h); }, [dirty]);

  const payload = useMemo(() => f && ({ ...f, type, lines: lines.map(toServer), stages: type === 'estimate' ? stages.map((s) => ({ label: s.label, kind: s.kind, value: s.value, due_days: s.due_days ?? null })) : undefined, project_id: f.project_id || null, issue_date: f.issue_date || null, due_date: f.due_date || null, valid_until: f.valid_until || null, id: undefined, lines_: undefined }), [f, lines, stages, type]);
  // Authoritative totals come from the server on every change (debounced). The browser never calculates money.
  useEffect(() => {
    if (!payload || !payload.client_id) { setCalc(null); return; } let alive = true;
    const t = setTimeout(() => post(b('/documents/calc'), { ...payload, stages: undefined }).then((c) => { if (alive) { setCalc(c); setCalcErr(null); } }).catch((e) => { if (alive) setCalcErr(e.message); }), 250);
    return () => { alive = false; clearTimeout(t); };
  }, [payload, b]);
  if (loadErr) return <ErrorBox error={loadErr} />; if ((id && loading) || !f || !clients || !taxes) return <Loading />;
  const set = (patch: any) => { setF({ ...f, ...patch }); setDirty(true); };
  const setLine = (i: number, patch: any, ci?: number) => { setDirty(true); setLines(lines.map((l, j) => j !== i ? l : ci === undefined ? { ...l, ...patch } : { ...l, children: l.children!.map((c, x) => (x === ci ? { ...c, ...patch } : c)) })); };
  const client = clients.find((c) => c.id === Number(f.client_id));
  const onClient = (cid: string) => { const c = clients.find((x) => x.id === Number(cid)); set({ client_id: cid ? Number(cid) : '', project_id: '', currency: c?.currency ?? f.currency, tax_exempt: c?.tax_exempt ?? 0, tax_exempt_note: c?.tax_exempt_note ?? f.tax_exempt_note }); };
  const save = async (): Promise<number | undefined> => run(async () => {
    const body = { ...payload };
    let nid = docId; if (docId) await put(b(`/documents/${docId}`), body); else { nid = (await post(b('/documents'), body, { 'Idempotency-Key': key.current })).id; setDocId(nid); nav(`/documents/${nid}/edit`, { replace: true }); }
    setDirty(false); return nid!;
  });
  const addItem = async (itemId: number) => { try { const l = await get(b(`/ratecard/line/${itemId}?client_id=${f.client_id || ''}`)); setLines([...lines, fromServer(l)]); setDirty(true); } catch (e: any) { setError(e.message); } };
  const label = type === 'estimate' ? 'Quote' : 'Invoice'; const cur = f.currency; const stale = existing?.stale ?? [];
  const blocking = lines.some((l) => l.needs_confirmation && !l.price_confirmed);
  return <>
    <PageTop title={`${docId ? 'Edit' : 'New'} ${label.toLowerCase()}`} sub={existing?.revision_no > 1 ? `Revision ${existing.revision_no}` : 'Draft — not numbered until issued'}>
      <button className="btn" disabled={busy || !f.client_id} onClick={async () => { const n = await save(); if (n) toast('Draft saved'); }}>Save draft</button>
      <button className="btn" disabled={busy || !f.client_id} onClick={async () => { const n = await save(); if (n) setView(b(`/documents/${n}/pdf`)); }}>Preview PDF</button>
      <button className="btn primary" disabled={busy || !f.client_id || !lines.length || blocking} onClick={async () => { const n = await save(); if (n) run(async () => { await post(b(`/documents/${n}/issue`)); setDirty(false); nav(`/documents/${n}`); }, `${label} issued`); }}>Issue {label.toLowerCase()}</button></PageTop>
    {error && <div className="alert bad" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
    {stale.length > 0 && <div className="alert warn" style={{ marginBottom: 12 }}><strong>Rate card prices have changed since this draft was created</strong> for {stale.length} line(s). Prices stay as drafted until you choose to update them.{' '}
      <button className="btn sm" onClick={() => run(async () => { await post(b(`/documents/${docId}/refresh-pricing`), { line_ids: stale.map((s: any) => s.line_id) }); location.reload(); })}>Update to current prices</button>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{stale.map((s: any) => <li key={s.line_id}>{s.description}: {fmt(s.current_price_cents, cur)} → {fmt(s.new_rate_cents, cur)}</li>)}</ul></div>}
    <div className="card form cols" style={{ marginBottom: 16 }}>
      <Field label="Client"><select value={f.client_id} onChange={(e) => onClient(e.target.value)} autoFocus={!f.client_id}><option value="">Select a client…</option>{clients.filter((c) => !c.archived || c.id === f.client_id).map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` — ${c.company}` : ''}</option>)}</select></Field>
      <Field label="Project (optional)"><select value={f.project_id ?? ''} onChange={(e) => set({ project_id: e.target.value })} disabled={!f.client_id}><option value="">None</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Title / reference"><input value={f.title ?? ''} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Spring campaign" /></Field>
      <Field label="Currency"><input value={f.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} /></Field>
      {type === 'invoice' ? <><Field label="Issue date" help="Blank = today when issued"><input type="date" value={f.issue_date ?? ''} onChange={(e) => set({ issue_date: e.target.value })} /></Field><Field label="Due date" help="Blank = client/business payment terms"><input type="date" value={f.due_date ?? ''} onChange={(e) => set({ due_date: e.target.value })} /></Field><Field label="PO / reference no."><input value={f.po_ref ?? ''} onChange={(e) => set({ po_ref: e.target.value })} /></Field></>
        : <><Field label="Valid until" help="Blank = default validity from settings"><input type="date" value={f.valid_until ?? ''} onChange={(e) => set({ valid_until: e.target.value })} /></Field><Field label="PO / reference no."><input value={f.po_ref ?? ''} onChange={(e) => set({ po_ref: e.target.value })} /></Field></>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!f.prices_include_tax} onChange={(e) => set({ prices_include_tax: e.target.checked ? 1 : 0 })} /> Prices already include tax</label>
      <div><label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!f.tax_exempt} onChange={(e) => set({ tax_exempt: e.target.checked ? 1 : 0 })} /> Tax-exempt document</label>{!!f.tax_exempt && <input aria-label="Exemption details" style={{ marginTop: 6 }} placeholder="Exemption details" value={f.tax_exempt_note ?? ''} onChange={(e) => set({ tax_exempt_note: e.target.value })} />}</div>
    </div>

    <div className="card" style={{ marginBottom: 16 }}>
      <div className="sp-between" style={{ marginBottom: 10 }}><h2>Line items</h2><ItemSearch clientId={f.client_id} onPick={addItem} disabled={!f.client_id} /></div>
      {!f.client_id && <p className="muted">Choose a client first so agreed rates apply.</p>}
      <div className="lines"><div className="line head" aria-hidden><span>Description</span><span>Qty</span><span>Rate</span><span>Discount</span><span>Tax</span><span className="right">Amount</span><span /></div>
        {lines.map((l, i) => <div key={l.key}><LineRow l={l} taxes={taxes.filter((t) => t.active)} cur={cur} amount={calc?.lines?.[i]?.net_cents} onChange={(p) => setLine(i, p)} onRemove={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }} />
          {l.children?.map((c, ci) => <LineRow key={c.key} child l={c} taxes={taxes.filter((t) => t.active)} cur={cur} amount={calc?.lines?.[i]?.children?.[ci]?.net_cents} onChange={(p) => setLine(i, p, ci)} />)}</div>)}
        {!lines.length && <p className="muted" style={{ padding: '14px 0' }}>Search your rate card above, or add a custom line.</p>}</div>
      <div className="row" style={{ marginTop: 10 }}>{type === 'invoice' && docId && f.client_id ? <button className="btn sm fit" onClick={async () => { if (dirty) await save(); setBill(true); }}>+ Billable time & expenses</button> : null}<button className="btn sm fit" onClick={() => { setLines([...lines, { ...blank(), taxes: (settings?.settings.default_tax_ids ?? []).map((tid: number) => taxes.find((t) => t.id === tid)).filter(Boolean) }]); setDirty(true); }}>+ Custom line</button></div>
      <div style={{ marginTop: 16 }} className="totals" aria-live="polite">
        {calcErr && <div className="alert bad">{calcErr}</div>}
        <div><span>Subtotal{f.prices_include_tax ? ' (tax included)' : ''}</span><span className="mono">{fmt(calc?.subtotal_cents ?? 0, cur)}</span></div>
        <div className="row" style={{ alignItems: 'center' }}><select aria-label="Discount type" style={{ maxWidth: 120 }} value={f.discount_type} onChange={(e) => set({ discount_type: e.target.value, discount_value: 0 })}><option value="none">No discount</option><option value="percent">Discount %</option><option value="fixed">Discount $</option></select>
          {f.discount_type === 'percent' && <NumInput aria-label="Discount percent" milli={f.discount_value / 1} onChange={(m) => set({ discount_value: m })} style={{ maxWidth: 90 }} />}{f.discount_type === 'fixed' && <MoneyInput aria-label="Discount amount" cents={f.discount_value} onChange={(c) => set({ discount_value: c ?? 0 })} style={{ maxWidth: 120 }} />}
          <span className="mono right">{calc?.discount_cents ? `−${fmt(calc.discount_cents, cur)}` : ''}</span></div>
        {calc?.tax_summary?.map((t: any) => <div key={t.name + t.rate_milli}><span>{f.prices_include_tax ? 'Includes ' : ''}{t.name} ({pctFromMilli(t.rate_milli)})</span><span className="mono">{fmt(t.tax_cents, cur)}</span></div>)}
        <div className="big"><span>Total</span><span className="mono">{fmt(calc?.total_cents ?? 0, cur)}</span></div></div>
      {blocking && <div className="alert warn" style={{ marginTop: 10 }}>One or more lines use a starting-from, custom or on-request price. Enter the price and tick “price confirmed” before issuing.</div>}
    </div>

    {type === 'estimate' && <div className="card form" style={{ marginBottom: 16 }}><h2>Scope & terms</h2>
      <Field label="Scope of work"><textarea value={f.scope ?? ''} onChange={(e) => set({ scope: e.target.value })} /></Field><div className="form cols"><Field label="Deliverables"><textarea value={f.deliverables ?? ''} onChange={(e) => set({ deliverables: e.target.value })} /></Field><Field label="Assumptions"><textarea value={f.assumptions ?? ''} onChange={(e) => set({ assumptions: e.target.value })} /></Field><Field label="Exclusions"><textarea value={f.exclusions ?? ''} onChange={(e) => set({ exclusions: e.target.value })} /></Field><Field label="Revision terms"><textarea value={f.revision_terms ?? ''} onChange={(e) => set({ revision_terms: e.target.value })} /></Field></div>
      <h3>Payment schedule (deposits & milestones)</h3><p className="help">Each stage can later be invoiced separately from the accepted quote. Percentages apply to the quote total before tax; tax is added on each stage invoice.</p>
      {stages.map((s, i) => <div className="row" key={i}><Field label="Stage"><input value={s.label} onChange={(e) => { setStages(stages.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))); setDirty(true); }} /></Field>
        <Field label="Type"><select value={s.kind} onChange={(e) => { setStages(stages.map((x, j) => (j === i ? { ...x, kind: e.target.value, value: 0 } : x))); setDirty(true); }}><option value="percent">Percentage</option><option value="fixed">Fixed amount</option><option value="balance">Remaining balance</option></select></Field>
        {s.kind === 'percent' && <Field label="Percent"><NumInput milli={s.value} onChange={(m) => { setStages(stages.map((x, j) => (j === i ? { ...x, value: m } : x))); setDirty(true); }} /></Field>}{s.kind === 'fixed' && <Field label="Amount"><MoneyInput cents={s.value} onChange={(c) => { setStages(stages.map((x, j) => (j === i ? { ...x, value: c ?? 0 } : x))); setDirty(true); }} /></Field>}
        <Field label="Due (days after invoice)"><input inputMode="numeric" value={s.due_days ?? ''} onChange={(e) => { setStages(stages.map((x, j) => (j === i ? { ...x, due_days: e.target.value === '' ? null : Number(e.target.value) } : x))); setDirty(true); }} /></Field><button className="btn sm fit" onClick={() => { setStages(stages.filter((_, j) => j !== i)); setDirty(true); }}>Remove</button></div>)}
      <div className="row"><button className="btn sm fit" onClick={() => { setStages([...stages, { label: stages.length ? 'Next payment' : 'Deposit', kind: 'percent', value: 30000, due_days: 7 }]); setDirty(true); }}>+ Add stage</button></div></div>}

    <div className="card form cols"><h2 className="span">Notes & payment</h2>
      <Field label="Notes (shown to client)"><textarea value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></Field>
      <Field label="Payment instructions" help={type === 'invoice' ? 'Where and how to pay' : undefined}><textarea value={f.payment_instructions ?? ''} onChange={(e) => set({ payment_instructions: e.target.value })} /></Field>
      <Field label="Terms & conditions" span><textarea value={f.terms ?? ''} onChange={(e) => set({ terms: e.target.value })} /></Field></div>
    {!!client?.tax_exempt && !f.tax_exempt && <p className="alert warn" style={{ marginTop: 12 }}>This client is marked tax-exempt but this document charges tax.</p>}
    {view && <PdfView url={view} title="PDF preview" onClose={() => setView(null)} />}
    {bill && docId && <BillableModal docId={docId} clientId={f.client_id} onClose={() => setBill(false)} onAdded={() => location.reload()} />}
  </>;
}

function ItemSearch({ clientId, onPick, disabled }: { clientId: any; onPick: (id: number) => void; disabled?: boolean }) {
  const { b } = useBiz(); const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]); const [open, setOpen] = useState(false); const [idx, setIdx] = useState(0); const timer = useRef<any>(null);
  useEffect(() => { if (!open) return; let alive = true; const t = setTimeout(() => get(b(`/ratecard/search?q=${encodeURIComponent(q)}&client_id=${clientId || ''}`)).then((r) => { if (alive) { setRes(r); setIdx(0); } }).catch(() => {}), 120); return () => { alive = false; clearTimeout(t); }; }, [q, open, clientId, b]);
  const pick = (r: any) => { onPick(r.id); setQ(''); setOpen(false); };
  return <div style={{ position: 'relative', flex: '1 1 320px', maxWidth: 460 }}>
    <input role="combobox" aria-expanded={open} aria-controls="rc-results" aria-label="Search your rate card" placeholder="Search rate card (services, packages, add-ons)…" disabled={disabled} value={q} onFocus={() => { clearTimeout(timer.current); setOpen(true); }} onBlur={() => { timer.current = setTimeout(() => setOpen(false), 150); }} onChange={(e) => { clearTimeout(timer.current); setQ(e.target.value); setOpen(true); }}
      onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(idx + 1, res.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(idx - 1, 0)); } else if (e.key === 'Enter' && res[idx]) { e.preventDefault(); pick(res[idx]); } else if (e.key === 'Escape') setOpen(false); }} />
    {open && <div className="suggest" id="rc-results" role="listbox">{res.length === 0 ? <div style={{ padding: 12 }} className="muted">No matching active services. Add services in the Rate Card.</div> : res.map((r, i) => <button key={r.id} role="option" aria-selected={i === idx} onMouseDown={(e) => { e.preventDefault(); pick(r); }}>
      <strong>{r.name}</strong> {r.kind !== 'service' && <Badge s="warn" text={r.kind} />} <span className="muted">· {r.category_name ?? 'uncategorised'}</span><br /><span className="muted">{r.needs_confirmation ? (r.pricing_type === 'starting_from' ? `from ${fmt(r.standard_rate_cents)}` : 'price to be confirmed') : fmt(r.rate_cents, r.currency)} / {r.unit}{r.source === 'client_agreement' && ` · agreed rate (standard ${fmt(r.standard_rate_cents)})`}</span></button>)}</div>}
  </div>;
}

function LineRow({ l, taxes, cur, amount, onChange, onRemove, child }: { l: L; taxes: any[]; cur: string; amount?: number; onChange: (p: any) => void; onRemove?: () => void; child?: boolean }) {
  const comp = !!l.is_component; const grp = !!l.group_only;
  const taxLabel = l.tax_exempt ? 'Exempt' : l.taxes.length ? l.taxes.map((t: any) => t.name).join(' + ') : 'None';
  return <div className={`line ${child ? 'child' : ''}`}>
    <div className="desc"><input aria-label="Description" value={l.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="Description" />
      {!child && <textarea aria-label="Details" style={{ minHeight: 40, marginTop: 4, fontSize: '.85rem' }} value={l.detail ?? ''} onChange={(e) => onChange({ detail: e.target.value })} placeholder="Details (optional)" />}
      {l.price_source === 'client_agreement' && <div className="help" style={{ color: 'var(--ok)' }}>Agreed client rate · standard {fmt(l.standard_price_cents, cur)}</div>}
      {l.price_source === 'custom' && l.rc_item_id && l.standard_price_cents != null && l.unit_price_cents !== l.standard_price_cents && !l.needs_confirmation && <div className="help" style={{ color: 'var(--warn)' }}>Price edited · rate card {fmt(l.standard_price_cents, cur)}</div>}
      {l.needs_confirmation ? <label className="help" style={{ color: 'var(--warn)', display: 'flex', gap: 6 }}><input type="checkbox" checked={!!l.price_confirmed} onChange={(e) => onChange({ price_confirmed: e.target.checked ? 1 : 0 })} /> {l.price_note ?? 'Confirm this price'} — price confirmed</label> : l.price_note && comp ? <div className="help">{l.price_note}</div> : null}
      {l.warnings?.map((w: string) => <div key={w} className="help" style={{ color: 'var(--warn)' }}>⚠ {w}</div>)}
      {l.package_id && !child && <div className="help">Package · shown to client as <select aria-label="Package display" value={l.package_display} onChange={(e) => onChange({ package_display: e.target.value })}><option value="combined">one combined line</option><option value="itemized">each included service</option></select></div>}</div>
    <label className="f" data-l="Qty"><NumInput aria-label="Quantity" milli={l.qty_milli} onChange={(m) => onChange({ qty_milli: m })} disabled={grp} /><span className="help">{l.unit}</span></label>
    <label className="f" data-l="Rate">{comp || grp ? <span className="muted" style={{ padding: 8 }}>{comp ? 'included' : '—'}</span> : <MoneyInput aria-label="Unit price" cents={l.unit_price_cents} onChange={(c) => onChange({ unit_price_cents: c ?? 0, ...(l.needs_confirmation ? {} : {}) })} />}</label>
    <div>{!comp && !grp && <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><select aria-label="Discount type" style={{ padding: 4 }} value={l.discount_type} onChange={(e) => onChange({ discount_type: e.target.value, discount_value: 0 })}><option value="none">–</option><option value="percent">%</option><option value="fixed">$</option></select>
      {l.discount_type === 'percent' && <NumInput aria-label="Discount percent" milli={l.discount_value} onChange={(m) => onChange({ discount_value: m })} />}{l.discount_type === 'fixed' && <MoneyInput aria-label="Discount amount" cents={l.discount_value} onChange={(c) => onChange({ discount_value: c ?? 0 })} />}</div>}</div>
    <details><summary style={{ cursor: 'pointer' }}>{taxLabel}</summary>{!comp && <div style={{ display: 'grid', gap: 4, padding: '6px 0' }}>{taxes.map((t) => <label key={t.id} style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={l.taxes.some((x: any) => x.id === t.id)} onChange={(e) => onChange({ taxes: e.target.checked ? [...l.taxes, t] : l.taxes.filter((x: any) => x.id !== t.id) })} />{t.name}</label>)}<label style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={!!l.tax_exempt} onChange={(e) => onChange({ tax_exempt: e.target.checked ? 1 : 0 })} />Exempt</label></div>}</details>
    <div className="right mono" aria-label="Line amount">{comp ? '' : fmt(amount ?? 0, cur)}</div>
    {onRemove ? <button className="btn ghost sm" onClick={onRemove} aria-label={`Remove ${l.description || 'line'}`}>✕</button> : <span />}
  </div>;
}
void today;

function BillableModal({ docId, clientId, onClose, onAdded }: { docId: number; clientId: number; onClose: () => void; onAdded: () => void }) {
  const { b } = useBiz(); const { data: time } = useFetch<any[]>(b(`/time?client_id=${clientId}&unbilled=1`)); const { data: exps } = useFetch<any[]>(b(`/expenses?client_id=${clientId}&unbilled=1`)); const [t, setT] = useState<number[]>([]); const [e, setE] = useState<number[]>([]); const { busy, error, run } = useAction(); const [override, setOverride] = useState(false);
  const tog = (arr: number[], set: (x: number[]) => void, id: number) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  return <Modal title="Add billable time and expenses" onClose={onClose} wide><div className="form"><p className="help">Only items not already on another invoice are listed. An item can be invoiced once; voiding or deleting the invoice releases it.</p>
    <h3>Time</h3>{time?.length ? time.map((x) => <label key={x.id} style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={t.includes(x.id)} onChange={() => tog(t, setT, x.id)} />{x.entry_date} · {(x.minutes / 60).toFixed(2)} h × {fmt(x.rate_cents)} = {fmt(x.value_cents)} · {x.notes}</label>) : <p className="muted">No unbilled time.</p>}
    <h3>Billable expenses</h3>{exps?.length ? exps.map((x) => <label key={x.id} style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={e.includes(x.id)} onChange={() => tog(e, setE, x.id)} />{x.expense_date} · {x.merchant} · {fmt(x.amount_cents - x.tax_cents, x.currency)} pre-tax</label>) : <p className="muted">No unbilled billable expenses.</p>}
    <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={override} onChange={(ev) => setOverride(ev.target.checked)} /> Intentional override: re-bill items already invoiced elsewhere</label>
    {error && <div className="alert bad">{error}</div>}<button className="btn primary" disabled={busy || (!t.length && !e.length)} onClick={() => run(async () => { await post(b(`/documents/${docId}/billable`), { time_entry_ids: t, expense_ids: e, override }); onAdded(); })}>Add to invoice</button></div></Modal>;
}
