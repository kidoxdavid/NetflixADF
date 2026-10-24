import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, all } from './db.ts';
import { createApp } from './app.ts';
import { smtpMailerFromEnv } from './mail.ts';
import { runRecurring, runReminders } from './recurring.ts';
import { today } from './core.ts';
import { get } from './db.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// minimal .env loader (no dependency); real environment variables win
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }

export const config = {
  port: Number(process.env.PORT || 3000), host: process.env.HOST || '127.0.0.1',
  dbFile: path.resolve(root, process.env.DATABASE_FILE || 'data/ledgerflow.db'), backupDir: path.resolve(root, process.env.BACKUP_DIR || 'data/backups'),
  webDir: path.join(root, 'web/dist'),
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(config.dbFile); const mailer = smtpMailerFromEnv();
  const app = createApp({ db, mailer, backupDir: config.backupDir, dbFile: config.dbFile, webDir: config.webDir, allowRegistration: process.env.ALLOW_REGISTRATION === 'true', secureCookies: process.env.COOKIE_SECURE === 'true' });
  const server = app.listen(config.port, config.host, () => console.log(JSON.stringify({ level: 'info', msg: `LedgerFlow listening on http://${config.host}:${config.port}`, email: mailer.configured ? 'smtp configured' : 'email not configured (documents are prepared, not sent)' })));
  // In-process scheduler: idempotent jobs, run at start and hourly. Also available as `npm run jobs` for cron/systemd timers.
  const tick = async () => {
    try {
      for (const b of all(db, 'SELECT id, timezone FROM businesses')) { const t = today(b.timezone); const r = runRecurring(db, t, b.id); const m = await runReminders(db, t, mailer, b.id); if (r.created.length || r.errors.length || m.prepared || m.sent || m.failed) console.log(JSON.stringify({ level: 'info', job: 'scheduler', business: b.id, recurring: r, reminders: m })); }
    } catch (e) { console.error(JSON.stringify({ level: 'error', job: 'scheduler', err: String(e) })); }
  };
  if (process.env.SCHEDULER !== 'off') { setTimeout(tick, 5000).unref(); setInterval(tick, 3600_000).unref(); }
  const shutdown = () => { server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
void get;
