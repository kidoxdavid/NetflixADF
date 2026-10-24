import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, fmt, fromCents, post, put, toCents, useFetch, label } from '../api';
import { Badge, Confirm, Empty, ErrorBox, Field, Loading, Modal, MoneyInput, PageTop, Tabs, useAction, useBiz, useToast } from '../ui';

export function Clients() {
  const { b, canWrite } = useBiz(); const nav = useNavigate(); const [q, setQ] = useState(''); const [arch, setArch] = useState(false); const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useFetch<any[]>(b(`/clients?search=${encodeURIComponent(q)}&archived=${arch ? '1' : '0'}`), [b]);
  return <>
    <PageTop title="Clients" sub="Everyone you bill, with their balances and agreements">{canWrite && <button className="btn primary" onClick={() => setAdding(true)}>Add client</button>}<a className="btn" href={b('/clients/export.csv')}>Export CSV</a></PageTop>
    <div className="row" style={{ marginBottom: 12 }}><Field label="Search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, company, email or tag" /></Field><label className="fit" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={arch} onChange={(e) => setArch(e.target.checked)} /> Show archived</label></div>
    {error ? <ErrorBox error={error} retry={reload} /> : loading && !data ? <Loading /> : !data?.length ? <Empty title="No clients yet">Add your first client to start quoting.</Empty> :
      <div className="tablewrap"><table><thead><tr><th>Client</th><th>Contact</th><th>Tags</th><th className="n">Invoiced</th><th className="n">Outstanding</th></tr></thead><tbody>
        {data.map((c) => <tr key={c.id} className="click" onClick={() => nav(`/clients/${c.id}`)}><td><Link to={`/clients/${c.id}`}>{c.name}</Link>{c.company && <div className="muted">{c.company}</div>}</td><td>{c.email}<div className="muted">{c.phone}</div></td><td>{c.tags.map((t: string) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>)}</td><td className="n">{fmt(c.invoiced_cents, c.currency ?? 'CAD')}</td><td className="n">{c.outstanding_cents ? <strong>{fmt(c.outstanding_cents, c.currency ?? 'CAD')}</strong> : '—'}</td></tr>)}</tbody></table></div>}
    {adding && <ClientForm onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); nav(`/clients/${id}`); }} />}
  </>;
}

export function ClientForm({ client, onClose, onSaved }: { client?: any; onClose: () => void; onSaved: (id: number) => void }) {
  const { b } = useBiz(); const { busy, error, run } = useAction();
  const [f, setF] = useState<any>(client ? { ...client, tags: (client.tags ?? []).join(', '), contacts: client.contacts ?? [] } : { type: 'business', name: '', company: '', email: '', phone: '', billing_address: '', service_address: '', currency: '', payment_terms_days: '', tax_exempt: false, tax_exempt_note: '', notes: '', tags: '', contacts: [] });
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = () => run(async () => {
    const body = { ...f, currency: f.currency || null, payment_terms_days: f.payment_terms_days === '' || f.payment_terms_days == null ? null : Number(f.payment_terms_days), tags: String(f.tags).split(',').map((t) => t.trim()).filter(Boolean) };
    const r = client ? await put(b(`/clients/${client.id}`), body) : await post(b('/clients'), body); onSaved(r.id);
  }, 'Client saved');
  return <Modal title={client ? 'Edit client' : 'New client'} onClose={onClose} wide><div className="form cols">
    <Field label="Type"><select value={f.type} onChange={s('type')}><option value="business">Business</option><option value="individual">Individual</option></select></Field>
    <Field label="Name"><input value={f.name} onChange={s('name')} autoFocus /></Field><Field label="Company"><input value={f.company ?? ''} onChange={s('company')} /></Field>
    <Field label="Email"><input type="email" value={f.email ?? ''} onChange={s('email')} /></Field><Field label="Phone"><input value={f.phone ?? ''} onChange={s('phone')} /></Field>
    <Field label="Billing address" span><textarea value={f.billing_address ?? ''} onChange={s('billing_address')} /></Field><Field label="Service address" span><textarea value={f.service_address ?? ''} onChange={s('service_address')} /></Field>
    <Field label="Currency (blank = business default)"><input maxLength={3} value={f.currency ?? ''} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
    <Field label="Payment terms (days)" help="Blank uses the business default"><input inputMode="numeric" value={f.payment_terms_days ?? ''} onChange={s('payment_terms_days')} /></Field>
    <Field label="Tags (comma separated)"><input value={f.tags} onChange={s('tags')} /></Field>
    <label className="f span" style={{ flexDirection: 'row', gap: 8 }}><input type="checkbox" checked={!!f.tax_exempt} onChange={(e) => setF({ ...f, tax_exempt: e.target.checked })} /> Tax exempt client</label>
    {f.tax_exempt && <Field label="Exemption details" span help="Status card number, certificate, etc. Printed on documents."><input value={f.tax_exempt_note ?? ''} onChange={s('tax_exempt_note')} /></Field>}
    <div className="span"><h3>Contacts</h3>{f.contacts.map((k: any, i: number) => <div className="row" key={i} style={{ marginTop: 6 }}><input aria-label="Contact name" placeholder="Name" value={k.name} onChange={(e) => { const c = [...f.contacts]; c[i] = { ...k, name: e.target.value }; setF({ ...f, contacts: c }); }} /><input aria-label="Contact email" placeholder="Email" value={k.email ?? ''} onChange={(e) => { const c = [...f.contacts]; c[i] = { ...k, email: e.target.value }; setF({ ...f, contacts: c }); }} /><input aria-label="Contact phone" placeholder="Phone" value={k.phone ?? ''} onChange={(e) => { const c = [...f.contacts]; c[i] = { ...k, phone: e.target.value }; setF({ ...f, contacts: c }); }} /><button className="btn sm fit" onClick={() => setF({ ...f, contacts: f.contacts.filter((_: any, j: number) => j !== i) })}>Remove</button></div>)}
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setF({ ...f, contacts: [...f.contacts, { name: '', email: '', phone: '' }] })}>Add contact</button></div>
    <Field label="Internal notes" span><textarea value={f.notes ?? ''} onChange={s('notes')} /></Field>
    {client && <label className="f span" style={{ flexDirection: 'row', gap: 8 }}><input type="checkbox" checked={!!f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> Archived (hidden from lists and new documents)</label>}
    {error && <div className="alert bad span" role="alert">{error}</div>}
    <div className="row span"><button className="btn fit" onClick={onClose}>Cancel</button><button className="btn primary fit" disabled={busy || !f.name.trim()} onClick={save}>Save client</button></div></div></Modal>;
}

export function ClientDetail() {
  const { id } = useParams(); const { b, canWrite } = useBiz(); const nav = useNavigate();
  const { data: c, error, loading, reload } = useFetch<any>(b(`/clients/${id}`), [id]); const [tab, setTab] = useState('overview'); const [edit, setEdit] = useState(false); const [price, setPrice] = useState<any>(null);
  if (error) return <ErrorBox error={error} retry={reload} />; if (loading || !c) return <Loading />;
  return <>
    <PageTop title={c.name} sub={<>{c.company} {c.archived ? <Badge s="archived" /> : null} {c.tags.map((t: string) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>)}</>}>
      {canWrite && <><button className="btn" onClick={() => setEdit(true)}>Edit</button><Link className="btn" to={`/quotes/new?client=${c.id}`}>New quote</Link><Link className="btn primary" to={`/invoices/new?client=${c.id}`}>New invoice</Link></>}</PageTop>
    <div className="grid g3" style={{ marginBottom: 16 }}>{c.totals.length ? c.totals.map((t: any) => <div className="card stat" key={t.currency}><div className="k">Outstanding ({t.currency})</div><div className="v">{fmt(t.outstanding_cents, t.currency)}</div><div className="s">Invoiced {fmt(t.invoiced_cents, t.currency)} · paid {fmt(t.paid_cents, t.currency)}</div></div>) : <div className="card stat"><div className="k">Outstanding</div><div className="v">$0.00</div></div>}
      <div className="card"><div className="k muted">Contact</div>{c.email}<br />{c.phone}<br /><span className="muted" style={{ whiteSpace: 'pre-line' }}>{c.billing_address}</span></div></div>
    <Tabs value={tab} onChange={setTab} tabs={[['overview', 'Overview'], ['docs', `Quotes & invoices (${c.estimates.length + c.invoices.length})`], ['prices', `Agreed rates (${c.prices.filter((p: any) => p.active).length})`], ['payments', 'Payments'], ['projects', 'Projects & expenses']]} />
    {tab === 'overview' && <div className="grid g2"><div className="card"><h3>Details</h3><p>Payment terms: {c.payment_terms_days ?? 'business default'} days · Currency: {c.currency ?? 'business default'}{c.tax_exempt ? <><br /><Badge s="warn" text="Tax exempt" /> {c.tax_exempt_note}</> : null}</p>{c.contacts.map((k: any) => <p key={k.id} className="muted" style={{ margin: 0 }}>{k.name}{k.role ? ` (${k.role})` : ''} · {k.email} {k.phone}</p>)}{c.notes && <p style={{ whiteSpace: 'pre-line' }}>{c.notes}</p>}</div>
      <div className="card"><h3>Recent activity</h3>{c.activity.length ? <ul style={{ paddingLeft: 18 }}>{c.activity.map((a: any, i: number) => <li key={i}>{a.entity} {a.action.replace(/_/g, ' ')} <span className="muted">{a.created_at}</span></li>)}</ul> : <p className="muted">No activity yet.</p>}</div></div>}
    {tab === 'docs' && <div className="tablewrap"><table><thead><tr><th>Document</th><th>Status</th><th>Date</th><th className="n">Total</th><th className="n">Balance</th></tr></thead><tbody>
      {[...c.invoices.map((d: any) => ({ ...d, kind: 'Invoice' })), ...c.estimates.map((d: any) => ({ ...d, kind: 'Quote', display_status: d.status }))].map((d: any) => <tr key={d.kind + d.id} className="click" onClick={() => nav(`/documents/${d.id}`)}><td>{d.kind} {d.number ?? '(draft)'}<div className="muted">{d.title}</div></td><td><Badge s={d.display_status} /></td><td>{d.issue_date}</td><td className="n">{fmt(d.total_cents, d.currency)}</td><td className="n">{d.kind === 'Invoice' && d.status !== 'draft' ? fmt(d.balance_cents, d.currency) : ''}</td></tr>)}</tbody></table></div>}
    {tab === 'prices' && <div><p className="help">Negotiated rates apply only to this client and never change your standard rate card. They are shown next to the standard rate on quotes.</p>{canWrite && <button className="btn primary" style={{ margin: '8px 0' }} onClick={() => setPrice({})}>Add agreed rate</button>}
      {c.prices.length === 0 ? <Empty title="No client-specific rates" /> : <div className="tablewrap"><table><thead><tr><th>Service</th><th className="n">Standard</th><th className="n">Agreed</th><th>Valid</th><th>Note</th><th /></tr></thead><tbody>{c.prices.map((p: any) => <tr key={p.id}><td>{p.item_name}<div className="muted">per {p.unit}</div></td><td className="n">{fmt(p.standard_rate_cents)}</td><td className="n"><strong>{fmt(p.rate_cents)}</strong></td><td>{p.valid_from ?? '…'} → {p.valid_to ?? '…'} {!p.active && <Badge s="inactive" />}</td><td>{p.note}</td><td>{canWrite && <button className="btn sm" onClick={() => setPrice(p)}>Edit</button>}</td></tr>)}</tbody></table></div>}</div>}
    {tab === 'payments' && (c.payments.length === 0 ? <Empty title="No payments recorded" /> : <div className="tablewrap"><table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Receipt</th><th className="n">Amount</th></tr></thead><tbody>{c.payments.map((p: any) => <tr key={p.id}><td>{p.paid_date}</td><td>{p.method} {p.voided_at && <Badge s="void" />}</td><td>{p.reference}</td><td>{p.receipt_number && <a href={b(`/payments/${p.id}/receipt`)} target="_blank" rel="noreferrer">{p.receipt_number}</a>}</td><td className="n">{fmt(p.amount_cents, p.currency)}</td></tr>)}</tbody></table></div>)}
    {tab === 'projects' && <div className="grid g2"><div className="card"><h3>Projects</h3>{c.projects.length ? c.projects.map((p: any) => <p key={p.id} style={{ margin: '6px 0' }}><Link to={`/projects/${p.id}`}>{p.name}</Link> <Badge s={p.status} /></p>) : <p className="muted">None</p>}</div><div className="card"><h3>Expenses</h3>{c.expenses.length ? c.expenses.map((e: any) => <p key={e.id} style={{ margin: '6px 0' }}>{e.expense_date} · {e.merchant ?? e.description} · {fmt(e.amount_cents, e.currency)} {e.billable ? <Badge s="active" text="billable" /> : null}</p>) : <p className="muted">None</p>}</div></div>}
    {edit && <ClientForm client={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />}
    {price && <PriceForm clientId={c.id} price={price} onClose={() => setPrice(null)} onSaved={() => { setPrice(null); reload(); }} />}
  </>;
}

function PriceForm({ clientId, price, onClose, onSaved }: { clientId: number; price: any; onClose: () => void; onSaved: () => void }) {
  const { b } = useBiz(); const { busy, error, run } = useAction(); const { data: items } = useFetch<any[]>(b('/ratecard/items'));
  const [f, setF] = useState({ item_id: price.item_id ?? '', rate_cents: price.rate_cents ?? null, note: price.note ?? '', valid_from: price.valid_from ?? '', valid_to: price.valid_to ?? '', active: price.active ?? 1 });
  const std = items?.find((i) => i.id === Number(f.item_id));
  return <Modal title={price.id ? 'Edit agreed rate' : 'New agreed rate'} onClose={onClose}><div className="form">
    <Field label="Service"><select value={f.item_id} disabled={!!price.id} onChange={(e) => setF({ ...f, item_id: e.target.value })}><option value="">Choose…</option>{items?.map((i) => <option key={i.id} value={i.id}>{i.name} (per {i.unit})</option>)}</select></Field>
    {std && <p className="help">Standard rate: {fmt(std.rate_cents)} per {std.unit}</p>}
    <Field label="Agreed rate"><MoneyInput cents={f.rate_cents} onChange={(c) => setF({ ...f, rate_cents: c })} /></Field>
    <div className="row"><Field label="Valid from"><input type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} /></Field><Field label="Valid to"><input type="date" value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} /></Field></div>
    <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. 12-month retainer agreement" /></Field>
    {price.id && <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} /> Active</label>}
    {error && <div className="alert bad" role="alert">{error}</div>}
    <button className="btn primary" disabled={busy || !f.item_id || f.rate_cents === null} onClick={() => run(async () => { const body = { ...f, valid_from: f.valid_from || null, valid_to: f.valid_to || null }; price.id ? await put(b(`/clients/${clientId}/prices/${price.id}`), body) : await post(b(`/clients/${clientId}/prices`), body); onSaved(); }, 'Agreed rate saved')}>Save</button></div></Modal>;
}
void del; void fromCents; void toCents; void label; void Confirm; void useToast;
