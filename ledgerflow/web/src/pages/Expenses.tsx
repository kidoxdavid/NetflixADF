import { useState } from 'react';
import { del, fileToB64, fmt, post, put, today, useFetch, get } from '../api';
import { Badge, Confirm, Empty, ErrorBox, Field, Loading, Modal, MoneyInput, PageTop, useAction, useBiz, useToast } from '../ui';

export function Expenses() {
  const { b, canWrite } = useBiz(); const toast = useToast(); const [q, setQ] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [edit, setEdit] = useState<any>(null); const [rm, setRm] = useState<any>(null);
  const { data, error, loading, reload } = useFetch<any[]>(b(`/expenses?search=${encodeURIComponent(q)}&from=${from}&to=${to}`), [b]); const act = useAction();
  const total = (data ?? []).reduce((a, e) => a + e.amount_cents, 0);
  return <>
    <PageTop title="Expenses" sub="Business costs, receipts and billable items">{canWrite && <button className="btn primary" onClick={() => setEdit({})}>Add expense</button>}<a className="btn" href={b('/reports/expenses_by_category?format=csv')}>Export by category</a></PageTop>
    <div className="row" style={{ marginBottom: 12 }}><Field label="Search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} /></Field><Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
    {act.error && <ErrorBox error={act.error} />}
    {error ? <ErrorBox error={error} retry={reload} /> : loading && !data ? <Loading /> : !data?.length ? <Empty title="No expenses recorded" /> :
      <><p className="muted">{data.length} expense(s) · total {fmt(total)} (mixed currencies are not summed — see Reports)</p><div className="tablewrap"><table><thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th>Client / project</th><th className="n">Amount</th><th className="n">Tax</th><th /></tr></thead><tbody>{data.map((e) => <tr key={e.id}><td>{e.expense_date}</td><td>{e.merchant}<div className="muted">{e.description}</div></td><td>{e.category_name}</td>
        <td>{e.client_name}{e.project_name ? ` · ${e.project_name}` : ''} {e.billable ? (e.invoice_number ? <Badge s="ok" text={`invoiced ${e.invoice_number}`} /> : <Badge s="warn" text="billable — not invoiced" />) : null}{e.attachment_count > 0 && <span title="Receipt attached"> 📎</span>}</td>
        <td className="n">{fmt(e.amount_cents, e.currency)}</td><td className="n">{fmt(e.tax_cents, e.currency)}</td><td style={{ whiteSpace: 'nowrap' }}>{canWrite && !e.invoice_number && <><button className="btn sm" onClick={() => setEdit(e)}>Edit</button> <button className="btn sm danger" onClick={() => setRm(e)}>Delete</button></>}</td></tr>)}</tbody></table></div></>}
    {edit && <ExpenseForm exp={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); toast('Expense saved'); }} />}
    {rm && <Confirm title="Delete expense?" danger yes="Delete" text="This removes the expense and its receipts. It is recorded in the audit log." onNo={() => setRm(null)} onYes={() => act.run(async () => { await del(b(`/expenses/${rm.id}`)); setRm(null); reload(); }, 'Deleted')} />}
  </>;
}
function ExpenseForm({ exp, onClose, onSaved }: { exp: any; onClose: () => void; onSaved: () => void }) {
  const { b, biz } = useBiz(); const { busy, error, run } = useAction(); const { data: cats } = useFetch<any[]>(b('/expense-categories')); const { data: clients } = useFetch<any[]>(b('/clients')); const { data: att, reload } = useFetch<any[]>(exp.id ? b(`/expenses/${exp.id}/attachments`) : null);
  const { data: projects } = useFetch<any[]>(b('/projects')); const [f, setF] = useState<any>({ expense_date: today(), currency: biz.currency, amount_cents: null, tax_cents: 0, billable: 0, reimbursement_status: 'none', ...exp }); const [file, setFile] = useState<File | null>(null);
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <Modal title={exp.id ? 'Edit expense' : 'New expense'} onClose={onClose} wide><div className="form cols">
    <Field label="Date"><input type="date" value={f.expense_date} onChange={s('expense_date')} /></Field><Field label="Merchant"><input value={f.merchant ?? ''} onChange={s('merchant')} autoFocus /></Field>
    <Field label="Description" span><input value={f.description ?? ''} onChange={s('description')} /></Field>
    <Field label="Category"><select value={f.category_id ?? ''} onChange={s('category_id')}><option value="">Uncategorised</option>{cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <Field label="Total amount (incl. tax)"><MoneyInput cents={f.amount_cents} onChange={(c) => setF({ ...f, amount_cents: c })} /></Field><Field label="of which tax paid"><MoneyInput cents={f.tax_cents} onChange={(c) => setF({ ...f, tax_cents: c ?? 0 })} /></Field>
    <Field label="Currency"><input maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field><Field label="Payment method"><input value={f.payment_method ?? ''} onChange={s('payment_method')} placeholder="Visa ****1234" /></Field>
    <Field label="Client"><select value={f.client_id ?? ''} onChange={(e) => setF({ ...f, client_id: e.target.value ? Number(e.target.value) : null, project_id: null })}><option value="">None</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <Field label="Project"><select value={f.project_id ?? ''} onChange={(e) => setF({ ...f, project_id: e.target.value ? Number(e.target.value) : null })}><option value="">None</option>{projects?.filter((p) => !f.client_id || p.client_id === f.client_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={!!f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked ? 1 : 0 })} /> Billable to the client (needs a client)</label>
    {!!f.billable && <Field label="Markup %" help="Optional; billed amount = pre-tax cost + markup"><input inputMode="decimal" value={(f.billable_markup_milli ?? 0) / 1000} onChange={(e) => setF({ ...f, billable_markup_milli: Math.round(Number(e.target.value || 0) * 1000) })} /></Field>}
    <Field label="Reimbursement"><select value={f.reimbursement_status} onChange={s('reimbursement_status')}><option value="none">Not applicable</option><option value="pending">Owed to me</option><option value="reimbursed">Reimbursed</option></select></Field>
    <Field label="Notes" span><input value={f.notes ?? ''} onChange={s('notes')} /></Field>
    <div className="span"><h3>Receipts</h3>{att?.map((a) => <p key={a.id} style={{ margin: '4px 0' }}><a href={b(`/attachments/${a.id}`)}>{a.filename}</a> <button className="btn sm ghost" onClick={() => del(b(`/attachments/${a.id}`)).then(reload)}>remove</button></p>)}
      <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" aria-label="Receipt file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><p className="help">PDF, PNG, JPEG or WebP up to 8 MB. Files are checked by content, not just by name. Amounts are never read from receipts automatically — enter them yourself.</p></div>
    {error && <div className="alert bad span" role="alert">{error}</div>}
    <div className="row span"><button className="btn fit" onClick={onClose}>Cancel</button><button className="btn primary fit" disabled={busy || f.amount_cents === null || !f.expense_date} onClick={() => run(async () => {
      const body = { ...f, category_id: f.category_id || null }; const id = exp.id ? (await put(b(`/expenses/${exp.id}`), body)).id : (await post(b('/expenses'), body)).id;
      if (file) await post(b(`/expenses/${id}/attachments`), { filename: file.name, data_base64: await fileToB64(file) }); onSaved(); })}>Save expense</button></div></div></Modal>;
}
void get;
