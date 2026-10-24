import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes, Navigate, useNavigate, useLocation } from 'react-router-dom';
import './styles.css';
import { get, post } from './api';
import { ToastCtx, BizCtx, type Biz } from './ui';
import { Auth } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { Clients, ClientDetail } from './pages/Clients';
import { RateCard } from './pages/RateCard';
import { Documents, DocumentView } from './pages/Documents';
import { DocEditor } from './pages/DocEditor';
import { Payments } from './pages/Payments';
import { Expenses } from './pages/Expenses';
import { Projects, ProjectDetail } from './pages/Projects';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Recurring } from './pages/Recurring';
import { PublicDoc } from './pages/PublicDoc';
import { Onboarding } from './pages/Onboarding';

const NAV: [string, string, string][] = [['/', 'Dashboard', '◧'], ['/clients', 'Clients', '☺'], ['/ratecard', 'Rate Card', '☰'], ['/projects', 'Projects', '▤'], ['/quotes', 'Quotes', '✎'], ['/invoices', 'Invoices', '▥'], ['/payments', 'Payments', '＄'], ['/expenses', 'Expenses', '▾'], ['/recurring', 'Recurring', '↻'], ['/reports', 'Reports', '▦'], ['/settings', 'Settings', '⚙']];

function Shell({ user, businesses, onSignOut, refresh }: { user: any; businesses: Biz[]; onSignOut: () => void; refresh: () => void }) {
  const [bid, setBid] = useState<number>(() => Number(localStorage.getItem('lf_bid')) || businesses[0]?.id);
  const [open, setOpen] = useState(false); const [creating, setCreating] = useState(false); const loc = useLocation(); const nav = useNavigate();
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('lf_theme') || ''; } catch { return ''; } });
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; try { localStorage.setItem('lf_theme', theme); } catch { /* ignore */ } }, [theme]);
  const biz = businesses.find((b) => b.id === bid) ?? businesses[0];
  if (!biz || creating) return <Onboarding onDone={() => { setCreating(false); refresh(); }} onCancel={biz ? () => setCreating(false) : undefined} />;
  const ctx = { biz, bid: biz.id, b: (p: string) => `/api/b/${biz.id}${p}`, canWrite: biz.role !== 'viewer', isAdmin: ['owner', 'admin'].includes(biz.role) };
  return <BizCtx.Provider value={ctx}>
    <a href="#main" className="skip">Skip to content</a>
    <div className="app">
      <nav className={`side ${open ? 'open' : ''}`} aria-label="Main">
        <div className="brand">LedgerFlow</div>
        <select aria-label="Workspace" value={biz.id} onChange={(e) => { if (e.target.value === 'new') { setCreating(true); return; } setBid(+e.target.value); localStorage.setItem('lf_bid', e.target.value); nav('/'); }}>{businesses.map((b) => <option key={b.id} value={b.id}>{b.trading_name || b.legal_name}</option>)}<option value="new">+ New business workspace…</option></select>
        {NAV.map(([to, l, ic]) => <NavLink key={to} to={to} end={to === '/'} className="nav"><span aria-hidden>{ic}</span>{l}</NavLink>)}
        <div className="sp" />
        <div className="muted" style={{ fontSize: '.82rem', padding: '0 10px' }}>{biz.trading_name || biz.legal_name}<br />{user.name} · {biz.role}</div>
        <button className="btn sm ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀ Light' : '☾ Dark'} mode</button>
        <button className="btn sm" onClick={onSignOut}>Sign out</button>
      </nav>
      <main id="main" className="main" key={biz.id}>
        <button className="btn menu-btn sm" style={{ marginBottom: 10 }} onClick={() => setOpen(!open)} aria-expanded={open}>☰ Menu</button>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/clients" element={<Clients />} /><Route path="/clients/:id" element={<ClientDetail />} />
          <Route path="/ratecard" element={<RateCard />} />
          <Route path="/projects" element={<Projects />} /><Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/quotes" element={<Documents type="estimate" />} /><Route path="/invoices" element={<Documents type="invoice" />} />
          <Route path="/quotes/new" element={<DocEditor type="estimate" />} /><Route path="/invoices/new" element={<DocEditor type="invoice" />} />
          <Route path="/documents/:id/edit" element={<DocEditor />} /><Route path="/documents/:id" element={<DocumentView />} />
          <Route path="/payments" element={<Payments />} /><Route path="/expenses" element={<Expenses />} />
          <Route path="/recurring" element={<Recurring />} /><Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings onChanged={refresh} />} /><Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div></BizCtx.Provider>;
}

function App() {
  const loc = useLocation();
  const [state, setState] = useState<{ status?: any; me?: any; loading: boolean }>({ loading: true });
  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 3500); }, []);
  const load = useCallback(async () => {
    try { const status = await get('/api/auth/status'); let me = null; try { me = await get('/api/auth/me'); } catch { /* signed out */ } setState({ status, me, loading: false }); } catch { setState({ loading: false }); }
  }, []);
  useEffect(() => { load(); const f = () => setState((s) => ({ ...s, me: null })); window.addEventListener('lf-unauth', f); return () => window.removeEventListener('lf-unauth', f); }, [load]);
  if (loc.pathname.startsWith('/p/')) return <Routes><Route path="/p/:token" element={<PublicDoc />} /></Routes>;
  if (state.loading) return <p style={{ padding: 24 }} role="status">Loading…</p>;
  if (!state.status) return <div className="login"><div className="alert bad">Cannot reach the LedgerFlow server. <button className="btn sm" onClick={load}>Retry</button></div></div>;
  return <ToastCtx.Provider value={showToast}>
    {!state.me ? <Auth status={state.status} onDone={load} /> : <Shell user={state.me.user} businesses={state.me.businesses} refresh={load} onSignOut={async () => { await post('/api/auth/logout'); load(); }} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </ToastCtx.Provider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
