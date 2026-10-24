import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { fmt, useFetch, today } from '../api';
import { useBiz, PageTop, Loading, ErrorBox, Empty, Field } from '../ui';

export function Dashboard() {
  const { b, biz, canWrite } = useBiz(); const nav = useNavigate();
  const y = today().slice(0, 4); const [from, setFrom] = useState(`${y}-01-01`); const [to, setTo] = useState(today());
  const { data, error, loading, reload } = useFetch<any>(b(`/dashboard?from=${from}&to=${to}`), [b]);
  const { data: items } = useFetch<any[]>(b('/ratecard/items?status=all'));
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const cur = data.currencies.length ? data.currencies : [{ currency: biz.currency, invoiced_cents: 0, invoiced_net_cents: 0, received_cents: 0, expenses_cents: 0, cash_minus_expenses_cents: 0, outstanding_cents: 0, outstanding_count: 0, overdue_cents: 0, overdue_count: 0, upcoming_cents: 0, upcoming_count: 0, expense_tax_cents: 0 }];
  return <>
    <PageTop title="Dashboard" sub={`${biz.trading_name || biz.legal_name} · ${data.period.from} → ${data.period.to}`}>
      {canWrite && <><Link className="btn" to="/quotes/new">New quote</Link><Link className="btn primary" to="/invoices/new">New invoice</Link></>}</PageTop>
    {items && items.length === 0 && <div className="alert warn" style={{ marginBottom: 16 }}><strong>Your rate card is empty.</strong> Import your existing rates or add services so quotes and invoices can use them. <button className="btn sm" onClick={() => nav('/ratecard')}>Open Rate Card</button></div>}
    <div className="row" style={{ marginBottom: 16 }}><Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
    {cur.map((c: any) => <section key={c.currency} style={{ marginBottom: 24 }} aria-label={`${c.currency} figures`}>
      {cur.length > 1 && <h2 style={{ marginBottom: 8 }}>{c.currency}</h2>}
      <div className="grid g4">
        <Stat k="Invoiced" v={fmt(c.invoiced_cents, c.currency)} s={`${fmt(c.invoiced_net_cents, c.currency)} before tax`} />
        <Stat k="Received" v={fmt(c.received_cents, c.currency)} s="Cash you recorded" />
        <Stat k="Outstanding" v={fmt(c.outstanding_cents, c.currency)} s={`${c.outstanding_count} open invoice${c.outstanding_count === 1 ? '' : 's'}`} />
        <Stat k="Overdue" v={fmt(c.overdue_cents, c.currency)} s={`${c.overdue_count} past due`} tone={c.overdue_cents ? 'bad' : undefined} />
        <Stat k="Due in next 30 days" v={fmt(c.upcoming_cents, c.currency)} s={`${c.upcoming_count} invoice${c.upcoming_count === 1 ? '' : 's'}`} />
        <Stat k="Expenses recorded" v={fmt(c.expenses_cents, c.currency)} s={`incl. ${fmt(c.expense_tax_cents, c.currency)} tax`} />
        <Stat k="Cash received − expenses" v={fmt(c.cash_minus_expenses_cents, c.currency)} s="Not a profit figure" />
      </div></section>)}
    <div className="grid g2">
      <div className="card"><h2 style={{ marginBottom: 10 }}>Next payments due</h2>{data.upcoming.length === 0 ? <p className="muted">Nothing outstanding.</p> :
        <div className="tablewrap"><table><tbody>{data.upcoming.map((u: any) => <tr key={u.id} className="click" onClick={() => nav(`/documents/${u.id}`)}><td><Link to={`/documents/${u.id}`}>{u.number}</Link><div className="muted">{u.client_name}</div></td><td>{u.due_date}</td><td className="n">{fmt(u.balance_cents, u.currency)}</td></tr>)}</tbody></table></div>}</div>
      <div className="card"><h2 style={{ marginBottom: 10 }}>To do</h2><ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>{data.drafts.invoices} draft invoice(s), {data.drafts.estimates} draft quote(s)</li><li>{data.estimates_awaiting_response} quote(s) awaiting a response</li></ul>
        <h2 style={{ margin: '18px 0 8px' }}>Recent activity</h2>{data.recent.length === 0 ? <p className="muted">No activity yet.</p> : <ul style={{ margin: 0, paddingLeft: 18 }}>{data.recent.map((r: any) => <li key={r.id}>{r.entity.replace('_', ' ')} · {r.action.replace(/_/g, ' ')} <span className="muted">{r.created_at}</span></li>)}</ul>}</div>
    </div>
    <ul className="help" style={{ marginTop: 20 }}>{data.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
    {data.currencies.length === 0 && <Empty title="No activity in this period">Create a quote or invoice to see your numbers here.</Empty>}
  </>;
}
const Stat = ({ k, v, s, tone }: { k: string; v: string; s?: string; tone?: string }) => <div className="card stat"><div className="k">{k}</div><div className="v" style={tone ? { color: 'var(--bad)' } : undefined}>{v}</div><div className="s">{s}</div></div>;
