import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, insert, tx, type DB, type Row } from './db.ts';
import { HttpError, bad, notFound, forbidden, conflict, ROLE_RANK, type Role, type Ctx, audit, getSettings, saveSettings, DEFAULT_SETTINGS, str, reqStr, int, bool, sha256, bizToday, ensureOwned } from './core.ts';
import { hashPassword, verifyPassword, passwordProblem, createSession, userFromToken, destroySession, RateLimiter } from './auth.ts';
import * as RC from './ratecard.ts';
import * as IMP from './importer.ts';
import * as DOC from './documents.ts';
import * as PAY from './payments.ts';
import * as REC from './records.ts';
import * as RPT from './reports.ts';
import * as RCR from './recurring.ts';
import * as PDF from './pdf.ts';
import * as BAK from './backup.ts';
import { sendOrDraft, type Mailer } from './mail.ts';
import { calcDocument } from './calc.ts';
import { logger } from './log.ts';

export interface AppOptions { db: DB; mailer: Mailer; backupDir: string; dbFile: string; webDir?: string | null; allowRegistration?: boolean; secureCookies?: boolean; quiet?: boolean }
declare module 'express-serve-static-core' { interface Request { user?: { id: number; email: string; name: string }; ctx?: Ctx } }

const COOKIE = 'lf_session';
function cookieOf(req: Request, name: string) { const h = req.headers.cookie; if (!h) return undefined; for (const p of h.split(';')) { const [k, ...v] = p.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); } }
const b64 = (v: unknown, field = 'file'): Buffer => { if (typeof v !== 'string' || !v) throw bad(`${field} is required`); const buf = Buffer.from(v, 'base64'); if (!buf.length) throw bad(`${field} is empty`); return buf; };
const pdfRes = (res: Response, r: { buffer: Buffer; filename: string }, inline = true) => { res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${r.filename.replace(/[^\w.\-]/g, '_')}"`); res.setHeader('Cache-Control', 'private, no-store'); res.send(r.buffer); };

export function createApp(o: AppOptions) {
  const app = express(); const { db } = o; const log = logger(o.quiet);
  app.disable('x-powered-by'); app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || 1 : false);
  const loginLimiter = new RateLimiter(8, 10 * 60_000); const publicLimiter = new RateLimiter(60, 60_000);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  app.use(express.json({ limit: '14mb' }));
  // CSRF defence for cookie auth: mutations must carry a custom header (forces a CORS preflight, which we never allow) and a same-origin Origin.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.path.startsWith('/public/')) { if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return next(forbidden('Cross-origin request blocked')); return next(); }
    if (req.headers['x-lf-request'] !== '1') return next(forbidden('Missing request header'));
    if (req.headers.origin) { try { if (new URL(req.headers.origin).host !== req.headers.host) return next(forbidden('Cross-origin request blocked')); } catch { return next(forbidden('Bad origin')); } }
    next();
  });
  app.use((req, _res, next) => { const t0 = Date.now(); _res.on('finish', () => { if (!o.quiet && req.path.startsWith('/api')) log.info({ m: req.method, p: req.path.replace(/\/p\/[^/]+/, '/p/…'), s: _res.statusCode, ms: Date.now() - t0 }); }); next(); });

  const api = express.Router(); app.use('/api', api);
  api.get('/health', (_req, res) => { try { get(db, 'SELECT 1'); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); } });

  // ---- auth ---------------------------------------------------------------------------------
  const setCookie = (req: Request, res: Response, token: string) => res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${o.secureCookies || req.secure ? '; Secure' : ''}`);
  const userCount = () => Number(get(db, 'SELECT COUNT(*) n FROM users')!.n);
  api.get('/auth/status', (_req, res) => res.json({ needs_setup: userCount() === 0, registration_open: userCount() === 0 || !!o.allowRegistration, email_configured: o.mailer.configured }));
  api.post('/auth/register', async (req, res) => {
    if (userCount() > 0 && !o.allowRegistration) throw forbidden('Registration is closed. Ask the account owner to add you.');
    const email = reqStr(req.body.email, 'Email', 200).toLowerCase(); const name = reqStr(req.body.name, 'Name', 120);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Email address looks invalid');
    const pp = passwordProblem(req.body.password); if (pp) throw bad(pp);
    if (get(db, 'SELECT 1 FROM users WHERE email=?', email)) throw conflict('An account with that email already exists');
    const hash = await hashPassword(req.body.password);
    const id = insert(db, 'INSERT INTO users (email, name, password_hash) VALUES (?,?,?)', email, name, hash);
    setCookie(req, res, createSession(db, id)); res.status(201).json({ id, email, name });
  });
  api.post('/auth/login', async (req, res) => {
    const email = String(req.body.email ?? '').toLowerCase().trim(); const key = `${req.ip}|${email}`;
    if (!loginLimiter.check(key)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const u = get(db, 'SELECT * FROM users WHERE email=?', email);
    const ok = u ? await verifyPassword(String(req.body.password ?? ''), u.password_hash) : (await hashPassword('x'), false);
    if (!u || !ok) throw new HttpError(401, 'Incorrect email or password');
    loginLimiter.reset(key); setCookie(req, res, createSession(db, u.id)); res.json({ id: u.id, email: u.email, name: u.name });
  });
  api.post('/auth/logout', (req, res) => { const t = cookieOf(req, COOKIE); if (t) destroySession(db, t); res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); res.json({ ok: true }); });
  const auth: RequestHandler = (req, _res, next) => { const u = userFromToken(db, cookieOf(req, COOKIE)); if (!u) return next(new HttpError(401, 'Please sign in')); req.user = u; next(); };
  api.get('/auth/me', auth, (req, res) => {
    const businesses = all(db, 'SELECT b.id, b.legal_name, b.trading_name, b.currency, m.role FROM memberships m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=? ORDER BY b.id', req.user!.id);
    res.json({ user: req.user, businesses, email_configured: o.mailer.configured });
  });
  api.post('/auth/password', auth, async (req, res) => {
    const u = get(db, 'SELECT * FROM users WHERE id=?', req.user!.id)!; if (!(await verifyPassword(String(req.body.current ?? ''), u.password_hash))) throw new HttpError(403, 'Current password is incorrect');
    const pp = passwordProblem(req.body.next); if (pp) throw bad(pp);
    run(db, 'UPDATE users SET password_hash=? WHERE id=?', await hashPassword(req.body.next), u.id);
    run(db, 'DELETE FROM sessions WHERE user_id=? AND token_hash<>?', u.id, sha256(cookieOf(req, COOKIE)!)); res.json({ ok: true });
  });
  api.post('/businesses', auth, (req, res) => { const id = REC.createBusiness(db, req.user!.id, req.body); res.status(201).json({ id }); });

  // ---- business-scoped router ------------------------------------------------------------------
  const B = express.Router({ mergeParams: true }); api.use('/b/:bid', auth, (req, _res, next) => {
    const bid = Number(req.params.bid); const m = Number.isSafeInteger(bid) ? get(db, 'SELECT role FROM memberships WHERE user_id=? AND business_id=?', req.user!.id, bid) : undefined;
    if (!m) return next(notFound('Business')); // 404, not 403: do not reveal other workspaces
    const role = m.role as Role; if (req.method !== 'GET' && req.method !== 'HEAD' && ROLE_RANK[role] < ROLE_RANK.staff) return next(forbidden('Your role is read-only'));
    req.ctx = { db, bid, uid: req.user!.id, role }; next();
  }, B);
  const C = (req: Request) => req.ctx!;
  const min = (role: Role): RequestHandler => (req, _res, next) => (ROLE_RANK[C(req).role] >= ROLE_RANK[role] ? next() : next(forbidden(`Requires ${role} access`)));
  const admin = min('admin');

  // idempotent POST: Idempotency-Key replays the stored response instead of repeating the side effect
  const idem: RequestHandler = (req, res, next) => {
    const key = req.header('Idempotency-Key'); if (!key || key.length > 100) return next();
    const route = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/\d+/g, '/:id'); const bid = C(req).bid;
    const ex = get(db, 'SELECT * FROM idempotency_keys WHERE business_id=? AND key=? AND route=?', bid, key, route);
    if (ex) { res.setHeader('Idempotent-Replay', 'true'); return void res.status(ex.status).type('json').send(ex.response); }
    const orig = res.json.bind(res);
    res.json = ((body: unknown) => { if (res.statusCode < 500) run(db, 'INSERT OR IGNORE INTO idempotency_keys (business_id, key, route, response, status) VALUES (?,?,?,?,?)', bid, key, route, JSON.stringify(body), res.statusCode); return orig(body); }) as typeof res.json;
    next();
  };

  // business profile & settings
  B.get('/business', (req, res) => res.json(REC.getBusiness(C(req))));
  B.put('/business', admin, (req, res) => { REC.updateBusiness(C(req), req.body); res.json(REC.getBusiness(C(req))); });
  B.put('/business/settings', admin, (req, res) => {
    const b = req.body ?? {}; const patch: Row = {};
    const s = (k: string, max = 4000) => { if (b[k] !== undefined) patch[k] = str(b[k], max) ?? ''; };
    ['invoice_notes', 'estimate_terms', 'invoice_terms', 'payment_instructions', 'statement_of_work_note'].forEach((k) => s(k));
    if (b.payment_terms_days !== undefined) patch.payment_terms_days = int(b.payment_terms_days, 'payment terms', { min: 0, max: 365 });
    if (b.estimate_valid_days !== undefined) patch.estimate_valid_days = int(b.estimate_valid_days, 'estimate validity', { min: 1, max: 730 });
    if (b.public_link_days !== undefined) patch.public_link_days = int(b.public_link_days, 'link expiry', { min: 1, max: 365 });
    if (b.prices_include_tax !== undefined) patch.prices_include_tax = !!bool(b.prices_include_tax);
    if (b.template !== undefined) { if (!['minimal', 'editorial', 'creative', 'formal'].includes(b.template)) throw bad('Unknown template'); patch.template = b.template; }
    if (b.accent !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(b.accent)) throw bad('Accent must be a hex colour like #1f4e5f'); patch.accent = b.accent; }
    if (b.default_tax_ids !== undefined) { const ids = (b.default_tax_ids as unknown[]).map((x) => int(x, 'tax', { min: 1 })!); for (const t of ids) ensureOwned(db, 'tax_codes', t, C(req).bid, 'Tax'); patch.default_tax_ids = ids; }
    if (b.payment_methods !== undefined) { if (!Array.isArray(b.payment_methods)) throw bad('payment_methods must be a list'); patch.payment_methods = b.payment_methods.map((x: unknown) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 20); }
    if (b.reminders) patch.reminders = { enabled: !!bool(b.reminders.enabled), offsets: (Array.isArray(b.reminders.offsets) ? b.reminders.offsets : DEFAULT_SETTINGS.reminders.offsets).map((x: unknown) => int(x, 'reminder offset', { min: -60, max: 365 })!).slice(0, 8) };
    if (b.rate_card) { const r = b.rate_card; patch.rate_card = { title: str(r.title, 120) ?? 'Rate Card', intro: str(r.intro, 3000) ?? '', conditions: str(r.conditions, 4000) ?? '', terms: str(r.terms, 4000) ?? '', validity_days: int(r.validity_days ?? 90, 'validity', { min: 1, max: 730 })!, show_unit: !!bool(r.show_unit ?? 1), show_descriptions: !!bool(r.show_descriptions ?? 1), show_deliverables: !!bool(r.show_deliverables ?? 1) }; }
    saveSettings(db, C(req).bid, patch as any); audit(C(req), 'settings', null, 'update', Object.keys(patch)); res.json(REC.getBusiness(C(req)));
  });
  B.put('/business/sequences/:kind', admin, (req, res) => { REC.updateSequence(C(req), String(req.params.kind), req.body); res.json(REC.getBusiness(C(req)).sequences); });
  B.post('/business/logo', admin, (req, res) => {
    const buf = b64(req.body.data_base64, 'logo'); const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpg) throw bad('Logo must be a PNG or JPEG image'); if (buf.length > 1_500_000) throw bad('Logo must be under 1.5 MB');
    run(db, 'UPDATE businesses SET logo=?, logo_mime=? WHERE id=?', buf, isPng ? 'image/png' : 'image/jpeg', C(req).bid); audit(C(req), 'business', C(req).bid, 'logo'); res.json({ ok: true });
  });
  B.delete('/business/logo', admin, (req, res) => { run(db, 'UPDATE businesses SET logo=NULL, logo_mime=NULL WHERE id=?', C(req).bid); res.json({ ok: true }); });
  B.get('/business/logo', (req, res) => { const r = get(db, 'SELECT logo, logo_mime FROM businesses WHERE id=?', C(req).bid); if (!r?.logo) throw notFound('Logo'); res.setHeader('Content-Type', r.logo_mime); res.setHeader('Cache-Control', 'private, max-age=60'); res.send(Buffer.from(r.logo)); });
  B.get('/members', (req, res) => res.json(all(db, 'SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=?', C(req).bid)));
  B.post('/members', min('owner'), async (req, res) => {
    const email = reqStr(req.body.email, 'Email', 200).toLowerCase(); const role = req.body.role as Role; if (!['admin', 'staff', 'viewer'].includes(role)) throw bad('Role must be admin, staff or viewer');
    let u = get(db, 'SELECT id FROM users WHERE email=?', email);
    if (!u) { const pp = passwordProblem(req.body.password); if (pp) throw bad('New user: ' + pp); u = { id: insert(db, 'INSERT INTO users (email, name, password_hash) VALUES (?,?,?)', email, reqStr(req.body.name, 'Name', 120), await hashPassword(req.body.password)) }; }
    run(db, 'INSERT OR REPLACE INTO memberships (user_id, business_id, role) VALUES (?,?,?)', u.id, C(req).bid, role); audit(C(req), 'member', u.id as number, 'set_role', { email, role }); res.status(201).json({ ok: true });
  });
  B.delete('/members/:uid', min('owner'), (req, res) => { const uid = Number(req.params.uid); const m = get(db, 'SELECT role FROM memberships WHERE user_id=? AND business_id=?', uid, C(req).bid); if (!m) throw notFound('Member'); if (m.role === 'owner') throw bad('The owner cannot be removed'); run(db, 'DELETE FROM memberships WHERE user_id=? AND business_id=?', uid, C(req).bid); res.json({ ok: true }); });

  // taxes
  B.get('/taxes', (req, res) => res.json(REC.listTaxes(C(req))));
  B.get('/taxes/presets', (_req, res) => res.json({ presets: REC.CA_TAX_PRESETS, warning: 'These are common Canadian rates provided as a convenience. Confirm the rates, your registration status and place-of-supply rules with the CRA / Revenu Québec or an accountant before using them.' }));
  B.post('/taxes', admin, (req, res) => res.status(201).json({ id: REC.saveTax(C(req), null, req.body) }));
  B.put('/taxes/:id', admin, (req, res) => res.json({ id: REC.saveTax(C(req), Number(req.params.id), req.body) }));

  // clients
  B.get('/clients', (req, res) => res.json(REC.listClients(C(req), req.query as Row)));
  B.get('/clients/export.csv', admin, (req, res) => { const rows = REC.listClients(C(req), { archived: 'all' }).map((c) => ({ id: c.id, name: c.name, company: c.company, email: c.email, phone: c.phone, billing_address: c.billing_address, currency: c.currency, payment_terms_days: c.payment_terms_days, tax_exempt: c.tax_exempt, tags: c.tags.join('; '), archived: c.archived, outstanding: (c.outstanding_cents / 100).toFixed(2), invoiced: (c.invoiced_cents / 100).toFixed(2) })); csv(res, 'clients.csv', rows); });
  B.post('/clients', (req, res) => res.status(201).json({ id: REC.saveClient(C(req), null, req.body) }));
  B.get('/clients/:id', (req, res) => res.json(REC.getClient(C(req), Number(req.params.id))));
  B.put('/clients/:id', (req, res) => res.json({ id: REC.saveClient(C(req), Number(req.params.id), req.body) }));
  B.post('/clients/:id/prices', (req, res) => res.status(201).json({ id: REC.saveClientPrice(C(req), Number(req.params.id), null, req.body) }));
  B.put('/clients/:id/prices/:pid', (req, res) => res.json({ id: REC.saveClientPrice(C(req), Number(req.params.id), Number(req.params.pid), req.body) }));
  const csv = (res: Response, name: string, rows: Row[]) => { const keys = rows.length ? Object.keys(rows[0]) : []; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send('﻿' + [keys.join(','), ...rows.map((r) => keys.map((k) => RC.csvCell(r[k])).join(','))].join('\r\n') + '\r\n'); };

  // rate card
  B.get('/ratecard/categories', (req, res) => res.json(RC.listCategories(C(req))));
  B.post('/ratecard/categories', (req, res) => res.status(201).json({ id: RC.saveCategory(C(req), null, req.body) }));
  B.put('/ratecard/categories/:id', (req, res) => res.json({ id: RC.saveCategory(C(req), Number(req.params.id), req.body) }));
  B.get('/ratecard/items', (req, res) => res.json(RC.listItems(C(req), req.query as Row)));
  B.post('/ratecard/items', (req, res) => res.status(201).json({ id: RC.createItem(C(req), req.body) }));
  B.get('/ratecard/items/:id', (req, res) => res.json(RC.getItem(C(req), Number(req.params.id))));
  B.put('/ratecard/items/:id', (req, res) => res.json({ id: RC.updateItem(C(req), Number(req.params.id), req.body) }));
  B.post('/ratecard/items/:id/status', (req, res) => { RC.setItemStatus(C(req), Number(req.params.id), String(req.body.status)); res.json({ ok: true }); });
  B.post('/ratecard/items/:id/duplicate', (req, res) => res.status(201).json({ id: RC.duplicateItem(C(req), Number(req.params.id)) }));
  B.post('/ratecard/bulk-adjust', admin, (req, res) => { const pct = int(req.body.milli_pct, 'percentage', { min: -90000, max: 500000 })!; const ids = (req.body.ids as unknown[] ?? []).map((x) => int(x, 'id', { min: 1 })!); if (!ids.length) throw bad('Select at least one service'); res.json({ updated: RC.bulkAdjust(C(req), ids, pct, str(req.body.note, 300)) }); });
  B.get('/ratecard/export.csv', (req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="rate-card.csv"'); res.send('﻿' + RC.exportCsv(C(req))); });
  B.get('/ratecard/pdf', async (req, res) => { const ids = req.query.ids ? String(req.query.ids).split(',').map(Number).filter(Number.isSafeInteger) : undefined; pdfRes(res, await PDF.renderRateCardPdf(C(req), { itemIds: ids }), req.query.download !== '1'); });
  B.get('/ratecard/versions', (req, res) => res.json(RC.listVersions(C(req))));
  B.post('/ratecard/versions', admin, (req, res) => res.status(201).json({ id: RC.createVersion(C(req), req.body.label, req.body.note) }));
  B.get('/ratecard/compare', (req, res) => res.json(RC.compareVersions(C(req), String(req.query.a), String(req.query.b ?? 'current'))));
  B.get('/ratecard/search', (req, res) => {
    const c = C(req); const clientId = req.query.client_id ? Number(req.query.client_id) : null; const today = bizToday(db, c.bid);
    const items = RC.listItems(c, { search: String(req.query.q ?? ''), status: 'active' }).slice(0, 30);
    res.json(items.map((i) => { const r = RC.resolvePrice(c, i.id, clientId, today); return { id: i.id, name: i.name, kind: i.kind, category_name: i.category_name, unit: i.unit, short_desc: i.short_desc, pricing_type: i.pricing_type, standard_rate_cents: i.rate_cents, rate_cents: r.rate_cents, source: r.source, needs_confirmation: r.needs_confirmation, currency: i.currency, pkg_price_mode: i.pkg_price_mode }; }));
  });
  B.get('/ratecard/line/:id', (req, res) => { const c = C(req); res.json(RC.buildLinesFromItem(c, Number(req.params.id), req.query.client_id ? Number(req.query.client_id) : null, bizToday(db, c.bid), req.query.qty_milli ? Number(req.query.qty_milli) : undefined)); });
  B.post('/ratecard/import/preview', (req, res) => {
    const c = C(req); const name = String(req.body.filename ?? 'pasted.csv'); let text: string; let fromText = false; let rows: string[][];
    if (req.body.text) text = String(req.body.text); else {
      const buf = b64(req.body.data_base64); if (buf.length > 8e6) throw bad('File too large');
      if (buf.subarray(0, 5).toString('latin1') === '%PDF-') { try { text = IMP.extractPdfText(buf); } catch { throw bad('Could not read text from this PDF (it may be a scan). Scanned PDFs and images need OCR, which is not built in — paste the text, export a CSV, or add services manually.'); } fromText = true; }
      else if (buf[0] === 0x50 && buf[1] === 0x4b) throw bad('Excel (.xlsx) files are not read directly. In Excel/Sheets choose File → Save as → CSV and upload that file.');
      else if (/\.(png|jpe?g|webp|gif|tiff?)$/i.test(name)) throw bad('Images need OCR, which is not built in. Type the services manually, or transcribe them into a CSV.');
      else text = buf.toString('utf8');
    }
    if (!text.trim()) throw bad('The file is empty');
    if (fromText || req.body.mode === 'text') { rows = IMP.extractFromText(text); fromText = true; } else rows = IMP.parseCsv(text, req.body.delimiter || undefined);
    if (rows.length < 1) throw bad('No rows found'); if (rows.length > 5000) throw bad('More than 5,000 rows; split the file');
    const hasHeader = fromText ? true : req.body.has_header !== false; const mapping = req.body.mapping ?? IMP.suggestMapping(rows[0]);
    res.json({ headers: rows[0], sample: rows.slice(0, 6), mapping, has_header: hasHeader, from_text: fromText, fields: IMP.IMPORT_FIELDS, ...IMP.previewImport(c, rows, mapping, { hasHeader, fromText, defaultCurrency: req.body.currency }) });
  });
  B.post('/ratecard/import/commit', (req, res) => {
    const rows = (req.body.rows as IMP.CommitRow[]) ?? []; if (!Array.isArray(rows) || !rows.length) throw bad('Nothing to import');
    const src = req.body.source_base64 ? { filename: String(req.body.source_filename ?? 'import.csv'), mime: 'application/octet-stream', data: b64(req.body.source_base64) } : req.body.source_text ? { filename: String(req.body.source_filename ?? 'pasted.txt'), mime: 'text/plain', data: Buffer.from(String(req.body.source_text)) } : undefined;
    res.json(IMP.commitImport(C(req), rows, int(req.body.confirm_count, 'confirmation', { min: 0 })!, src));
  });
  B.get('/attachments/:id', (req, res) => {
    const a = get(db, 'SELECT * FROM attachments WHERE id=? AND business_id=?', Number(req.params.id), C(req).bid); if (!a) throw notFound('Attachment');
    res.setHeader('Content-Type', a.mime); res.setHeader('Content-Disposition', `attachment; filename="${String(a.filename).replace(/[^\w.\- ]/g, '_')}"`); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.send(Buffer.from(a.data));
  });

  // projects & time
  B.get('/projects', (req, res) => res.json(all(db, `SELECT p.*, cl.name AS client_name FROM projects p JOIN clients cl ON cl.id=p.client_id WHERE p.business_id=? ${req.query.client_id ? 'AND p.client_id=' + Number(req.query.client_id) : ''} ORDER BY p.id DESC`, C(req).bid)));
  B.post('/projects', (req, res) => res.status(201).json({ id: REC.saveProject(C(req), null, req.body) }));
  B.get('/projects/:id', (req, res) => { const c = C(req); const id = Number(req.params.id); const f = REC.projectFinancials(c, id);
    res.json({ ...f, documents: all(db, 'SELECT id, type, number, status, total_cents, amount_paid_cents, credited_cents, currency, issue_date, due_date, title FROM documents WHERE project_id=? ORDER BY id DESC', id), expenses: REC.listExpenses(c, { project_id: id }), time: REC.listTime(c, { project_id: id }), attachments: all(db, "SELECT id, filename, mime, size FROM attachments WHERE owner_type='project' AND owner_id=?", id) }); });
  B.put('/projects/:id', (req, res) => res.json({ id: REC.saveProject(C(req), Number(req.params.id), req.body) }));
  B.get('/time', (req, res) => res.json(REC.listTime(C(req), req.query as Row)));
  B.post('/time', (req, res) => res.status(201).json({ id: REC.saveTime(C(req), null, req.body) }));
  B.put('/time/:id', (req, res) => res.json({ id: REC.saveTime(C(req), Number(req.params.id), req.body) }));
  B.delete('/time/:id', (req, res) => { const c = C(req); const id = Number(req.params.id); ensureOwned(db, 'time_entries', id, c.bid, 'Time entry'); if (get(db, "SELECT 1 FROM billing_links WHERE source_type='time' AND source_id=? AND released_at IS NULL", id)) throw conflict('Invoiced time cannot be deleted'); run(db, 'DELETE FROM billing_links WHERE source_type=\'time\' AND source_id=?', id); run(db, 'DELETE FROM time_entries WHERE id=?', id); res.json({ ok: true }); });

  // documents
  const listFor = (type: DOC.DocType) => (req: Request, res: Response) => res.json(DOC.listDocuments(C(req), type, req.query as Row));
  B.get('/estimates', listFor('estimate')); B.get('/invoices', listFor('invoice')); B.get('/credit-notes', listFor('credit_note'));
  B.post('/documents/calc', (req, res) => { // authoritative live totals for the editor (no persistence)
    const c = C(req); const out = tx(db, () => { try { return tx(db, () => { const id = DOC.saveDraft(c, null, req.body.type ?? 'invoice', req.body); const d = DOC.getDocument(c, id, { includeStale: false }); throw Object.assign(new Error('rollback'), { probe: d }); }); } catch (e: any) { if (e.probe) return e.probe; throw e; } });
    res.json({ subtotal_cents: out.subtotal_cents, discount_cents: out.discount_cents, tax_total_cents: out.tax_total_cents, total_cents: out.total_cents, tax_summary: out.tax_summary, lines: out.lines.map((l: Row) => ({ amount_cents: l.amount_cents, net_cents: l.net_cents, tax_cents: l.tax_cents, total_cents: l.total_cents, children: l.children.map((k: Row) => ({ amount_cents: k.amount_cents, net_cents: k.net_cents })) })) });
  });
  B.post('/documents', idem, (req, res) => { const type = req.body.type; if (!['estimate', 'invoice'].includes(type)) throw bad('type must be estimate or invoice'); res.status(201).json({ id: DOC.saveDraft(C(req), null, type, req.body) }); });
  B.get('/documents/:id', (req, res) => res.json(DOC.getDocument(C(req), Number(req.params.id), { includeStale: true })));
  B.put('/documents/:id', (req, res) => res.json({ id: DOC.saveDraft(C(req), Number(req.params.id), 'invoice', req.body) }));
  B.delete('/documents/:id', (req, res) => { DOC.deleteDraft(C(req), Number(req.params.id)); res.json({ ok: true }); });
  B.post('/documents/:id/issue', (req, res) => res.json(DOC.issueDocument(C(req), Number(req.params.id), { issue_date: req.body.issue_date, due_date: req.body.due_date })));
  B.post('/documents/:id/void', admin, (req, res) => res.json(DOC.voidDocument(C(req), Number(req.params.id), req.body.reason)));
  B.post('/documents/:id/duplicate', (req, res) => res.status(201).json({ id: DOC.duplicateDocument(C(req), Number(req.params.id)) }));
  B.post('/documents/:id/revise', (req, res) => res.status(201).json({ id: DOC.reviseEstimate(C(req), Number(req.params.id)) }));
  B.post('/documents/:id/accept', (req, res) => { DOC.acceptEstimate(C(req), Number(req.params.id), { by: req.body.by, note: req.body.note, method: 'manual' }); res.json(DOC.getDocument(C(req), Number(req.params.id))); });
  B.post('/documents/:id/reject', (req, res) => { DOC.rejectEstimate(C(req), Number(req.params.id), req.body.note); res.json(DOC.getDocument(C(req), Number(req.params.id))); });
  B.post('/documents/:id/convert', idem, (req, res) => res.status(201).json({ id: DOC.convertEstimate(C(req), Number(req.params.id), { mode: req.body.mode, stage_id: req.body.stage_id }) }));
  B.post('/documents/:id/refresh-pricing', (req, res) => { DOC.refreshPricing(C(req), Number(req.params.id), (req.body.line_ids ?? []).map(Number)); res.json(DOC.getDocument(C(req), Number(req.params.id))); });
  B.post('/documents/:id/credit-note', (req, res) => res.status(201).json({ id: DOC.createCreditNoteDraft(C(req), Number(req.params.id), req.body) }));
  B.post('/documents/:id/billable', (req, res) => res.json(DOC.addBillableToDraft(C(req), Number(req.params.id), { time_entry_ids: req.body.time_entry_ids, expense_ids: req.body.expense_ids, override: !!req.body.override })));
  B.post('/documents/:id/dispute', (req, res) => { const c = C(req); const d = ensureOwned(db, 'documents', req.params.id, c.bid, 'Document'); if (d.type !== 'invoice' || d.status === 'draft') throw bad('Only issued invoices can be marked disputed'); run(db, 'UPDATE documents SET disputed=?, dispute_note=? WHERE id=?', bool(req.body.disputed), str(req.body.note, 1000), d.id); audit(c, 'invoice', d.id, req.body.disputed ? 'dispute' : 'dispute_resolved', { note: req.body.note }); res.json({ ok: true }); });
  B.post('/documents/:id/due-date', (req, res) => { const c = C(req); const d = ensureOwned(db, 'documents', req.params.id, c.bid, 'Document'); if (d.type !== 'invoice' || d.status !== 'issued') throw bad('Only issued invoices can change their due date'); if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date) || req.body.due_date < d.issue_date) throw bad('Due date must be on or after the issue date'); run(db, 'UPDATE documents SET due_date=? WHERE id=?', req.body.due_date, d.id); audit(c, 'invoice', d.id, 'due_date_changed', { from: d.due_date, to: req.body.due_date }); res.json({ ok: true }); });
  B.post('/documents/:id/public-link', (req, res) => { const r = DOC.createPublicLink(C(req), Number(req.params.id), req.body.days ? int(req.body.days, 'days', { min: 1, max: 365 })! : undefined); res.json({ url: `${origin(req)}/p/${r.token}`, expires_at: r.expires_at, note: 'Anyone with this link can view this document. Copy it now — it cannot be shown again.' }); });
  B.delete('/documents/:id/public-link', (req, res) => { DOC.revokePublicLink(C(req), Number(req.params.id)); res.json({ ok: true }); });
  B.get('/documents/:id/pdf', async (req, res) => pdfRes(res, await PDF.renderDocumentPdf(C(req), Number(req.params.id), req.query.variant === 'sow' ? 'sow' : 'document'), req.query.download !== '1'));
  B.post('/documents/:id/attachments', (req, res) => { const c = C(req); const d = ensureOwned(db, 'documents', req.params.id, c.bid, 'Document'); res.status(201).json({ id: REC.addAttachment(c, d.type === 'estimate' ? 'estimate' : 'invoice', d.id, String(req.body.filename ?? 'file'), b64(req.body.data_base64)) }); });
  B.post('/documents/:id/email', async (req, res) => {
    const c = C(req); const d = DOC.getDocument(c, Number(req.params.id), { includeStale: false }); if (d.status === 'draft') throw bad('Issue the document before sending it');
    const biz = get(db, 'SELECT legal_name, trading_name FROM businesses WHERE id=?', c.bid)!; const name = biz.trading_name || biz.legal_name; const label = d.type === 'estimate' ? 'Estimate' : d.type === 'credit_note' ? 'Credit note' : 'Invoice';
    const subject = str(req.body.subject, 300) ?? `${label} ${d.number} from ${name}`; const body = str(req.body.body, 10000) ?? `Hello ${d.client.name},\n\nPlease find ${label.toLowerCase()} ${d.number} attached.\n\nThank you,\n${name}`;
    const rcpt = req.body.to ?? d.client?.email; if (req.body.send !== false && o.mailer.configured && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(rcpt ?? ''))) throw bad('Enter a valid recipient email address');
    const pdf = req.body.attach_pdf === false ? null : await PDF.renderDocumentPdf(c, d.id);
    const r = await sendOrDraft(c, o.mailer, { document_id: d.id, client_id: d.client_id, kind: d.type, to: req.body.to ?? d.client?.email, subject, body, attach: pdf ? { filename: pdf.filename, content: pdf.buffer } : null, send: req.body.send !== false });
    res.status(r.status === 'failed' ? 502 : 200).json(r);
  });

  // payments
  B.get('/payments', (req, res) => res.json(PAY.listPayments(C(req), req.query as Row)));
  B.post('/payments', idem, (req, res) => { const r = PAY.recordPayment(C(req), { ...req.body, idempotency_key: req.body.idempotency_key ?? req.header('Idempotency-Key') }); res.status(r.duplicate ? 200 : 201).json(r); });
  B.get('/payments/:id', (req, res) => res.json(PAY.getPayment(C(req), Number(req.params.id))));
  B.post('/payments/:id/void', admin, (req, res) => { PAY.voidPayment(C(req), Number(req.params.id), req.body.reason); res.json(PAY.getPayment(C(req), Number(req.params.id))); });
  B.post('/payments/:id/allocate', (req, res) => { PAY.allocateExisting(C(req), Number(req.params.id), Number(req.body.invoice_id), Number(req.body.amount_cents)); res.json(PAY.getPayment(C(req), Number(req.params.id))); });
  B.get('/payments/:id/receipt', async (req, res) => pdfRes(res, await PDF.renderReceiptPdf(C(req), Number(req.params.id)), req.query.download !== '1'));
  B.post('/payments/:id/email-receipt', async (req, res) => {
    const c = C(req); const p = PAY.getPayment(c, Number(req.params.id)); const cl = get(db, 'SELECT name, email FROM clients WHERE id=?', p.client_id)!; const biz = get(db, 'SELECT legal_name, trading_name FROM businesses WHERE id=?', c.bid)!;
    const pdf = await PDF.renderReceiptPdf(c, p.id); const r = await sendOrDraft(c, o.mailer, { payment_id: p.id, client_id: p.client_id, kind: 'receipt', to: req.body.to ?? cl.email, subject: str(req.body.subject, 300) ?? `Receipt ${p.receipt_number} from ${biz.trading_name || biz.legal_name}`, body: str(req.body.body, 5000) ?? `Hello ${cl.name},\n\nThank you for your payment. Your receipt ${p.receipt_number} is attached.\n\n${biz.trading_name || biz.legal_name}`, attach: { filename: pdf.filename, content: pdf.buffer }, send: req.body.send !== false });
    res.status(r.status === 'failed' ? 502 : 200).json(r);
  });

  // expenses
  B.get('/expense-categories', (req, res) => res.json(all(db, 'SELECT * FROM expense_categories WHERE business_id=? ORDER BY name', C(req).bid)));
  B.post('/expense-categories', (req, res) => { try { res.status(201).json({ id: insert(db, 'INSERT INTO expense_categories (business_id, name) VALUES (?,?)', C(req).bid, reqStr(req.body.name, 'Name', 80)) }); } catch (e: any) { if (/UNIQUE/.test(e.message)) throw conflict('Category exists'); throw e; } });
  B.get('/expenses', (req, res) => res.json(REC.listExpenses(C(req), req.query as Row)));
  B.post('/expenses', (req, res) => res.status(201).json({ id: REC.saveExpense(C(req), null, req.body) }));
  B.put('/expenses/:id', (req, res) => res.json({ id: REC.saveExpense(C(req), Number(req.params.id), req.body) }));
  B.delete('/expenses/:id', (req, res) => { const c = C(req); const id = Number(req.params.id); ensureOwned(db, 'expenses', id, c.bid, 'Expense'); if (get(db, "SELECT 1 FROM billing_links WHERE source_type='expense' AND source_id=?", id)) throw conflict('This expense has been invoiced; it cannot be deleted'); tx(db, () => { run(db, "DELETE FROM attachments WHERE owner_type='expense' AND owner_id=?", id); run(db, 'DELETE FROM expenses WHERE id=?', id); audit(c, 'expense', id, 'delete'); }); res.json({ ok: true }); });
  B.post('/expenses/:id/attachments', (req, res) => res.status(201).json({ id: REC.addAttachment(C(req), 'expense', Number(req.params.id), String(req.body.filename ?? 'receipt'), b64(req.body.data_base64)) }));
  B.get('/expenses/:id/attachments', (req, res) => { ensureOwned(db, 'expenses', req.params.id, C(req).bid, 'Expense'); res.json(all(db, "SELECT id, filename, mime, size, created_at FROM attachments WHERE owner_type='expense' AND owner_id=?", Number(req.params.id))); });
  B.delete('/attachments/:id', (req, res) => { const a = get(db, 'SELECT * FROM attachments WHERE id=? AND business_id=?', Number(req.params.id), C(req).bid); if (!a) throw notFound('Attachment'); if (a.owner_type === 'import') throw forbidden('Import records are retained'); run(db, 'DELETE FROM attachments WHERE id=?', a.id); audit(C(req), 'attachment', a.id, 'delete', { filename: a.filename }); res.json({ ok: true }); });

  // recurring & reminders
  B.get('/recurring', (req, res) => res.json(RCR.listSchedules(C(req))));
  B.post('/recurring', (req, res) => res.status(201).json({ id: RCR.saveSchedule(C(req), null, req.body) }));
  B.put('/recurring/:id', (req, res) => res.json({ id: RCR.saveSchedule(C(req), Number(req.params.id), req.body) }));
  B.post('/recurring/run', admin, (req, res) => res.json(RCR.runRecurring(db, bizToday(db, C(req).bid), C(req).bid)));
  B.post('/reminders/run', admin, async (req, res) => res.json(await RCR.runReminders(db, bizToday(db, C(req).bid), o.mailer, C(req).bid)));
  B.get('/communications', (req, res) => res.json(all(db, `SELECT cm.*, d.number AS document_number FROM communications cm LEFT JOIN documents d ON d.id=cm.document_id WHERE cm.business_id=? ORDER BY cm.id DESC LIMIT 200`, C(req).bid)));

  // reports & exports
  B.get('/dashboard', (req, res) => res.json(RPT.dashboard(C(req), req.query as Row)));
  B.get('/reports', (_req, res) => res.json(RPT.REPORTS));
  B.get('/reports/:name', async (req, res) => {
    const r = RPT.runReport(C(req), String(req.params.name), req.query as Row); const fmt = String(req.query.format ?? 'json');
    if (fmt === 'csv') { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${r.name}.csv"`); return void res.send(RPT.reportToCsv(r)); }
    if (fmt === 'pdf') return pdfRes(res, await PDF.renderReportPdf(C(req), r), false);
    res.json(r);
  });
  B.get('/export/business.zip', admin, (req, res) => { audit(C(req), 'export', null, 'business_zip'); res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="ledgerflow-export-${bizToday(db, C(req).bid)}.zip"`); res.send(BAK.exportBusinessZip(C(req))); });
  const soleOwner = (req: Request) => { const others = get(db, "SELECT COUNT(*) n FROM businesses b WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.business_id=b.id AND m.user_id=? AND m.role='owner')", req.user!.id)!; if (Number(others.n) > 0) throw forbidden('Server backups contain every workspace on this server, so only a user who owns all of them can make one. Use the business export instead.'); };
  B.post('/backups', min('owner'), (req, res) => { soleOwner(req); const r = BAK.createBackup(db, o.backupDir); audit(C(req), 'backup', null, 'create', { file: path.basename(r.file) }); const v = BAK.verifyBackup(r.file); res.status(201).json({ file: path.basename(r.file), sha256: r.sha256, counts: r.counts, verification: v }); });
  B.get('/backups', min('owner'), (req, res) => { soleOwner(req); const files = fs.existsSync(o.backupDir) ? fs.readdirSync(o.backupDir).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => ({ file: f, size: fs.statSync(path.join(o.backupDir, f)).size })) : []; res.json(files); });
  B.get('/backups/:file', min('owner'), (req, res) => { soleOwner(req); const f = path.basename(String(req.params.file)); if (!/^ledgerflow-[\w\-]+\.db$/.test(f)) throw bad('Bad file name'); const p = path.join(o.backupDir, f); if (!fs.existsSync(p)) throw notFound('Backup'); res.download(p); });
  B.get('/audit', admin, (req, res) => res.json(all(db, `SELECT a.*, u.name AS user_name FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE a.business_id=? ${req.query.entity ? 'AND a.entity=?' : ''} ${req.query.entity_id ? 'AND a.entity_id=?' : ''} ORDER BY a.id DESC LIMIT 300`, C(req).bid, ...(req.query.entity ? [String(req.query.entity)] : []), ...(req.query.entity_id ? [Number(req.query.entity_id)] : []))));

  // ---- public document links (token-gated; minimal data) ---------------------------------------------------
  const origin = (req: Request) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.headers.host}`;
  const pub = (req: Request) => { if (!publicLimiter.check(req.ip ?? 'x')) throw new HttpError(429, 'Too many requests'); const d = DOC.documentByToken(db, String(req.params.token)); if (!d) throw notFound('Document'); return d; };
  api.get('/public/:token', (req, res) => {
    const d = pub(req); const c: Ctx = { db, bid: d.business_id, uid: null, role: 'viewer' };
    if (!d.public_viewed_at) run(db, "UPDATE documents SET public_viewed_at=datetime('now') WHERE id=?", d.id);
    const full = DOC.getDocument(c, d.id, { includeStale: false }); const biz = full.business_snapshot ?? {};
    res.json({ type: full.type, number: full.number, status: full.status, display_status: full.display_status, currency: full.currency, issue_date: full.issue_date, due_date: full.due_date, valid_until: full.valid_until, title: full.title, notes: full.notes, terms: full.terms, scope: full.scope, deliverables: full.deliverables, assumptions: full.assumptions, exclusions: full.exclusions,
      subtotal_cents: full.subtotal_cents, discount_cents: full.discount_cents, tax_total_cents: full.tax_total_cents, total_cents: full.total_cents, balance_cents: full.balance_cents, tax_summary: full.tax_summary, prices_include_tax: full.prices_include_tax,
      lines: full.lines.map((l: Row) => ({ description: l.description, detail: l.detail, unit: l.unit, qty_milli: l.qty_milli, unit_price_cents: l.unit_price_cents, net_cents: l.net_cents, package_id: l.package_id, package_display: l.package_display, is_component: l.is_component, children: l.children.map((k: Row) => ({ description: k.description, unit: k.unit, qty_milli: k.qty_milli, unit_price_cents: k.unit_price_cents, net_cents: k.net_cents, is_component: k.is_component })) })),
      business: { name: biz.trading_name || biz.legal_name, email: biz.email, phone: biz.phone }, client_name: full.client_snapshot?.name, accepted_at: full.accepted_at, accepted_by: full.accepted_by, rejected_at: full.rejected_at, can_respond: full.type === 'estimate' && full.status === 'issued' && !(full.valid_until && full.valid_until < bizToday(db, d.business_id)) });
  });
  api.get('/public/:token/pdf', async (req, res) => { const d = pub(req); pdfRes(res, await PDF.renderDocumentPdf({ db, bid: d.business_id, uid: null, role: 'viewer' }, d.id), true); });
  api.post('/public/:token/accept', (req, res) => { const d = pub(req); if (d.type !== 'estimate') throw bad('Only estimates can be accepted'); const name = reqStr(req.body.name, 'Your name', 120); DOC.acceptEstimate({ db, bid: d.business_id, uid: null, role: 'viewer' }, d.id, { by: name, note: str(req.body.note, 500), method: 'public_link' }); res.json({ ok: true }); });
  api.post('/public/:token/reject', (req, res) => { const d = pub(req); if (d.type !== 'estimate') throw bad('Only estimates can be declined'); DOC.rejectEstimate({ db, bid: d.business_id, uid: null, role: 'viewer' }, d.id, str(req.body.note, 500)); res.json({ ok: true }); });

  api.use((_req, _res, next) => next(notFound('Endpoint')));

  // ---- static SPA ------------------------------------------------------------------------------------------
  if (o.webDir && fs.existsSync(path.join(o.webDir, 'index.html'))) {
    app.use(express.static(o.webDir, { index: false, maxAge: '1h', setHeaders: (r, p) => { if (p.endsWith('index.html')) r.setHeader('Cache-Control', 'no-store'); } }));
    app.get('/{*splat}', (req, res, next) => (req.path.startsWith('/api') ? next() : res.sendFile(path.join(path.resolve(o.webDir!), 'index.html'))));
  }

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, details: err.details });
    const msg = String(err?.message ?? err);
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request too large' });
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON' });
    // database integrity rules (triggers / unique / check) surface as clean 4xx responses
    if (String(err?.code ?? '').startsWith('ERR_SQLITE')) {
      if (/UNIQUE constraint failed/.test(msg)) return void res.status(409).json({ error: 'That record already exists (duplicate rejected)' });
      if (/FOREIGN KEY|CHECK constraint|NOT NULL/.test(msg)) return void res.status(400).json({ error: 'Invalid data for this operation' });
      if (/immutable|exceeds|void|Allocation|Credits|Refund|Invoice must|Payment and|Issued documents|Only draft|cannot be reopened/i.test(msg)) return void res.status(409).json({ error: msg });
    }
    log.error({ err: msg, stack: o.quiet ? undefined : String(err?.stack ?? '').split('\n').slice(0, 4).join(' | '), path: req.path });
    res.status(500).json({ error: 'Something went wrong on the server' });
  });
  void calcDocument; void DOC.verifyDocument; void getSettings; void RCR; void int;
  return app;
}
