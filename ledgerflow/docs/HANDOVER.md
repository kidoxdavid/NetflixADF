# LedgerFlow — handover

Status legend: ✅ complete and covered by automated tests · 🟡 implemented, manually verified or with stated limits · ⛔ not implemented.

## 1. Architecture summary
```
web/ (React 19 + Vite SPA)  ──/api──▶  server/src/app.ts (Express 5)
                                          ├─ core.ts        validation helpers, settings, numbering, audit
                                          ├─ calc.ts/money.ts  deterministic money & tax (integer cents, BigInt rounding)
                                          ├─ ratecard.ts / importer.ts   catalogue, packages, history, versions, import
                                          ├─ documents.ts   quotes/invoices/credit notes, snapshots, conversion, stages
                                          ├─ payments.ts    payments, refunds, allocations, receipts numbers
                                          ├─ records.ts     business, tax, clients, projects, time, expenses, uploads
                                          ├─ recurring.ts   recurring invoices + reminders (idempotent)
                                          ├─ reports.ts / pdf.ts / mail.ts / backup.ts
                                          └─ db.ts + schema.ts   SQLite (node:sqlite), migrations, triggers
```
Financial integrity is enforced **in the database**: triggers make issued documents and their lines immutable, forbid allocating more than a payment or an invoice allows, forbid cross-business allocations, and keep `amount_paid_cents` equal to the sum of live allocations; unique indexes guarantee document numbers, receipt numbers, idempotency keys, recurring runs, one-time billing of time/expenses, and one full conversion per quote.

Money: integer cents; quantities in thousandths; percentages in thousandths of a percent (9.975 % = 9975). Rounding: half away from zero. Tax is computed **once per tax code per document** (taxable base summed, then rounded) — an accepted CRA-style method — and tax-inclusive pricing back-calculates tax with exact remainder allocation so totals always equal the entered price. Document discounts are allocated across lines with largest-remainder so no cent is lost.

## 2. Features
| Area | Status | Notes |
|---|---|---|
| Business profile, multiple workspaces, roles (owner/admin/staff/viewer) | ✅ | profile fields all optional except legal name; workspaces isolated; new workspace from the workspace menu |
| Rate card: services, add-ons, fees, packages (fixed or itemized; combined or itemized display), categories, units, min qty / min booking, pricing types (fixed, starting-from, custom quote, on request), tax treatment per item, public/private flags, internal cost & notes, duplicate, archive, search/filter | ✅ | |
| Rate-card price history, snapshots (“versions”), compare to current, bulk % adjustment | ✅ | `effective_date` is a **label only**; it does not schedule future price changes |
| Rate-card import (CSV/TSV mapping, preview, validation, duplicates, confirmation count, results CSV, original file kept) | ✅ | |
| Import from pasted text and text-based PDF | 🟡 | heuristic; every row flagged for review |
| Import from scanned PDF / image (OCR), or `.xlsx` directly | ⛔ | clear message shown; save as CSV or paste text |
| Rate-card PDF (4 templates, logo, accent colour, hides private data) and CSV export | ✅ | PDF text verified by `pdftotext` in tests |
| Clients, contacts, tags, archive, CSV export, consolidated view, client-specific agreed rates (with standard vs agreed shown) | ✅ | |
| Projects with budget vs invoiced/received/expenses/time, time tracking, billable time and expenses → invoice (once only, explicit override) | ✅ | |
| Quotes: from rate card, revisions with history, accept/reject, secure public link (hashed token, expiry, revoke), SoW PDF variant, duplicate, stages (deposit/milestone/balance) | ✅ | “viewed” is recorded only when the link is actually opened; acceptance is labelled *manual* vs *verified via link* |
| Quote → invoice (full or per stage), no duplicate billing | ✅ | |
| Invoices: numbering, snapshots, statuses (draft/issued/partially paid/paid/overdue/credited/void), credit notes, disputes, due-date change, void with reason, attachments | ✅ | refunds via negative payment |
| Payments: partial/multiple, unapplied payments held on account then applied, refunds, void, receipts (PDF), idempotency | ✅ | all “manual” unless a provider verified them |
| Online payment provider (e.g. Stripe) | ⛔ | data model reserves `verification/provider/provider_ref` (unique) for a future webhook integration; none is wired up |
| Canadian tax: configurable codes, defaults, exempt clients/lines/documents, inclusive pricing, tax summary, tax reports | ✅ | no assumptions; presets are optional |
| Expenses: categories, tax paid, billable, receipts (content-sniffed uploads), reimbursement status | ✅ | no receipt OCR (amounts are never auto-filled) |
| Recurring invoices (weekly/monthly/quarterly/yearly) + reminders | ✅ | never takes payment |
| Email (SMTP), communication history (prepared / sent / failed) | 🟡 | logic tested with a fake transport (incl. failure); not tested against a real SMTP server |
| PDFs: rate card, quote, SoW, invoice, credit note, receipt, reports; 4 templates; multi-page with repeated headers; totals kept with last rows | ✅ | standard PDF fonts: Latin-1/WinAnsi characters only (others print as `?`) |
| Dashboard & 14 reports with filters, CSV, PDF | ✅ | per-currency only |
| Multi-currency | 🟡 | each document has its own currency; reports never mix currencies; **no exchange-rate conversion** |
| Backup / verify / restore CLI, in-app backup, full ZIP export | ✅ | |
| Accessibility | 🟡 | labelled controls, keyboard operation, focus rings, skip link, dark mode; **no formal WCAG 2.2 AA audit** |
| Double-entry accounting, payroll, inventory, bank feeds, e-signatures, accounting-software sync | ⛔ | out of scope |

## 3. How the existing rate card was incorporated
**It was not — because it was not available.** The repository contained only an unrelated Netflix dataset and no rate-card file exists anywhere on the machine. No service, rate, unit or package was invented or pre-loaded. LedgerFlow therefore ships **empty** with the complete import/entry workflow, and the dashboard reminds you that the rate card is empty. Once you import yours, verify every row in the review step against the source document. `npm run seed:demo` creates a clearly fictional demo workspace (“DEMO RATE” items) only if you ask for it.

## 4. Rate-card import instructions
1. Rate Card → **Import**.
2. *File:* upload a CSV/TSV (Excel/Sheets → Save as CSV). Common headers (Service, Category, Rate/Price, Unit, Description…) are matched automatically; adjust the column mapping. *Text:* paste lines like `Reel edit ..... $120` (short lines without numbers become categories). *PDF:* text-based PDFs are read; scanned PDFs/images are rejected with instructions.
3. Review table: ⛔ rows (unreadable price, ranges like “500–900”, more than 2 decimals, missing name) must be fixed inline or unticked; ⚠ rows (unit guessed, “custom quote”, no price → “price on request”, currency differs) need your eyes; possible duplicates default to *Skip* (choose *Update its rate* or *Create anyway*).
4. Type the number of records to confirm → **Import**. A results summary (CSV download) and the original file are kept (attachment recorded in the audit log).
Packages cannot be imported from a file; create them under *Add package* after import.

## 5. Incomplete features and blockers
* No OCR; no direct `.xlsx` reading; no real-SMTP or real-browser-matrix verification; no payment-provider integration; no FX conversion; no scheduled future prices; no WCAG audit; the UI has a manual Playwright smoke script (`scripts/ui-smoke.cjs`), not CI-run component tests.
* Single-process, single-file database: ideal for one business; not designed for hundreds of concurrent users or multi-server clustering.
* Login throttling and the public-link rate limiter are in-memory (reset on restart).
* The Dockerfile is an untested template.

## 6. Database / migrations
SQLite file `data/ledgerflow.db` (WAL mode). 40+ tables incl. `documents`/`document_lines` (snapshots), `payments`/`payment_allocations`, `rc_items`/`rc_item_history`/`rc_versions`, `client_prices`, `billing_stages`, `billing_links`, `recurring_schedules`/`recurring_runs`, `communications`, `audit_events`, `idempotency_keys`. Migration `1 initial` creates everything; future changes are appended to `MIGRATIONS` and applied transactionally at start. `schema_migrations` records what ran.

## 7–8. Install and start
```bash
cd ledgerflow && npm install && npm run build && npm start       # production-style, http://127.0.0.1:3000
npm run dev                                                        # development (API :3000, web :5173)
```

## 9. Tests and actual results
`npm run typecheck` → clean. `npm test` → **56 tests, 56 pass, 0 fail** (last run in this build session):
* `calc.test.ts` (14): rounding, hourly/daily, GST/HST/QST/PST, per-document tax rounding, inclusive pricing, exempt lines, discounts (percent/fixed/document-level allocation), package components, allocation exactness.
* `ratecard.test.ts` (10): create/edit/versioned prices, validation, duplicate/SKU, packages & add-ons, pricing types, CSV import (mapping, ambiguity, duplicates, confirmation, update path, original kept), text extraction, versions compare, bulk adjust, CSV/PDF export hiding private data.
* `workflow.test.ts` (14): the full scenario — business → tax → rate card → client (agreed rate) → project → quote (+PDF inspected) → issue → immutability → accept → stage invoices (deposit/balance sum exactly) → rate increase leaves documents untouched → stale-price refresh only on request → partial/final payment → over-payment refused → idempotent retry → receipt PDF/email → expense + upload sniffing → dashboard → billable time/expenses once only → credit note → exports/ZIP → **backup, corruption detection, restore** → integrity sweep.
* `security.test.ts` (18): auth required everywhere, HttpOnly cookie, cross-business isolation (API + DB), role permissions, CSRF, registration closed, concurrent invoice numbering (12 parallel issues → unique gap-free), duplicate submissions, invalid amounts, server-authoritative tax/prices, tax snapshots, recurring duplicate prevention, reminder dedupe/exclusions/failed email, honest email states, public-link security, unsafe uploads, CSV formula injection, headers/SQL-injection probes, login throttling.
Manual browser run (Playwright, desktop 1280 px and mobile 390 px): onboarding → tax → CSV import → client → quote with a custom-quote line (issue disabled until price confirmed) → issue → accept → convert → issue → partial payment → PDF preview → dashboard; **no page overflow on mobile; no JavaScript errors**. Visual PDF inspection of all four templates on a 34-line, 3-page invoice.

## 10. Create a quote from the rate card
Quotes → *New quote* → pick the client → type in “Search your rate card” (↑/↓/Enter) → adjust quantities → add custom lines or a discount → set scope/deliverables/stages → *Preview PDF* → *Issue quote*. Lines for custom-quote/starting-from/on-request services need their price entered and “price confirmed” ticked before issuing.

## 11. Convert to invoice
Issue the quote → *Record acceptance* (or send the secure link) → *Convert to invoice (full)* or, for deposits/milestones, *Create invoice for this stage*. Review the draft and *Issue invoice*. Prices are copied from the quote, so later rate-card changes never affect it.

## 12. Payments and receipts
Invoice → *Record payment* (amount, date, method, reference). Partial payments update the balance and status; receipts are numbered (RCT-0001…) and downloadable from Payments (*Receipt*) or emailable. Refunds: tick “refund”. Mistakes: *Void* the payment (admin) with a reason; it stays on record.

## 13. Canadian taxes
Settings → Taxes: add codes (e.g. GST 5 %, QST 9.975 %) or use presets, tick defaults. Per rate-card item choose *business default* or *tax-exempt*; per line you can override; per client mark *tax exempt* (with the exemption reference); per document choose tax-inclusive. Changing a rate affects only future documents. **You** must confirm registration, rates, place of supply and filing — the app does not.

## 14. PDFs and email
PDFs: *View PDF* / *Download* on any document; choose template and colour under Settings → Documents & look; logo under Business. Email: set `SMTP_*` in `.env`, restart; then *Share / send* → *Send email with PDF*. Without SMTP: *Save as draft*, *Copy message*, *Open in my email app*, or download the PDF.

## 15. Backup and restore
See README. Verified in this session through the real CLI: backup → verify (5 checks) → delete DB → restore → identical document/payment counts.

## 16. Deployment options and likely costs (estimates; check current prices)
| Option | Typical cost | Notes |
|---|---|---|
| Your own computer / home server / Raspberry Pi | $0 plus power | easiest; reach it from other devices via your LAN or a tunnel |
| Small VPS (1 vCPU / 1 GB) behind Caddy or nginx (TLS) | roughly CAD 5–12 / month | `HOST=0.0.0.0`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, `PUBLIC_URL=https://…` |
| Domain name | roughly CAD 15–25 / year | needed for TLS and client links |
| SMTP email | $0 on many providers’ free tiers up to a small monthly volume; paid beyond | optional |
| Off-site backups | usually cents per month | e.g. object storage or a cloud drive |
Run under systemd/pm2 (`npm start`) or build the included Dockerfile (untested). Keep the data directory on durable storage and back it up.

## 17. Security considerations
scrypt password hashing (N=16384), random 256-bit session tokens stored only as SHA-256 hashes, HttpOnly + SameSite=Lax cookies (`Secure` when `COOKIE_SECURE=true`), login throttling, CSRF defence (custom header + same-origin check), strict CSP/`nosniff`/frame headers, per-business authorisation on every route (404 for foreign ids), parameterised SQL everywhere, server-side validation of every amount, server-authoritative tax and rate-card prices, immutable issued documents (DB triggers), content-sniffed uploads served as sandboxed attachments, spreadsheet-formula-neutralised CSV, public links with 256-bit hashed tokens that expire and can be revoked and expose no client contact details, audit log for significant changes, no secrets in logs. Remaining responsibilities: run behind HTTPS, keep Node updated, protect `.env` and backups (they contain password hashes), use a strong owner password. Staff/viewer accounts exist but there is no 2-factor authentication.

## 18. Manual setup still required
Business profile and logo · tax codes and defaults (after confirming with the CRA/your accountant) · import or enter your rate card and verify it · numbering, payment terms and instructions · SMTP (optional) · HTTPS/domain if used remotely · scheduled `npm run backup` and an off-site copy · a practice restore.
