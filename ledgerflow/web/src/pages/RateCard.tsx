import { useMemo, useState } from 'react';
import { fileToB64, fmt, fromCents, get, label, post, put, useFetch } from '../api';
import { Badge, Confirm, Empty, ErrorBox, Field, Loading, Modal, MoneyInput, NumInput, PageTop, PdfView, Tabs, useAction, useBiz, useToast } from '../ui';

const UNITS = ['project', 'hour', 'day', 'video', 'reel', 'post', 'platform', 'event', 'session', 'month', 'week', 'photo', 'revision', 'km', 'item', 'package'];
const PT: Record<string, string> = { fixed: 'Fixed rate', starting_from: 'Starting from', custom_quote: 'Custom quotation', on_request: 'Price on request' };
export const priceText = (i: any) => i.pricing_type === 'custom_quote' ? 'Custom quote' : i.pricing_type === 'on_request' ? 'On request' : i.rate_cents == null ? (i.pkg_price_mode === 'itemized' ? 'Itemized' : '—') : `${i.pricing_type === 'starting_from' ? 'from ' : ''}${fmt(i.rate_cents, i.currency)}`;

export function RateCard() {
  const { b, canWrite, isAdmin } = useBiz(); const [tab, setTab] = useState('services');
  return <>
    <PageTop title="Rate Card" sub="Your services and prices — the source for every quote and invoice">
      <a className="btn" href={b('/ratecard/export.csv')}>Export CSV</a></PageTop>
    <Tabs value={tab} onChange={setTab} tabs={[['services', 'Services & packages'], ['categories', 'Categories'], ['import', 'Import'], ['versions', 'Versions & price changes'], ['publish', 'Client-facing PDF']]} />
    {tab === 'services' && <Services canWrite={canWrite} />}{tab === 'categories' && <Categories canWrite={canWrite} />}
    {tab === 'import' && (canWrite ? <Import onDone={() => setTab('services')} /> : <p>Read-only role.</p>)}{tab === 'versions' && <Versions isAdmin={isAdmin} />}{tab === 'publish' && <Publish isAdmin={isAdmin} />}
  </>;
}

function Services({ canWrite }: { canWrite: boolean }) {
  const { b } = useBiz(); const toast = useToast(); const [q, setQ] = useState(''); const [cat, setCat] = useState(''); const [status, setStatus] = useState(''); const [edit, setEdit] = useState<any>(null);
  const { data: cats } = useFetch<any[]>(b('/ratecard/categories'));
  const { data, error, loading, reload } = useFetch<any[]>(b(`/ratecard/items?search=${encodeURIComponent(q)}${cat ? `&category_id=${cat}` : ''}${status ? `&status=${status}` : ''}`), [b]);
  const [sel, setSel] = useState<number[]>([]); const [adj, setAdj] = useState(false);
  const act = useAction();
  return <>
    <div className="row" style={{ marginBottom: 12 }}>
      <Field label="Search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, SKU or description" /></Field>
      <Field label="Category"><select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All</option>{cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Active & inactive</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option><option value="all">All</option></select></Field>
      {canWrite && <><button className="btn primary fit" onClick={() => setEdit({ kind: 'service' })}>Add service</button><button className="btn fit" onClick={() => setEdit({ kind: 'package' })}>Add package</button></>}
      {canWrite && sel.length > 0 && <button className="btn fit" onClick={() => setAdj(true)}>Adjust {sel.length} rate(s)…</button>}
    </div>
    {act.error && <ErrorBox error={act.error} />}
    {error ? <ErrorBox error={error} retry={reload} /> : loading && !data ? <Loading /> : !data?.length ? <Empty title="Your rate card is empty"><p>Import your existing rate card from a CSV or pasted text, or add services one by one.</p></Empty> :
      <div className="tablewrap"><table><thead><tr>{canWrite && <th style={{ width: 30 }}><input type="checkbox" aria-label="Select all" checked={sel.length === data.length} onChange={(e) => setSel(e.target.checked ? data.map((d) => d.id) : [])} /></th>}<th>Service</th><th>Category</th><th>Unit</th><th className="n">Rate</th><th>Status</th><th /></tr></thead><tbody>
        {data.map((i) => <tr key={i.id}>{canWrite && <td><input type="checkbox" aria-label={`Select ${i.name}`} checked={sel.includes(i.id)} onChange={(e) => setSel(e.target.checked ? [...sel, i.id] : sel.filter((x) => x !== i.id))} /></td>}
          <td><strong>{i.name}</strong> {i.kind !== 'service' && <Badge s="warn" text={label(i.kind)} />}<div className="muted">{i.short_desc}</div></td><td>{i.category_name ?? '—'}</td><td>{i.unit}</td><td className="n">{priceText(i)}{i.pricing_type !== 'fixed' && <div className="muted">{PT[i.pricing_type]}</div>}</td>
          <td><Badge s={i.status} /></td><td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" onClick={async () => setEdit(await get(b(`/ratecard/items/${i.id}`)))}>{canWrite ? 'Edit' : 'View'}</button>
            {canWrite && <> <button className="btn sm" onClick={() => act.run(async () => { await post(b(`/ratecard/items/${i.id}/duplicate`)); reload(); }, 'Duplicated (inactive copy)')}>Duplicate</button> <button className="btn sm" onClick={() => act.run(async () => { await post(b(`/ratecard/items/${i.id}/status`), { status: i.status === 'archived' ? 'active' : 'archived' }); reload(); }, i.status === 'archived' ? 'Restored' : 'Archived')}>{i.status === 'archived' ? 'Restore' : 'Archive'}</button></>}</td></tr>)}</tbody></table></div>}
    {edit && <ItemForm item={edit} cats={cats ?? []} readOnly={!canWrite} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); toast('Saved'); }} />}
    {adj && <AdjustForm ids={sel} onClose={() => setAdj(false)} onDone={() => { setAdj(false); setSel([]); reload(); }} />}
  </>;
}

function AdjustForm({ ids, onClose, onDone }: { ids: number[]; onClose: () => void; onDone: () => void }) {
  const { b } = useBiz(); const [pct, setPct] = useState('5'); const [note, setNote] = useState('Annual rate review'); const { busy, error, run } = useAction();
  return <Modal title="Adjust selected rates" onClose={onClose}><div className="form"><p>Applies a percentage change to {ids.length} service(s). Existing quotes and invoices are <strong>not</strong> changed; each change is recorded in the price history. Services without a numeric rate are skipped.</p>
    <Field label="Change (%) — negative to reduce"><input value={pct} inputMode="decimal" onChange={(e) => setPct(e.target.value)} /></Field><Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    {error && <div className="alert bad">{error}</div>}<button className="btn primary" disabled={busy || isNaN(Number(pct))} onClick={() => run(async () => { await post(b('/ratecard/bulk-adjust'), { ids, milli_pct: Math.round(Number(pct) * 1000), note }); onDone(); }, 'Rates updated')}>Apply</button></div></Modal>;
}

function ItemForm({ item, cats, readOnly, onClose, onSaved }: { item: any; cats: any[]; readOnly: boolean; onClose: () => void; onSaved: () => void }) {
  const { b } = useBiz(); const { busy, error, run } = useAction(); const { data: all } = useFetch<any[]>(b('/ratecard/items'));
  const [f, setF] = useState<any>({ kind: 'service', unit: 'project', pricing_type: 'fixed', default_qty_milli: 1000, public_visible: 1, show_price: 1, status: 'active', pkg_price_mode: 'fixed', pkg_display: 'combined', ...item, addon_ids: item.addons?.map((a: any) => a.id) ?? [], components: item.components?.map((k: any) => ({ item_id: k.item_id, qty_milli: k.qty_milli, description: k.description })) ?? [] });
  const [adv, setAdv] = useState(false); const [change, setChange] = useState('');
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value }); const isPkg = f.kind === 'package';
  const numOrNull = (v: any) => (v === '' || v == null ? null : Number(v));
  const need = f.pricing_type === 'fixed' || f.pricing_type === 'starting_from';
  const itemizedTotal = (f.components as any[]).reduce((a, k) => { const it = all?.find((x) => x.id === Number(k.item_id)); return a + (it?.rate_cents ? Math.round(it.rate_cents * k.qty_milli / 1000) : 0); }, 0);
  const save = () => run(async () => {
    const body = { ...f, category_id: f.category_id || null, min_qty_milli: f.min_qty_milli || null, revisions: numOrNull(f.revisions), platforms: numOrNull(f.platforms), deliverable_count: numOrNull(f.deliverable_count), effective_date: f.effective_date || null, change_note: change || undefined, rate_cents: f.rate_cents ?? null, tax_code_ids: f.tax_mode === 'exempt' ? [] : f.tax_mode === 'default' || f.tax_mode === undefined ? (item.id && item.tax_code_ids ? item.tax_code_ids : null) : f.tax_code_ids };
    item.id ? await put(b(`/ratecard/items/${item.id}`), body) : await post(b('/ratecard/items'), body); onSaved();
  });
  return <Modal title={item.id ? (readOnly ? item.name : `Edit ${isPkg ? 'package' : 'service'}`) : `New ${isPkg ? 'package' : 'service'}`} onClose={onClose} wide>
    <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}><div className="form cols">
      <Field label="Name" span><input value={f.name ?? ''} onChange={s('name')} autoFocus /></Field>
      <Field label="Category"><select value={f.category_id ?? ''} onChange={s('category_id')}><option value="">None</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Type"><select value={f.kind} onChange={s('kind')} disabled={!!item.id}><option value="service">Service</option><option value="addon">Optional add-on</option><option value="fee">Fee (rush, travel, overtime…)</option><option value="package">Package / bundle</option></select></Field>
      <Field label="Pricing"><select value={f.pricing_type} onChange={s('pricing_type')}>{Object.entries(PT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label={isPkg && f.pkg_price_mode === 'itemized' ? 'Rate (not used — priced by components)' : need ? 'Rate' : 'Reference rate (optional)'} help={f.pricing_type === 'starting_from' ? 'A starting price is never treated as a final price: you must confirm the price on each quote.' : f.pricing_type !== 'fixed' ? 'You will enter and confirm the price on each quote.' : undefined}><MoneyInput cents={f.rate_cents} onChange={(c) => setF({ ...f, rate_cents: c })} disabled={isPkg && f.pkg_price_mode === 'itemized'} /></Field>
      <Field label="Billing unit"><input list="units" value={f.unit} onChange={s('unit')} /><datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist></Field>
      <Field label="Default quantity"><NumInput milli={f.default_qty_milli} onChange={(m) => setF({ ...f, default_qty_milli: m })} /></Field>
      <Field label="Client-facing short description" span><input value={f.short_desc ?? ''} onChange={s('short_desc')} maxLength={500} /></Field>
      <Field label="Detailed client-facing description" span><textarea value={f.long_desc ?? ''} onChange={s('long_desc')} /></Field>
      {isPkg && <div className="span card"><h3>Package contents</h3>
        <div className="row"><Field label="Pricing"><select value={f.pkg_price_mode} onChange={s('pkg_price_mode')}><option value="fixed">Single fixed package price</option><option value="itemized">Itemized (sum of components)</option></select></Field>
          <Field label="Show to clients as"><select value={f.pkg_display} onChange={s('pkg_display')}><option value="combined">One combined line</option><option value="itemized">Each included service</option></select></Field>
          <Field label="Valid for (days)"><input inputMode="numeric" value={f.pkg_valid_days ?? ''} onChange={(e) => setF({ ...f, pkg_valid_days: e.target.value ? Number(e.target.value) : null })} /></Field>
          <Field label="Billing frequency"><input value={f.pkg_billing_frequency ?? ''} onChange={s('pkg_billing_frequency')} placeholder="monthly, one-off…" /></Field></div>
        {(f.components as any[]).map((k, i) => <div className="row" key={i} style={{ marginTop: 8 }}><Field label="Included service"><select value={k.item_id ?? ''} onChange={(e) => { const c = [...f.components]; c[i] = { ...k, item_id: Number(e.target.value) }; setF({ ...f, components: c }); }}><option value="">Choose…</option>{all?.filter((x) => x.kind !== 'package' && x.id !== item.id).map((x) => <option key={x.id} value={x.id}>{x.name} ({priceText(x)}/{x.unit})</option>)}</select></Field>
          <Field label="Quantity"><NumInput milli={k.qty_milli} onChange={(m) => { const c = [...f.components]; c[i] = { ...k, qty_milli: m }; setF({ ...f, components: c }); }} /></Field>
          <button className="btn sm fit" onClick={() => setF({ ...f, components: f.components.filter((_: any, j: number) => j !== i) })}>Remove</button></div>)}
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setF({ ...f, components: [...f.components, { item_id: '', qty_milli: 1000 }] })}>Add included service</button>
        <p className="help">Standalone total of the included services at current rates: {fmt(itemizedTotal)}{f.pkg_price_mode === 'fixed' && f.rate_cents != null ? ` → package price ${fmt(f.rate_cents)} (${itemizedTotal > f.rate_cents ? 'saves ' + fmt(itemizedTotal - f.rate_cents) : 'no saving'})` : ''}.</p></div>}
      <div className="span"><h3>Optional add-ons</h3><p className="help">Offered alongside this item (e.g. rush fee). They are priced separately and added only when chosen.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>{all?.filter((x) => x.id !== item.id && x.kind !== 'package').map((x) => <label key={x.id} style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={f.addon_ids.includes(x.id)} onChange={(e) => setF({ ...f, addon_ids: e.target.checked ? [...f.addon_ids, x.id] : f.addon_ids.filter((y: number) => y !== x.id) })} />{x.name}</label>)}</div></div>
      <label className="f span" style={{ flexDirection: 'row', gap: 8 }}><input type="checkbox" checked={adv} onChange={(e) => setAdv(e.target.checked)} /> Show scope, limits, tax and visibility options</label>
      {adv && <>
        <Field label="Minimum quantity"><NumInput milli={f.min_qty_milli ?? 0} onChange={(m) => setF({ ...f, min_qty_milli: m || null })} /></Field>
        <Field label="Minimum booking amount"><MoneyInput cents={f.min_amount_cents} onChange={(c) => setF({ ...f, min_amount_cents: c })} /></Field>
        <Field label="Duration"><input value={f.duration ?? ''} onChange={s('duration')} placeholder="e.g. 2 hours" /></Field><Field label="Delivery timeframe"><input value={f.delivery_time ?? ''} onChange={s('delivery_time')} /></Field>
        <Field label="Revisions included"><input inputMode="numeric" value={f.revisions ?? ''} onChange={s('revisions')} /></Field><Field label="Platforms"><input inputMode="numeric" value={f.platforms ?? ''} onChange={s('platforms')} /></Field><Field label="Deliverables (count)"><input inputMode="numeric" value={f.deliverable_count ?? ''} onChange={s('deliverable_count')} /></Field>
        <Field label="Included deliverables" span><textarea value={f.included ?? ''} onChange={s('included')} /></Field><Field label="Exclusions" span><textarea value={f.exclusions ?? ''} onChange={s('exclusions')} /></Field><Field label="Usage rights / scope" span><textarea value={f.usage_rights ?? ''} onChange={s('usage_rights')} /></Field>
        <Field label="Tax treatment"><select value={f.tax_mode ?? (item.tax_code_ids && item.tax_code_ids.length === 0 ? 'exempt' : 'default')} onChange={s('tax_mode')}><option value="default">Business default taxes</option><option value="exempt">Tax-exempt</option></select></Field>
        <Field label="Effective date"><input type="date" value={f.effective_date ?? ''} onChange={s('effective_date')} /></Field>
        <Field label="Status"><select value={f.status} onChange={s('status')}><option value="active">Active</option><option value="inactive">Inactive (hidden when quoting)</option><option value="archived">Archived</option></select></Field>
        <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={!!f.public_visible} onChange={(e) => setF({ ...f, public_visible: e.target.checked ? 1 : 0 })} /> Show on the client-facing rate card</label>
        <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={!!f.show_price} onChange={(e) => setF({ ...f, show_price: e.target.checked ? 1 : 0 })} /> Show the price (otherwise "Contact us")</label>
        <Field label="Internal cost (private)"><MoneyInput cents={f.cost_cents} onChange={(c) => setF({ ...f, cost_cents: c })} /></Field><Field label="Internal notes (private — never printed)" span><textarea value={f.internal_notes ?? ''} onChange={s('internal_notes')} /></Field>
        <Field label="SKU"><input value={f.sku ?? ''} onChange={s('sku')} /></Field></>}
      {item.id && <Field label="Reason for rate change (optional, kept in history)" span><input value={change} onChange={(e) => setChange(e.target.value)} /></Field>}
    </div></fieldset>
    {item.history?.length > 0 && <details style={{ marginTop: 12 }}><summary>Price history ({item.history.length})</summary><div className="tablewrap"><table><thead><tr><th>v</th><th>Date</th><th className="n">Rate</th><th>Unit</th><th>Status</th><th>Note</th></tr></thead><tbody>{item.history.map((h: any) => <tr key={h.id}><td>{h.version}</td><td>{h.changed_at}</td><td className="n">{fmt(h.rate_cents, h.currency)}</td><td>{h.unit}</td><td>{h.status}</td><td>{h.change_note}</td></tr>)}</tbody></table></div></details>}
    {error && <div className="alert bad" role="alert" style={{ marginTop: 10 }}>{error}</div>}
    {!readOnly && <div className="row" style={{ marginTop: 14 }}><button className="btn fit" onClick={onClose}>Cancel</button><button className="btn primary fit" disabled={busy || !f.name} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>}
  </Modal>;
}

function Categories({ canWrite }: { canWrite: boolean }) {
  const { b } = useBiz(); const { data, reload, error } = useFetch<any[]>(b('/ratecard/categories')); const [name, setName] = useState(''); const { busy, error: err, run } = useAction();
  return <div style={{ maxWidth: 640 }}>{canWrite && <div className="row" style={{ marginBottom: 12 }}><Field label="New category"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Video editing" /></Field><button className="btn primary fit" disabled={!name.trim() || busy} onClick={() => run(async () => { await post(b('/ratecard/categories'), { name }); setName(''); reload(); })}>Add</button></div>}
    {err && <div className="alert bad">{err}</div>}{error && <ErrorBox error={error} />}
    {data?.length === 0 ? <Empty title="No categories yet" /> : <div className="tablewrap"><table><thead><tr><th>Category</th><th className="n">Services</th><th>Order</th><th /></tr></thead><tbody>{data?.map((c) => <tr key={c.id}><td>{c.name} {c.archived ? <Badge s="archived" /> : null}</td><td className="n">{c.item_count}</td><td><input aria-label={`Order for ${c.name}`} style={{ width: 70 }} defaultValue={c.sort_order} disabled={!canWrite} onBlur={(e) => Number(e.target.value) !== c.sort_order && put(b(`/ratecard/categories/${c.id}`), { ...c, sort_order: Number(e.target.value) }).then(reload)} /></td><td>{canWrite && <button className="btn sm" onClick={() => { const n = prompt('Rename category', c.name); if (n) put(b(`/ratecard/categories/${c.id}`), { ...c, name: n }).then(reload).catch((e) => alert(e.message)); }}>Rename</button>}</td></tr>)}</tbody></table></div>}</div>;
}

// ---- Import wizard -----------------------------------------------------------------------------------------
function Import({ onDone }: { onDone: () => void }) {
  const { b } = useBiz(); const toast = useToast(); const [step, setStep] = useState<'source' | 'map' | 'review' | 'done'>('source');
  const [src, setSrc] = useState<any>({}); const [pv, setPv] = useState<any>(null); const [rows, setRows] = useState<any[]>([]); const [mapping, setMapping] = useState<any>({}); const [paste, setPaste] = useState(''); const [confirm, setConfirm] = useState(''); const [result, setResult] = useState<any>(null);
  const { busy, error, run } = useAction();
  const preview = (body: any, m?: any) => run(async () => { const r = await post(b('/ratecard/import/preview'), { ...body, mapping: m }); setPv(r); setMapping(r.mapping); setRows(r.rows.map((x: any) => ({ ...x, include: !x.issues.some((i: any) => i.level === 'error') && x.action !== 'skip' }))); setStep(r.from_text || m ? 'review' : 'map'); });
  const selected = rows.filter((r) => r.include && r.action !== 'skip');
  const blocked = selected.some((r) => r.issues.some((i: any) => i.level === 'error'));
  const setRow = (i: number, patch: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch, item: { ...r.item, ...(patch.item ?? {}) } } : r)));
  const resultCsv = () => { if (!result) return; const csv = ['row,status,name,message', ...result.results.map((r: any) => [r.row_no, r.status, JSON.stringify(r.name ?? ''), JSON.stringify(r.message ?? '')].join(','))].join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'rate-card-import-results.csv'; a.click(); };
  if (step === 'source') return <div className="grid g2"><div className="card form"><h3>Upload a file</h3><p className="help">CSV or TSV exported from Excel / Google Sheets (File → Save as CSV). Text-based PDFs are also read, with every row flagged for your review. Scanned PDFs and images need OCR, which is not built in — paste or type those.</p>
    <input type="file" accept=".csv,.tsv,.txt,.pdf,text/csv,application/pdf" aria-label="Rate card file" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const data_base64 = await fileToB64(f); setSrc({ filename: f.name, data_base64 }); preview({ filename: f.name, data_base64 }); }} />
    {error && <div className="alert bad" role="alert">{error}</div>}{busy && <Loading />}</div>
    <div className="card form"><h3>Paste text</h3><p className="help">One service per line with its price at the end, e.g. “Reel edit — $120”. Lines without a price are ignored; short lines without numbers become categories.</p>
      <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'Video editing\nReel edit ........ $120\nLong-form edit from $450'} style={{ minHeight: 160 }} /><button className="btn primary" disabled={!paste.trim() || busy} onClick={() => { setSrc({ text: paste, filename: 'pasted-text.txt' }); preview({ text: paste, mode: 'text' }); }}>Extract services</button></div>
    <div className="card" style={{ gridColumn: '1/-1' }}><p className="help">Nothing is imported until you have reviewed every row and confirmed the number of records. Nothing is rounded or guessed silently: unclear values are flagged. You can always add services manually under “Services &amp; packages”.</p></div></div>;
  if (step === 'map') return <div className="card form"><h3>Match your columns</h3><p className="help">{pv.headers.length} columns found. Pick which column holds each field.</p>
    <div className="form cols">{pv.fields.map((f: string) => <Field key={f} label={label(f)}><select value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? null : Number(e.target.value) })}><option value="">— not in file —</option>{pv.headers.map((h: string, i: number) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}</select></Field>)}</div>
    <div className="tablewrap"><table><thead><tr>{pv.headers.map((h: string, i: number) => <th key={i}>{h}</th>)}</tr></thead><tbody>{pv.sample.slice(1).map((r: string[], i: number) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
    {error && <div className="alert bad">{error}</div>}<div className="row"><button className="btn fit" onClick={() => setStep('source')}>Back</button><button className="btn primary fit" disabled={mapping.name == null || busy} onClick={() => preview(src, mapping)}>Preview rows</button></div></div>;
  if (step === 'review') return <div className="form"><div className="alert">{pv.from_text ? <strong>Extracted from text — every value below needs your review. </strong> : null}{rows.length} rows · {pv.summary.with_errors} with errors · {pv.summary.with_warnings} with warnings · {pv.summary.duplicates} possible duplicates. Fix values inline, untick rows to leave them out.</div>
    <div className="tablewrap"><table style={{ minWidth: 980 }}><thead><tr><th>Import</th><th>Row</th><th>Name</th><th>Category</th><th>Unit</th><th>Pricing</th><th>Rate</th><th>Duplicates / issues</th></tr></thead><tbody>
      {rows.map((r, i) => <tr key={i} style={{ background: r.issues.some((x: any) => x.level === 'error') ? 'var(--bad-soft)' : undefined }}>
        <td><input type="checkbox" aria-label={`Import row ${r.row_no}`} checked={r.include} onChange={(e) => setRow(i, { include: e.target.checked })} /></td><td>{r.row_no}</td>
        <td><input aria-label="Name" value={r.item.name} onChange={(e) => setRow(i, { item: { name: e.target.value } })} /></td><td><input aria-label="Category" value={r.item.category ?? ''} onChange={(e) => setRow(i, { item: { category: e.target.value || null } })} /></td>
        <td><input aria-label="Unit" list="units" style={{ width: 100 }} value={r.item.unit} onChange={(e) => setRow(i, { item: { unit: e.target.value } })} /></td>
        <td><select aria-label="Pricing" value={r.item.pricing_type} onChange={(e) => setRow(i, { item: { pricing_type: e.target.value }, issues: r.issues.filter((x: any) => !/Fixed pricing needs|ambiguous/.test(x.msg) || e.target.value === 'fixed') })}>{Object.entries(PT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
        <td style={{ minWidth: 110 }}><MoneyInput cents={r.item.rate_cents} onChange={(c) => setRow(i, { item: { rate_cents: c }, issues: c !== null ? r.issues.filter((x: any) => !/Fixed pricing needs|ambiguous|Cannot read rate|decimal/.test(x.msg)) : r.issues })} aria-label="Rate" /></td>
        <td>{r.duplicate_of && <div><Badge s="warn" text="Existing service" /> <select aria-label="Duplicate action" value={r.action} onChange={(e) => setRow(i, { action: e.target.value, update_id: e.target.value === 'update' ? r.duplicate_of.id : null, include: e.target.value !== 'skip' })}><option value="skip">Skip</option><option value="update">Update its rate</option><option value="create">Create anyway</option></select></div>}
          {r.issues.map((x: any, j: number) => <div key={j} className={x.level === 'error' ? 'err' : 'muted'} style={{ fontSize: '.82rem' }}>{x.level === 'error' ? '⛔' : '⚠'} {x.msg}</div>)}</td></tr>)}</tbody></table></div>
    <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
    <div className="card form"><p><strong>{selected.length}</strong> record(s) will be imported ({selected.filter((r) => r.action === 'update').length} updates). {blocked && <span className="err">Fix or untick rows that still show errors (⛔).</span>}</p>
      <Field label={`Type ${selected.length} to confirm`}><input value={confirm} inputMode="numeric" onChange={(e) => setConfirm(e.target.value)} /></Field>{error && <div className="alert bad">{error}</div>}
      <div className="row"><button className="btn fit" onClick={() => setStep(pv.from_text ? 'source' : 'map')}>Back</button><button className="btn primary fit" disabled={busy || blocked || !selected.length || confirm !== String(selected.length)} onClick={() => run(async () => {
        const r = await post(b('/ratecard/import/commit'), { rows: rows.filter((x) => x.include || x.action === 'skip').map((x) => ({ row_no: x.row_no, item: x.item, action: x.include ? x.action : 'skip', update_id: x.update_id })).filter((x) => x.action !== 'skip' || false).concat([]), confirm_count: selected.length, source_base64: src.data_base64, source_text: src.text, source_filename: src.filename }); setResult(r); setStep('done'); toast('Import finished'); })}>Import {selected.length} records</button></div></div></div>;
  return <div className="card form"><h3>Import finished</h3><p>{result.summary.created} created · {result.summary.updated} updated · {result.summary.errors} failed · {result.summary.skipped} skipped.</p>
    {result.results.filter((r: any) => r.status === 'error').map((r: any) => <div key={r.row_no} className="err">Row {r.row_no} ({r.name}): {r.message}</div>)}
    <p className="help">The original file was kept with the import record{result.attachment_id ? ` (attachment #${result.attachment_id})` : ''}.</p>
    <div className="row"><button className="btn fit" onClick={resultCsv}>Download results (CSV)</button><button className="btn primary fit" onClick={onDone}>View rate card</button></div></div>;
}

function Versions({ isAdmin }: { isAdmin: boolean }) {
  const { b } = useBiz(); const { data, reload } = useFetch<any[]>(b('/ratecard/versions')); const [name, setName] = useState(''); const [cmp, setCmp] = useState<any>(null); const { error, run } = useAction();
  return <div className="grid g2"><div className="card form"><h3>Rate-card versions</h3><p className="help">Take a snapshot before a price change, then compare it with the current rates. Issued quotes and invoices always keep the prices they were issued with, regardless of versions.</p>
    {isAdmin && <div className="row"><Field label="Version label"><input value={name} placeholder="e.g. 2026 rates" onChange={(e) => setName(e.target.value)} /></Field><button className="btn primary fit" disabled={!name} onClick={() => run(async () => { await post(b('/ratecard/versions'), { label: name }); setName(''); reload(); }, 'Snapshot saved')}>Save snapshot</button></div>}
    {error && <div className="alert bad">{error}</div>}
    {data?.length ? <div className="tablewrap"><table><tbody>{data.map((v) => <tr key={v.id}><td>{v.label}<div className="muted">{v.created_at} · {v.item_count} items</div></td><td><button className="btn sm" onClick={async () => setCmp({ v, diff: await get(b(`/ratecard/compare?a=${v.id}&b=current`)) })}>Compare to current</button></td></tr>)}</tbody></table></div> : <p className="muted">No snapshots yet.</p>}</div>
    <div className="card">{cmp ? <><h3>{cmp.v.label} → current</h3>{!cmp.diff.changed.length && !cmp.diff.added.length && !cmp.diff.removed.length && <p>No differences.</p>}
      {cmp.diff.changed.length > 0 && <div className="tablewrap"><table><thead><tr><th>Service</th><th className="n">Then</th><th className="n">Now</th><th className="n">Change</th></tr></thead><tbody>{cmp.diff.changed.map((c: any) => <tr key={c.id}><td>{c.name}</td><td className="n">{fmt(c.before.rate_cents)}</td><td className="n">{fmt(c.after.rate_cents)}</td><td className="n">{c.change_pct != null ? `${c.change_pct > 0 ? '+' : ''}${c.change_pct}%` : c.before.status !== c.after.status ? `${c.before.status}→${c.after.status}` : '—'}</td></tr>)}</tbody></table></div>}
      {cmp.diff.added.length > 0 && <p><strong>Added:</strong> {cmp.diff.added.map((x: any) => x.name).join(', ')}</p>}{cmp.diff.removed.length > 0 && <p><strong>Removed:</strong> {cmp.diff.removed.map((x: any) => x.name).join(', ')}</p>}</> : <p className="muted">Choose a snapshot to compare.</p>}</div></div>;
}

function Publish({ isAdmin }: { isAdmin: boolean }) {
  const { b } = useBiz(); const { data, reload } = useFetch<any>(b('/business')); const [view, setView] = useState(false); const { busy, error, run } = useAction(); const [f, setF] = useState<any>(null);
  const rc = f ?? data?.settings.rate_card; if (!rc) return <Loading />;
  return <div className="grid g2"><div className="card form"><h3>Client-facing rate card</h3><p className="help">Only active services marked “show on the client-facing rate card” are included. Internal notes, costs and margins are never printed. The look (template, logo, colour) is set in Settings → Documents.</p>
    <Field label="Title"><input value={rc.title} onChange={(e) => setF({ ...rc, title: e.target.value })} disabled={!isAdmin} /></Field><Field label="Introduction"><textarea value={rc.intro} onChange={(e) => setF({ ...rc, intro: e.target.value })} disabled={!isAdmin} /></Field>
    <Field label="Important pricing conditions"><textarea value={rc.conditions} onChange={(e) => setF({ ...rc, conditions: e.target.value })} disabled={!isAdmin} /></Field><Field label="Terms and exclusions"><textarea value={rc.terms} onChange={(e) => setF({ ...rc, terms: e.target.value })} disabled={!isAdmin} /></Field>
    <Field label="Validity (days from today)"><input inputMode="numeric" value={rc.validity_days} onChange={(e) => setF({ ...rc, validity_days: Number(e.target.value) || 1 })} disabled={!isAdmin} /></Field>
    {error && <div className="alert bad">{error}</div>}
    <div className="row">{isAdmin && <button className="btn fit" disabled={busy || !f} onClick={() => run(async () => { await put(b('/business/settings'), { rate_card: f }); setF(null); reload(); }, 'Saved')}>Save text</button>}<button className="btn primary fit" onClick={() => setView(true)}>Preview PDF</button><a className="btn fit" href={b('/ratecard/pdf?download=1')}>Download PDF</a></div></div>
    <div className="card"><h3>Share</h3><p className="help">Download the PDF and attach it to an email or message. Documents are never sent unless email is configured and you press Send.</p></div>
    {view && <PdfView url={b('/ratecard/pdf')} title="Rate card preview" onClose={() => setView(false)} />}</div>;
}
void useMemo; void fromCents; void Confirm;
