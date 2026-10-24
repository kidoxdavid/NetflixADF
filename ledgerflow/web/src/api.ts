import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error { constructor(public status: number, message: string, public details?: any) { super(message); } }
export async function api<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try { res = await fetch(url, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-lf-request': '1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.'); }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) { if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new Event('lf-unauth')); throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details); }
  return data as T;
}
export const get = <T = any>(u: string) => api<T>('GET', u);
export const post = <T = any>(u: string, b: unknown = {}, h?: Record<string, string>) => api<T>('POST', u, b, h);
export const put = <T = any>(u: string, b: unknown = {}) => api<T>('PUT', u, b);
export const del = <T = any>(u: string) => api<T>('DELETE', u);

export function useFetch<T = any>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(!!url); const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) { setData(null); setLoading(false); return; }
    let alive = true; setLoading(true); setError(null);
    get<T>(url).then((d) => { if (alive) { setData(d); setLoading(false); } }).catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps]);
  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []), setData };
}

// ---- money helpers (display + input only; the server is authoritative for all calculations) ----
export function fmt(cents: number | null | undefined, cur = 'CAD'): string {
  if (cents === null || cents === undefined) return '—';
  const neg = cents < 0; const a = Math.abs(cents); const s = `${Math.floor(a / 100).toLocaleString('en-CA')}.${String(a % 100).padStart(2, '0')}`;
  return `${neg ? '−' : ''}$${s}${cur !== 'CAD' ? ' ' + cur : ''}`;
}
export function toCents(s: string | number): number | null { const t = String(s).replace(/[$,\s]/g, ''); if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null; const [i, f = ''] = t.replace('-', '').split('.'); const v = Number(i + f.padEnd(2, '0')); return t.startsWith('-') ? -v : v; }
export const fromCents = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
export function toMilli(s: string | number): number | null { const t = String(s).trim(); if (!/^\d+(\.\d{1,3})?$/.test(t)) return null; const [i, f = ''] = t.split('.'); return Number(i + f.padEnd(3, '0')); }
export const fromMilli = (m: number) => String(m / 1000);
export const pctFromMilli = (m: number) => `${m / 1000}%`;
export const today = () => new Date().toLocaleDateString('en-CA');
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
export function fileToB64(f: File): Promise<string> { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(f); }); }
export const formatQtyUi = (m: number) => String(Math.round(m) / 1000);
export const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
