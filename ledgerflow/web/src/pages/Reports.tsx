import { useState } from 'react';
import { fmt, label, useFetch, today } from '../api';
import { EmptyOr, ErrorBox, Field, Loading, PageTop, useBiz } from '../ui';

const NAMES: Record<string, string> = { revenue_by_period: 'Revenue by period', revenue_by_client: 'Revenue by client', revenue_by_service: 'Revenue by service', revenue_by_category: 'Revenue by rate-card category', revenue_by_project: 'Revenue by project', outstanding: 'Outstanding invoices', aging: 'Invoice aging', expenses_by_category: 'Expenses by category', billable_expenses: 'Billable vs non-billable expenses', tax_collected: 'Tax collected by period', tax_transactions: 'Tax transactions (detail)', payments_received: 'Payments received', recurring_vs_oneoff: 'Recurring vs one-off income', project_budgets: 'Project budgets vs costs' };
export function Reports() {
  const { b } = useBiz(); const [name, setName] = useState('revenue_by_period'); const y = today().slice(0, 4); const [from, setFrom] = useState(`${y}-01-01`); const [to, setTo] = useState(today()); const [client, setClient] = useState(''); const [cur, setCur] = useState('');
  const { data: clients } = useFetch<any[]>(b('/clients')); const qs = `from=${from}&to=${to}${client ? `&client_id=${client}` : ''}${cur ? `&currency=${cur}` : ''}`;
  const { data: r, error, loading, reload } = useFetch<any>(b(`/reports/${name}?${qs}`), [b, name, qs]);
  return <><PageTop title="Reports" sub="Figures are never added across currencies. Cash-based figures are not a profit statement.">
    <a className="btn" href={b(`/reports/${name}?${qs}&format=csv`)}>Export CSV</a><a className="btn" href={b(`/reports/${name}?${qs}&format=pdf`)}>PDF</a><a className="btn" href={b('/export/business.zip')}>Export all data (ZIP)</a></PageTop>
    <div className="row" style={{ marginBottom: 14 }}><Field label="Report"><select value={name} onChange={(e) => setName(e.target.value)}>{Object.entries(NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Client"><select value={client} onChange={(e) => setClient(e.target.value)}><option value="">All</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Currency"><input maxLength={3} placeholder="All" value={cur} onChange={(e) => setCur(e.target.value.toUpperCase())} /></Field></div>
    {error ? <ErrorBox error={error} retry={reload} /> : loading && !r ? <Loading /> : r && <>
      <h2 style={{ marginBottom: 8 }}>{r.title}</h2>
      {r.rows.length === 0 ? <div className="empty card"><h3>No data</h3>Nothing matches these filters.</div> : <div className="tablewrap"><table><thead><tr>{r.columns.map((c: any) => <th key={c.key} className={c.type === 'text' || c.type === 'date' ? '' : 'n'}>{c.label}</th>)}</tr></thead><tbody>{r.rows.map((row: any, i: number) => <tr key={i}>{r.columns.map((c: any) => <td key={c.key} className={c.type === 'text' || c.type === 'date' ? '' : 'n'}>{row[c.key] == null ? '' : c.type === 'money' ? fmt(row[c.key], row.currency ?? 'CAD') : c.type === 'pct' ? `${row[c.key]}%` : c.type === 'int' ? String(Math.round(row[c.key] * 1000) / 1000) : String(row[c.key])}</td>)}</tr>)}</tbody></table></div>}
      <ul className="help" style={{ marginTop: 12 }}>{r.notes.map((n: string) => <li key={n}>{n}</li>)}</ul></>}</>;
}
void label; void EmptyOr;
