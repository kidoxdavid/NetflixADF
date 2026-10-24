import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/src/db.ts';
import { createApp } from '../server/src/app.ts';
import type { Mailer, MailMessage } from '../server/src/mail.ts';

export interface TestMailer extends Mailer { sent: MailMessage[]; failNext: boolean }
export function fakeMailer(configured = true): TestMailer {
  const m: TestMailer = { configured, from: 'billing@example.test', sent: [], failNext: false, async send(msg) { if (m.failNext) { m.failNext = false; throw new Error('SMTP connection refused'); } m.sent.push(msg); } };
  return m;
}

export async function startServer(opts: { mailer?: Mailer; allowRegistration?: boolean; dbFile?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-test-'));
  const dbFile = opts.dbFile ?? path.join(dir, 'test.db');
  const db = openDb(dbFile);
  const mailer = opts.mailer ?? fakeMailer(false);
  const app = createApp({ db, mailer, backupDir: path.join(dir, 'backups'), dbFile, webDir: null, quiet: true, allowRegistration: opts.allowRegistration });
  const server: Server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, base, dir, dbFile, mailer, close: () => new Promise<void>((r) => server.close(() => { try { db.close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); r(); })) };
}

export class Client {
  cookie = '';
  constructor(public base: string, public bid = 0) {}
  async raw(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + url, { method, headers: { 'content-type': 'application/json', 'x-lf-request': '1', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return res;
  }
  async req<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; res: Response }> {
    const res = await this.raw(method, url, body, headers);
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('json') ? await res.json() : null;
    return { status: res.status, body: data as T, res };
  }
  get = <T = any>(u: string) => this.req<T>('GET', u);
  post = <T = any>(u: string, b?: unknown, h?: Record<string, string>) => this.req<T>('POST', u, b ?? {}, h);
  put = <T = any>(u: string, b?: unknown) => this.req<T>('PUT', u, b ?? {});
  del = <T = any>(u: string) => this.req<T>('DELETE', u);
  b = (p: string) => `/api/b/${this.bid}${p}`;
  async bytes(url: string) { const res = await this.raw('GET', url); return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' }; }
}

/** Register the owner, create a business, return a ready client. */
export async function setupBusiness(base: string, email = 'owner@example.test', legal = 'Test Studio Inc.') {
  const c = new Client(base);
  const r = await c.post('/api/auth/register', { email, name: 'Owner', password: 'correct horse battery' });
  if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.body));
  const b = await c.post('/api/businesses', { legal_name: legal, trading_name: 'Test Studio', email: 'hello@teststudio.test', address: '1 Main St\nToronto, ON', currency: 'CAD', tax_registration_label: 'GST/HST no.', tax_registration_number: '123456789 RT0001' });
  c.bid = b.body.id;
  return c;
}
export const money = (d: number) => Math.round(d * 100);

import { execFileSync } from 'node:child_process';
export function pdfText(buf: Buffer): string {
  const f = path.join(os.tmpdir(), `lf-${Math.random().toString(36).slice(2)}.pdf`); fs.writeFileSync(f, buf);
  try { return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); } finally { fs.rmSync(f, { force: true }); }
}
export function pdfPages(buf: Buffer): number {
  const f = path.join(os.tmpdir(), `lf-${Math.random().toString(36).slice(2)}.pdf`); fs.writeFileSync(f, buf);
  try { return Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [f], { encoding: 'utf8' }))![1]); } finally { fs.rmSync(f, { force: true }); }
}
