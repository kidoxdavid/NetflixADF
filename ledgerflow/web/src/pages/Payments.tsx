import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmt, newKey, post, today, useFetch } from '../api';
import { Badge, Confirm, Empty, ErrorBox, Field, Loading, Modal, MoneyInput, PageTop, PdfView, useAction, useBiz, useToast } from '../ui';

/** Record a payment (or refund). Pre-fills from an invoice when given. A fresh idempotency key makes double-clicks and retries safe. */
export function PaymentForm({ invoice, clientId, onClose, onSaved }: { invoice?: any; clientId?: number; onClose: () => void; onSaved: () => void }) {
  const { b } = useBiz(); const { data: settings } = useFetch<any>(b('/business')); const { busy, error, run } = useAction(); const [key] = useState(newKey());
  const { data: open } = useFetch<any[]>(!invoice && clientId ? b(`/invoices?client_id=${clientId}`) : null);
  const [f, setF] = useState<any>({ paid_date: today(), method: 'E-transfer', reference: '', notes: '', kind: 'payment', amount_cents: invoice ? invoice.balance_cents : null });
  const [alloc, setAlloc] = useState<Record<number, number | null>>({});
  const invoices = invoice ? [invoice] : (open ?? []).filter((d) => !['draft', 'void', 'paid', 'credited'].includes(d.display_status));
  const allocations = invoice ? [{ invoice_id: invoice.id, amount_cents: f.amount_cents }] : Object.entries(alloc).filter(([, v]) => v).map(([k, v]) => ({ invoice_id: Number(k), amount_cents: v! }));
  const sum = allocations.reduce((a: number, x: any) => a + (x.amount_cents ?? 0), 0); const cur = invoice?.currency ?? 'CAD';
  const refund = f.kind === 'refund';
  return <Modal title={refund ? 'Record refund' : 'Record payment'} onClose={onClose}><div className="form">
    <div className="alert">This records money you have <strong>actually received</strong> outside the app. Nothing is charged to anyone.</div>
    {invoice && <p>Invoice <strong>{invoice.number}</strong> · balance {fmt(invoice.balance_cents, cur)}</p>}
    <div className="row"><Field label="Amount"><MoneyInput cents={f.amount_cents} onChange={(c) => setF({ ...f, amount_cents: c })} autoFocus /></Field><Field label="Date received"><input type="date" value={f.paid_date} max={today()} onChange={(e) => setF({ ...f, paid_date: e.target.value })} /></Field></div>
    <div className="row"><Field label="Method"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{(settings?.settings.payment_methods ?? ['E-transfer', 'Bank transfer', 'Cash', 'Cheque', 'Other']).map((m: string) => <option key={m}>{m}</option>)}</select></Field><Field label="Reference (e-transfer ref, cheque no.)"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field></div>
    {!invoice && <div><h3>Apply to invoices</h3>{invoices.length === 0 ? <p className="muted">No open invoices for this client. The payment will be held on account and can be applied later.</p> : invoices.map((d) => <div className="row" key={d.id} style={{ marginTop: 6, alignItems: 'center' }}><span>{d.number} <span className="muted">balance {fmt(d.balance_cents, d.currency)}</span></span><MoneyInput aria-label={`Apply to ${d.number}`} cents={alloc[d.id] ?? null} onChange={(c) => setAlloc({ ...alloc, [d.id]: c })} /></div>)}
      <p className="help">Applied {fmt(sum, cur)} of {fmt(f.amount_cents ?? 0, cur)}.</p></div>}
    <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={refund} onChange={(e) => setF({ ...f, kind: e.target.checked ? 'refund' : 'payment' })} /> This is a refund to the client</label>
    {error && <div className="alert bad" role="alert">{error}</div>}
    <button className="btn primary" disabled={busy || !f.amount_cents || (!invoice && !clientId) || sum > (f.amount_cents ?? 0)} onClick={() => run(async () => { await post(b('/payments'), { ...f, client_id: clientId ?? invoice?.client_id, currency: cur, allocations: invoice && !f.amount_cents ? [] : allocations, idempotency_key: key }); onSaved(); }, 'Payment recorded')}>{busy ? 'Saving…' : refund ? 'Record refund' : 'Record payment'}</button></div></Modal>;
}

export function Payments() {
  const { b, canWrite, isAdmin } = useBiz(); const toast = useToast(); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [adding, setAdding] = useState(false); const [clientId, setClientId] = useState<number | ''>('');
  const { data, error, loading, reload } = useFetch<any[]>(b(`/payments?from=${from}&to=${to}`), [b]); const { data: clients } = useFetch<any[]>(b('/clients')); const [voiding, setVoiding] = useState<any>(null); const [rc, setRc] = useState<string | null>(null); const [alloc, setAlloc] = useState<any>(null);
  const act = useAction();
  return <>
    <PageTop title="Payments" sub="Money received and receipts. Entries are manual unless a payment provider verified them.">{canWrite && <button className="btn primary" onClick={() => setAdding(true)}>Record payment</button>}<a className="btn" href={b(`/reports/payments_received?format=csv&from=${from}&to=${to}`)}>Export CSV</a></PageTop>
    <div className="row" style={{ marginBottom: 12 }}><Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
    {act.error && <ErrorBox error={act.error} />}
    {error ? <ErrorBox error={error} retry={reload} /> : loading && !data ? <Loading /> : !data?.length ? <Empty title="No payments recorded">Open an invoice and choose “Record payment”.</Empty> :
      <div className="tablewrap"><table><thead><tr><th>Date</th><th>Client</th><th>Applied to</th><th>Method</th><th>Receipt</th><th className="n">Amount</th><th /></tr></thead><tbody>{data.map((p) => <tr key={p.id} style={p.voided_at ? { opacity: .55 } : undefined}>
        <td>{p.paid_date}</td><td>{p.client_name}</td><td>{p.invoices ?? <span className="muted">unapplied</span>}{p.unallocated_cents > 0 && !p.voided_at && <div><Badge s="warn" text={`${fmt(p.unallocated_cents, p.currency)} on account`} /></div>}</td>
        <td>{p.method}{p.reference ? <div className="muted">{p.reference}</div> : null} {p.kind === 'refund' && <Badge s="bad" text="refund" />} {p.voided_at && <Badge s="void" />} {p.verification === 'manual' ? <span className="muted" title="Recorded by you; not verified by a payment provider">· manual</span> : <Badge s="ok" text="provider-verified" />}</td>
        <td>{p.receipt_number}</td><td className="n" style={{ color: p.amount_cents < 0 ? 'var(--bad)' : undefined }}>{fmt(p.amount_cents, p.currency)}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{!p.voided_at && <button className="btn sm" onClick={() => setRc(b(`/payments/${p.id}/receipt`))}>Receipt</button>} {!p.voided_at && canWrite && p.unallocated_cents > 0 && <button className="btn sm" onClick={() => setAlloc(p)}>Apply</button>} {isAdmin && !p.voided_at && <button className="btn sm danger" onClick={() => setVoiding(p)}>Void</button>}</td></tr>)}</tbody></table></div>}
    {adding && (clientId ? <PaymentForm clientId={Number(clientId)} onClose={() => { setAdding(false); setClientId(''); }} onSaved={() => { setAdding(false); setClientId(''); reload(); }} /> :
      <Modal title="Record payment" onClose={() => setAdding(false)}><Field label="Which client paid?"><select autoFocus value="" onChange={(e) => setClientId(Number(e.target.value))}><option value="">Choose a client…</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.outstanding_cents ? ` — owes ${fmt(c.outstanding_cents)}` : ''}</option>)}</select></Field></Modal>)}
    {voiding && <Confirm title={`Void payment ${voiding.receipt_number}?`} danger reason yes="Void payment" text="The payment stays on record as void, and the invoice balance is restored. Use this for mistakes or bounced payments." onNo={() => setVoiding(null)} onYes={(reason) => act.run(async () => { await post(b(`/payments/${voiding.id}/void`), { reason }); setVoiding(null); reload(); }, 'Payment voided')} />}
    {rc && <PdfView url={rc} title="Receipt" onClose={() => setRc(null)} />}
    {alloc && <ApplyForm p={alloc} onClose={() => setAlloc(null)} onDone={() => { setAlloc(null); reload(); toast('Applied'); }} />}
  </>;
}
function ApplyForm({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const { b } = useBiz(); const { data } = useFetch<any[]>(b(`/invoices?client_id=${p.client_id}`)); const { busy, error, run } = useAction(); const [inv, setInv] = useState(''); const [amt, setAmt] = useState<number | null>(p.unallocated_cents);
  const open = (data ?? []).filter((d) => !['draft', 'void', 'paid', 'credited'].includes(d.display_status));
  return <Modal title="Apply unallocated payment" onClose={onClose}><div className="form"><p>{fmt(p.unallocated_cents, p.currency)} is held on account.</p><Field label="Invoice"><select value={inv} onChange={(e) => { setInv(e.target.value); const d = open.find((x) => x.id === Number(e.target.value)); if (d) setAmt(Math.min(p.unallocated_cents, d.balance_cents)); }}><option value="">Choose…</option>{open.map((d) => <option key={d.id} value={d.id}>{d.number} — balance {fmt(d.balance_cents, d.currency)}</option>)}</select></Field>
    <Field label="Amount"><MoneyInput cents={amt} onChange={setAmt} /></Field>{error && <div className="alert bad">{error}</div>}<button className="btn primary" disabled={!inv || !amt || busy} onClick={() => run(async () => { await post(b(`/payments/${p.id}/allocate`), { invoice_id: Number(inv), amount_cents: amt }); onDone(); })}>Apply</button></div></Modal>;
}
void Link;
