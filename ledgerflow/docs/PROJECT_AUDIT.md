# Project audit (Phase 1)

**Repository found:** `kidoxdavid/NetflixADF` — contained only a Databricks notebook archive (`Netflix Project.dbc`), five Netflix CSV files and a one-line README. None of it relates to invoicing; it was left untouched. The application lives in `ledgerflow/`.

**Rate-card search:** the whole filesystem was searched for spreadsheets, CSV/PDF/Word files, images and anything named rate/price/invoice. **No rate card, price list or past invoice was available.** Therefore no rates are pre-loaded; the import workflow and manual entry are the supported routes (see HANDOVER §3).

**Environment:** Node 22.22 (built-in SQLite), npm registry reachable, Chromium/Playwright and poppler available for QA. No Docker daemon.

## Architecture decision
| Need | Choice | Why |
|---|---|---|
| Users | one self-hosting professional, optionally a few staff | SQLite is simple, durable, backup = one file |
| Backend | TypeScript, Express 5, `node:sqlite`, `tsx` | no native modules; typed; tiny dependency list |
| Frontend | React 19 + Vite, hand-written CSS | no UI framework lock-in, small bundle |
| Money | integer cents; quantities in thousandths; % in thousandths of a percent; BigInt rounding (half away from zero) | no floating point anywhere authoritative |
| PDF | PDFKit | free, server-side, real vector PDFs |
| Email | nodemailer / any SMTP | optional |
| Integrity | SQLite triggers + unique indexes + transactions (`BEGIN IMMEDIATE`) | rules hold even if app code is wrong |

## Risks considered
Scanned/image rate cards (no OCR bundled) · tax misconfiguration (defaults empty, warnings everywhere) · duplicate billing (unique indexes + idempotency keys) · rate changes rewriting history (line snapshots + immutability triggers) · cross-tenant leaks (membership check on every route; 404 for foreign ids; DB-level tenant checks on allocations) · backup false confidence (verification recomputes every document).
