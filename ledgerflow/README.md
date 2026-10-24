# LedgerFlow

A self-hostable quoting, invoicing and small-business finance app built around **your rate card**:

`Rate card → Client → Quote → Approval → Invoice → Payment → Receipt → Expenses → Reports`

* One Node.js process, one SQLite file (all data, receipts and logos inside it), no paid services required.
* Money is stored as integer cents; every calculation happens on the server; issued documents are locked by the database itself.
* Canadian-first (GST/HST/PST/QST are configurable tax codes — nothing is assumed), but currency and tax are data, not code.

> **Rate card status:** no rate card file was available in this repository or environment (the repo only contained an unrelated Netflix dataset), so **no rates are pre-loaded**. Nothing was invented. Import your own rates (CSV / pasted text / text PDF) or enter them by hand — see [docs/HANDOVER.md](docs/HANDOVER.md#3-how-the-existing-rate-card-was-incorporated).

## Requirements
* Node.js **22.13+** (uses the built-in `node:sqlite`; no native modules to compile)
* `pdftotext` (poppler-utils) is optional — only used to read text-based PDFs during rate-card import and in tests

## Install and run
```bash
cd ledgerflow
npm install
cp .env.example .env        # optional; defaults work for local use
npm run build               # builds the web app into web/dist
npm start                   # http://127.0.0.1:3000  — first visit creates the owner account
```
Development with hot reload (API on :3000, web on :5173):
```bash
npm run dev
```
Quality gates:
```bash
npm run typecheck
npm test                    # 56 automated tests (calculations, rate card, workflow, security)
```
Optional fictional demo workspace (never run automatically): `npm run seed:demo`.

## First-time setup (about 10 minutes)
1. Open the app → create the owner account → fill in the business profile (registration numbers are optional).
2. **Settings → Taxes:** add only the taxes that apply to *you* (presets are provided for convenience; verify them) and tick the ones that should be defaults. Leave empty if you do not charge tax.
3. **Settings → Numbering & terms:** prefix/next number, payment terms, payment instructions. **Documents & look:** template, accent colour; upload your logo under Business.
4. **Rate Card → Import** your existing rates, then tidy categories, units, packages and add-ons.
5. Add a client → **Quotes → New quote** → search the rate card → Issue → record acceptance → convert to invoice → record payments.

## Everyday workflows
| Task | Where |
|---|---|
| Quote from the rate card | Quotes → New quote. Search, pick services/packages, adjust quantity, add custom lines, discounts, scope, payment stages, **Issue**. |
| Client-specific rate | Client → Agreed rates. Shown as “standard $X / agreed $Y” on the quote; the global rate card is never changed. |
| Record acceptance | Open the issued quote → *Record acceptance* (labelled “recorded manually”), or share the **secure link** so the client accepts it (labelled “verified via secure link”). |
| Deposit / milestone invoices | Define stages on the quote; after acceptance use *Create invoice for this stage*. Stages can never be billed twice. |
| Convert quote → invoice | Open the accepted quote → *Convert to invoice (full)* (copies the agreed prices; a second conversion is refused). |
| Record a payment | Invoice → *Record payment* (partial payments allowed; over-payment is rejected). Receipt PDF is generated automatically. |
| Corrections | Issued invoices are immutable: *Issue credit note*, *Void* (only if unpaid), *Mark disputed*, *Change due date* — each is logged. |
| Billable time/expenses | Log time on a project / expense with “billable”; in a draft invoice use *+ Billable time & expenses*. Each item can be invoiced once. |
| Recurring | Recurring → schedule (monthly retainer etc.). Creates drafts or auto-issues invoices; **never charges anyone**. |
| Reports / exports | Reports (CSV/PDF per report) and Reports → *Export all data (ZIP)*. |

## Email
Optional. Set the `SMTP_*` variables in `.env`. Without them the app still works: download PDFs, copy the secure link or message text, or open your own email app. The communication history distinguishes **prepared (not sent)**, **sent** and **failed**, and the UI never says “sent” unless the SMTP server accepted the message.

## Scheduler
Recurring invoices and payment reminders run from an in-process job (at start and hourly). To use the system scheduler instead set `SCHEDULER=off` and run `npm run jobs` from cron/systemd. Both are idempotent: every recurring period and every reminder offset is protected by a database unique key, so retries and overlapping runs cannot duplicate invoices or reminders.

## Backups and restore
```bash
npm run backup                                 # consistent copy + SHA-256 manifest + automatic verification
npm run verify-backup -- data/backups/<file>.db  # integrity, foreign keys, and recomputes every document total/balance
# restore (stop the server first!)
npm run restore -- data/backups/<file>.db      # verifies, keeps the old DB as *.pre-restore-<time>, then restores
```
A backup is one SQLite file containing **everything** (all workspaces, users, attachments, logos). It excludes `.env`. Copy backups off the machine (e.g. with `rclone`, `restic`, or a cloud drive). The in-app *Settings → Backup & export* also creates/verifies backups and downloads a **portable ZIP export** (JSON + CSV for every record, attachments, logo). Schedule `npm run backup` with cron, e.g. `15 2 * * * cd /srv/ledgerflow && npm run -s backup`. A backup is only “verified” if `verify-backup` reports PASSED; test a restore on a spare machine now and then.

## Migrations
Schema changes are numbered migrations in `server/src/schema.ts`, applied automatically and transactionally on start (table `schema_migrations`). Never edit an applied migration; append a new one. Take a backup before upgrading.

## Documents
More detail: [docs/HANDOVER.md](docs/HANDOVER.md) (architecture, completeness, security, costs, deployment) and [docs/PROJECT_AUDIT.md](docs/PROJECT_AUDIT.md).

**Tax and legal notice.** LedgerFlow does not know whether you must register for or charge GST/HST/PST/QST, which rate applies to a sale, or how to file. You must confirm registration, rates, place-of-supply rules and filing obligations yourself (CRA / Revenu Québec / your accountant). The software does not guarantee compliance and is not tax or legal advice. A quote or statement of work produced here is a commercial document, not necessarily a legally sufficient contract in your jurisdiction.
