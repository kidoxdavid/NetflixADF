import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fromCents, toCents, label } from './api';

export type Toast = (msg: string) => void;
export const ToastCtx = createContext<Toast>(() => {});
export const useToast = () => useContext(ToastCtx);
export interface Biz { id: number; legal_name: string; trading_name: string | null; currency: string; role: string }
export const BizCtx = createContext<{ biz: Biz; bid: number; b: (p: string) => string; canWrite: boolean; isAdmin: boolean }>(null as any);
export const useBiz = () => useContext(BizCtx);

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null; ref.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k); return () => { document.removeEventListener('keydown', k); prev?.focus(); };
  }, [onClose]);
  return <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
      <div className="sp-between" style={{ marginBottom: 14 }}><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button></div>{children}
    </div></div>;
}
export function Field({ label: l, children, help, span }: { label: string; children: ReactNode; help?: string; span?: boolean }) {
  return <label className={`f ${span ? 'span' : ''}`}><span>{l}</span>{children}{help && <span className="help">{help}</span>}</label>;
}
/** Dollar input holding free text; reports integer cents (or null when empty/invalid). */
export function MoneyInput({ cents, onChange, placeholder, ...rest }: { cents: number | null | undefined; onChange: (c: number | null) => void; placeholder?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  const [txt, setTxt] = useState(fromCents(cents));
  const last = useRef(cents);
  useEffect(() => { if (cents !== last.current && toCents(txt) !== cents) setTxt(fromCents(cents)); last.current = cents; }, [cents]); // eslint-disable-line
  const bad = txt !== '' && toCents(txt) === null;
  return <input {...rest} inputMode="decimal" value={txt} placeholder={placeholder ?? '0.00'} aria-invalid={bad} style={bad ? { borderColor: 'var(--bad)' } : undefined}
    onChange={(e) => { setTxt(e.target.value); const c = toCents(e.target.value); last.current = c; onChange(e.target.value === '' ? null : c); }} onBlur={() => { const c = toCents(txt); if (c !== null) setTxt(fromCents(c)); }} />;
}
export function NumInput({ milli, onChange, ...rest }: { milli: number; onChange: (m: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  const [txt, setTxt] = useState(String(milli / 1000)); const last = useRef(milli);
  useEffect(() => { if (milli !== last.current) setTxt(String(milli / 1000)); last.current = milli; }, [milli]);
  return <input {...rest} inputMode="decimal" value={txt} onChange={(e) => { setTxt(e.target.value); const t = e.target.value.trim(); if (/^\d+(\.\d{1,3})?$/.test(t)) { const [i, f = ''] = t.split('.'); const m = Number(i + f.padEnd(3, '0')); last.current = m; onChange(m); } }} />;
}
const STATUS_STYLE: Record<string, string> = { paid: 'ok', accepted: 'ok', completed: 'ok', active: 'ok', sent: 'ok', reimbursed: 'ok', overdue: 'bad', void: 'bad', rejected: 'bad', failed: 'bad', draft: 'mute', superseded: 'mute', expired: 'warn', partially_paid: 'warn', credited: 'mute', converted: 'ok', drafted: 'warn', inactive: 'mute', archived: 'mute', pending: 'warn', on_hold: 'warn' };
export const Badge = ({ s, text }: { s: string; text?: string }) => <span className={`badge ${STATUS_STYLE[s] ?? ''}`}>{text ?? (s === 'issued' ? 'Issued' : label(s))}</span>;
export const EmptyOr = null;
export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => <div className="empty card"><h3>{title}</h3><div>{children}</div></div>;
export const Loading = () => <p className="muted" role="status">Loading…</p>;
export const ErrorBox = ({ error, retry }: { error: string; retry?: () => void }) => <div className="alert bad" role="alert">{error} {retry && <button className="btn sm" onClick={retry}>Retry</button>}</div>;
export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)}>{l}</button>)}</div>;
}
export function PageTop({ title, children, sub }: { title: string; children?: ReactNode; sub?: ReactNode }) {
  return <div className="top"><div><h1>{title}</h1>{sub && <div className="muted">{sub}</div>}</div><div className="actions">{children}</div></div>;
}
/** Wraps an async action with busy state, toast on success and inline error. */
export function useAction() {
  const toast = useToast(); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => { setBusy(true); setError(null); try { const r = await fn(); if (ok) toast(ok); return r; } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return { busy, error, run, setError };
}
export function Confirm({ title, text, onYes, onNo, yes = 'Confirm', danger, reason }: { title: string; text: ReactNode; onYes: (reason?: string) => void; onNo: () => void; yes?: string; danger?: boolean; reason?: boolean }) {
  const [r, setR] = useState('');
  return <Modal title={title} onClose={onNo}><div className="form"><div>{text}</div>{reason && <Field label="Reason (kept in the audit trail)"><input value={r} onChange={(e) => setR(e.target.value)} autoFocus /></Field>}
    <div className="row"><button className="btn fit" onClick={onNo}>Cancel</button><button className={`btn fit ${danger ? 'danger' : 'primary'}`} disabled={reason && !r.trim()} onClick={() => onYes(r)}>{yes}</button></div></div></Modal>;
}
export function download(url: string) { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
export function PdfView({ url, onClose, title }: { url: string; onClose: () => void; title: string }) {
  return <Modal title={title} onClose={onClose} wide><iframe className="pdfframe" src={url} title={title} /><p className="help">If the preview does not display on your device, <a href={url + (url.includes('?') ? '&' : '?') + 'download=1'}>download the PDF</a>.</p></Modal>;
}
