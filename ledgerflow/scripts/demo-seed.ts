/**
 * OPTIONAL developer/demo data. NOT run by default and never part of a production install.
 * Creates a clearly-labelled "DEMO" workspace with invented sample services so you can click around.
 * Usage: npm run seed:demo      (all names, rates and clients below are fictional placeholders, NOT your rate card)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, get } from '../server/src/db.ts';
import { config } from '../server/src/index.ts';
import { hashPassword } from '../server/src/auth.ts';
import { createBusiness } from '../server/src/records.ts';
import { createItem, saveCategory } from '../server/src/ratecard.ts';
import { saveClient } from '../server/src/records.ts';
import { insert } from '../server/src/db.ts';
import type { Ctx } from '../server/src/core.ts';

export async function seedDemo(db = openDb(config.dbFile), emailAddr = 'demo@example.com', password = 'demo-password-123') {
  let u = get(db, 'SELECT id FROM users WHERE email=?', emailAddr);
  if (!u) u = { id: insert(db, 'INSERT INTO users (email,name,password_hash) VALUES (?,?,?)', emailAddr, 'Demo User', await hashPassword(password)) };
  const bid = createBusiness(db, u.id as number, { legal_name: 'DEMO Creative Studio (sample data)', trading_name: 'DEMO Studio', email: 'demo@example.com', address: '123 Sample St\nToronto, ON', currency: 'CAD' });
  const c: Ctx = { db, bid, uid: u.id as number, role: 'owner' };
  insert(db, 'INSERT INTO tax_codes (business_id, name, rate_milli, note) VALUES (?,?,?,?)', bid, 'GST', 5000, 'demo');
  const cat = saveCategory(c, null, { name: 'Sample category' });
  createItem(c, { name: 'Sample hourly service (DEMO RATE)', category_id: cat, unit: 'hour', pricing_type: 'fixed', rate_cents: 10000 });
  createItem(c, { name: 'Sample per-video service (DEMO RATE)', category_id: cat, unit: 'video', pricing_type: 'fixed', rate_cents: 25000 });
  saveClient(c, null, { name: 'Sample Client (demo)', email: 'client@example.com' });
  console.log(`Demo workspace created. Sign in as ${emailAddr} / ${password}`);
  return { bid };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) seedDemo().catch((e) => { console.error(e); process.exit(1); });
