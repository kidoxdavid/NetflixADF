import path from 'node:path';
import { openDb, all } from './db.ts';
import { config } from './index.ts';
import { createBackup, verifyBackup, restoreBackup } from './backup.ts';
import { runRecurring, runReminders } from './recurring.ts';
import { smtpMailerFromEnv } from './mail.ts';
import { today } from './core.ts';

const [cmd, arg] = process.argv.slice(2);
(async () => {
  if (cmd === 'backup') {
    const db = openDb(config.dbFile); const r = createBackup(db, config.backupDir); const v = verifyBackup(r.file);
    console.log(`Backup written: ${r.file}\nManifest: ${r.manifest}\nSHA-256: ${r.sha256}\nVerification: ${v.ok ? 'PASSED' : 'FAILED'}`); for (const c of v.checks) console.log(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    process.exit(v.ok ? 0 : 2);
  } else if (cmd === 'verify-backup') {
    if (!arg) throw new Error('Usage: npm run verify-backup -- <file>'); const v = verifyBackup(path.resolve(arg));
    for (const c of v.checks) console.log(`[${c.ok ? 'ok' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`); if (v.counts) console.log('Row counts:', JSON.stringify(v.counts)); process.exit(v.ok ? 0 : 2);
  } else if (cmd === 'restore') {
    if (!arg) throw new Error('Usage: npm run restore -- <backup file>   (stop the server first)'); const r = restoreBackup(path.resolve(arg), config.dbFile);
    console.log(`Restored ${arg} into ${config.dbFile}\nPrevious database kept at: ${r.previous}`);
  } else if (cmd === 'jobs') {
    const db = openDb(config.dbFile); const mailer = smtpMailerFromEnv();
    for (const b of all(db, 'SELECT id, timezone FROM businesses')) { const t = today(b.timezone); console.log(`business ${b.id}:`, JSON.stringify({ recurring: runRecurring(db, t, b.id), reminders: await runReminders(db, t, mailer, b.id) })); }
  } else { console.log('Commands: backup | verify-backup <file> | restore <file> | jobs'); process.exit(1); }
})().catch((e) => { console.error(e.message); process.exit(1); });
