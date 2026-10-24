import nodemailer from 'nodemailer';
import { get, insert, run } from './db.ts';
import type { Row } from './db.ts';
import { type Ctx, bad, notFound, audit, str } from './core.ts';

export interface MailMessage { to: string; subject: string; text: string; from?: string; attachments?: { filename: string; content: Buffer; contentType: string }[] }
export interface Mailer { configured: boolean; from: string | null; send(m: MailMessage): Promise<void> }

export function smtpMailerFromEnv(env = process.env): Mailer {
  if (!env.SMTP_HOST) return { configured: false, from: null, async send() { throw new Error('Email is not configured (set SMTP_HOST in .env)'); } };
  const transport = nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true', auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined, connectionTimeout: 15000, socketTimeout: 20000 });
  const from = env.SMTP_FROM || env.SMTP_USER || null;
  return { configured: true, from, async send(m) { await transport.sendMail({ from: m.from ?? from ?? undefined, to: m.to, subject: m.subject, text: m.text, attachments: m.attachments }); } };
}

/** Record a communication honestly: drafted (prepared, not sent) → sent | failed. */
export async function sendOrDraft(c: Ctx, mailer: Mailer, opts: { document_id?: number | null; client_id?: number | null; payment_id?: number | null; kind: string; to: string | null; subject: string; body: string; attach?: { filename: string; content: Buffer } | null; dedupe_key?: string | null; send: boolean }) {
  const to = str(opts.to, 300);
  let id: number;
  try {
    id = insert(c.db, 'INSERT INTO communications (business_id, document_id, client_id, payment_id, kind, to_addr, subject, body, status, dedupe_key, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      c.bid, opts.document_id ?? null, opts.client_id ?? null, opts.payment_id ?? null, opts.kind, to, opts.subject.slice(0, 300), opts.body.slice(0, 20000), 'drafted', opts.dedupe_key ?? null, c.uid);
  } catch (e: any) { if (/UNIQUE/.test(String(e.message))) return { id: null as number | null, status: 'duplicate' as const }; throw e; }
  if (!opts.send) return { id, status: 'drafted' as const };
  if (!mailer.configured) return { id, status: 'drafted' as const, note: 'Email is not configured; the message was prepared but NOT sent.' };
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { run(c.db, "UPDATE communications SET error=? WHERE id=?", 'No valid recipient address; prepared for manual sending', id); return { id, status: 'drafted' as const, note: 'No recipient email address on file; the message was prepared but NOT sent.' }; }
  try {
    await mailer.send({ to, subject: opts.subject, text: opts.body, attachments: opts.attach ? [{ filename: opts.attach.filename, content: opts.attach.content, contentType: 'application/pdf' }] : undefined });
    run(c.db, "UPDATE communications SET status='sent', sent_at=datetime('now') WHERE id=?", id);
    audit(c, 'communication', id, 'sent', { kind: opts.kind, to });
    return { id, status: 'sent' as const };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    run(c.db, "UPDATE communications SET status='failed', error=? WHERE id=?", msg, id);
    audit(c, 'communication', id, 'failed', { kind: opts.kind, error: msg });
    return { id, status: 'failed' as const, error: msg };
  }
}
void bad; void notFound; void get;
export type Row_ = Row;
