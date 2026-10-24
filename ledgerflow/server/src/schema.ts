/** Ordered migrations. Never edit an applied migration; append a new one. */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
{ id: 1, name: 'initial', sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE businesses (
  id INTEGER PRIMARY KEY, legal_name TEXT NOT NULL, trading_name TEXT,
  address TEXT, email TEXT, phone TEXT, website TEXT,
  registration_info TEXT, tax_registration_label TEXT, tax_registration_number TEXT,
  currency TEXT NOT NULL DEFAULT 'CAD', timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  locale TEXT NOT NULL DEFAULT 'en-CA', date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
  logo BLOB, logo_mime TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','staff','viewer')),
  PRIMARY KEY (user_id, business_id)
);
CREATE TABLE tax_codes (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, rate_milli INTEGER NOT NULL CHECK (rate_milli >= 0 AND rate_milli <= 100000),
  note TEXT, is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (business_id, name)
);
CREATE TABLE number_sequences (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','estimate','credit_note','receipt')),
  prefix TEXT NOT NULL DEFAULT '', next_number INTEGER NOT NULL DEFAULT 1, padding INTEGER NOT NULL DEFAULT 4,
  PRIMARY KEY (business_id, kind)
);
CREATE TABLE clients (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'business' CHECK (type IN ('individual','business')),
  name TEXT NOT NULL, company TEXT, email TEXT, phone TEXT, billing_address TEXT, service_address TEXT,
  currency TEXT, payment_terms_days INTEGER, tax_exempt INTEGER NOT NULL DEFAULT 0, tax_exempt_note TEXT,
  notes TEXT, tags TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_clients_biz ON clients(business_id, archived);
CREATE TABLE client_contacts (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL, role TEXT, email TEXT, phone TEXT, is_primary INTEGER NOT NULL DEFAULT 0
);

-- Rate card ----------------------------------------------------------------
CREATE TABLE rc_categories (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_id, name)
);
CREATE TABLE rc_items (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES rc_categories(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service','addon','fee','package')),
  sku TEXT, name TEXT NOT NULL, short_desc TEXT, long_desc TEXT,
  unit TEXT NOT NULL DEFAULT 'project',
  pricing_type TEXT NOT NULL DEFAULT 'fixed' CHECK (pricing_type IN ('fixed','starting_from','custom_quote','on_request')),
  rate_cents INTEGER, currency TEXT NOT NULL DEFAULT 'CAD',
  default_qty_milli INTEGER NOT NULL DEFAULT 1000, min_qty_milli INTEGER, min_amount_cents INTEGER,
  duration TEXT, delivery_time TEXT, revisions INTEGER, platforms INTEGER, deliverable_count INTEGER,
  usage_rights TEXT, included TEXT, exclusions TEXT,
  tax_code_ids TEXT, -- JSON array of tax_codes ids; NULL = business default taxes; [] = tax-exempt
  cost_cents INTEGER, internal_notes TEXT,
  public_visible INTEGER NOT NULL DEFAULT 1, show_price INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  effective_date TEXT, version INTEGER NOT NULL DEFAULT 1,
  -- package fields
  pkg_price_mode TEXT CHECK (pkg_price_mode IN ('fixed','itemized')), pkg_display TEXT DEFAULT 'combined' CHECK (pkg_display IN ('combined','itemized')),
  pkg_valid_days INTEGER, pkg_billing_frequency TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_rc_items_biz ON rc_items(business_id, status);
CREATE UNIQUE INDEX ux_rc_items_sku ON rc_items(business_id, sku) WHERE sku IS NOT NULL AND sku <> '';
CREATE TABLE rc_item_addons (
  item_id INTEGER NOT NULL REFERENCES rc_items(id) ON DELETE CASCADE,
  addon_id INTEGER NOT NULL REFERENCES rc_items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, addon_id)
);
CREATE TABLE rc_package_components (
  id INTEGER PRIMARY KEY, package_id INTEGER NOT NULL REFERENCES rc_items(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES rc_items(id), qty_milli INTEGER NOT NULL DEFAULT 1000,
  description TEXT, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE rc_item_history (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES rc_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, changed_at TEXT NOT NULL DEFAULT (datetime('now')), user_id INTEGER,
  name TEXT, unit TEXT, pricing_type TEXT, rate_cents INTEGER, currency TEXT, effective_date TEXT, status TEXT, change_note TEXT
);
CREATE TABLE rc_versions (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  snapshot TEXT NOT NULL
);
CREATE TABLE client_prices (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES rc_items(id),
  rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0), note TEXT,
  valid_from TEXT, valid_to TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_client_prices ON client_prices(client_id, item_id);

-- Projects / time / expenses -------------------------------------------------
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('lead','active','on_hold','completed','cancelled')),
  start_date TEXT, end_date TEXT, budget_cents INTEGER, currency TEXT NOT NULL DEFAULT 'CAD',
  scope TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE time_entries (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id), project_id INTEGER REFERENCES projects(id),
  rc_item_id INTEGER REFERENCES rc_items(id),
  entry_date TEXT NOT NULL, minutes INTEGER NOT NULL CHECK (minutes > 0), rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
  notes TEXT, billable INTEGER NOT NULL DEFAULT 1, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, UNIQUE (business_id, name)
);
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expense_date TEXT NOT NULL, merchant TEXT, description TEXT,
  category_id INTEGER REFERENCES expense_categories(id), amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0), currency TEXT NOT NULL DEFAULT 'CAD',
  payment_method TEXT, client_id INTEGER REFERENCES clients(id), project_id INTEGER REFERENCES projects(id),
  billable INTEGER NOT NULL DEFAULT 0, billable_markup_milli INTEGER NOT NULL DEFAULT 0,
  reimbursement_status TEXT NOT NULL DEFAULT 'none' CHECK (reimbursement_status IN ('none','pending','reimbursed')),
  notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tax_cents <= amount_cents)
);
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('expense','invoice','estimate','import','project')),
  owner_id INTEGER, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  data BLOB NOT NULL, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_attach_owner ON attachments(owner_type, owner_id);

-- Documents ------------------------------------------------------------------
CREATE TABLE documents (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('estimate','invoice','credit_note')),
  number TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','accepted','rejected','superseded','void')),
  client_id INTEGER NOT NULL REFERENCES clients(id), project_id INTEGER REFERENCES projects(id),
  currency TEXT NOT NULL, issue_date TEXT, due_date TEXT, valid_until TEXT, po_ref TEXT, title TEXT,
  prices_include_tax INTEGER NOT NULL DEFAULT 0, tax_exempt INTEGER NOT NULL DEFAULT 0, tax_exempt_note TEXT,
  discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','fixed')), discount_value INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_total_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0, credited_cents INTEGER NOT NULL DEFAULT 0,
  tax_summary TEXT NOT NULL DEFAULT '[]',
  notes TEXT, terms TEXT, payment_instructions TEXT,
  scope TEXT, deliverables TEXT, assumptions TEXT, exclusions TEXT, revision_terms TEXT,
  deposit_note TEXT,
  business_snapshot TEXT, client_snapshot TEXT,
  source_estimate_id INTEGER REFERENCES documents(id), conversion_kind TEXT CHECK (conversion_kind IN ('full','stage')), credit_for_invoice_id INTEGER REFERENCES documents(id),
  revision_of_id INTEGER REFERENCES documents(id), revision_no INTEGER NOT NULL DEFAULT 1,
  recurring_schedule_id INTEGER,
  template TEXT,
  disputed INTEGER NOT NULL DEFAULT 0, dispute_note TEXT,
  public_token_hash TEXT, public_expires_at TEXT, public_revoked INTEGER NOT NULL DEFAULT 0, public_viewed_at TEXT,
  accepted_at TEXT, accepted_by TEXT, acceptance_method TEXT CHECK (acceptance_method IN ('manual','public_link')), acceptance_note TEXT,
  rejected_at TEXT, rejection_note TEXT,
  void_reason TEXT, voided_at TEXT, issued_at TEXT,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_doc_number ON documents(business_id, type, number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX ux_full_conv ON documents(source_estimate_id) WHERE conversion_kind = 'full' AND status <> 'void';
CREATE UNIQUE INDEX ux_doc_public ON documents(public_token_hash) WHERE public_token_hash IS NOT NULL;
CREATE INDEX ix_doc_biz ON documents(business_id, type, status);
CREATE INDEX ix_doc_client ON documents(client_id);
CREATE TABLE document_lines (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  rc_item_id INTEGER REFERENCES rc_items(id), rc_item_version INTEGER, category_name TEXT,
  parent_line_id INTEGER REFERENCES document_lines(id) ON DELETE CASCADE, is_component INTEGER NOT NULL DEFAULT 0,
  package_id INTEGER REFERENCES rc_items(id), package_display TEXT,
  description TEXT NOT NULL, detail TEXT, unit TEXT,
  qty_milli INTEGER NOT NULL DEFAULT 1000, unit_price_cents INTEGER NOT NULL DEFAULT 0,
  standard_price_cents INTEGER, price_source TEXT NOT NULL DEFAULT 'custom' CHECK (price_source IN ('rate_card','client_agreement','custom','time','expense','package','stage')),
  client_price_id INTEGER,
  needs_confirmation INTEGER NOT NULL DEFAULT 0, price_confirmed INTEGER NOT NULL DEFAULT 1,
  discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','fixed')), discount_value INTEGER NOT NULL DEFAULT 0,
  tax_exempt INTEGER NOT NULL DEFAULT 0, taxes TEXT NOT NULL DEFAULT '[]',
  amount_cents INTEGER NOT NULL DEFAULT 0, line_discount_cents INTEGER NOT NULL DEFAULT 0, net_cents INTEGER NOT NULL DEFAULT 0,
  doc_discount_cents INTEGER NOT NULL DEFAULT 0, taxable_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
  recurring INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_lines_doc ON document_lines(document_id, position);
CREATE TABLE billing_stages (
  id INTEGER PRIMARY KEY, estimate_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('percent','fixed','balance')), value INTEGER NOT NULL DEFAULT 0,
  due_days INTEGER, invoice_id INTEGER REFERENCES documents(id), billed_base_cents INTEGER
);
CREATE UNIQUE INDEX ux_stage_invoice ON billing_stages(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE TABLE billing_links (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL, source_type TEXT NOT NULL CHECK (source_type IN ('expense','time')),
  source_id INTEGER NOT NULL, document_id INTEGER NOT NULL REFERENCES documents(id), line_id INTEGER,
  released_at TEXT, release_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_billing_link_active ON billing_links(source_type, source_id) WHERE released_at IS NULL;

-- Payments -------------------------------------------------------------------
CREATE TABLE payments (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id), kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0), currency TEXT NOT NULL,
  paid_date TEXT NOT NULL, method TEXT NOT NULL, reference TEXT, notes TEXT,
  verification TEXT NOT NULL DEFAULT 'manual' CHECK (verification IN ('manual','provider_verified')), provider TEXT, provider_ref TEXT,
  receipt_number TEXT, idempotency_key TEXT, created_by INTEGER,
  voided_at TEXT, void_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_pay_idem ON payments(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX ux_pay_receipt ON payments(business_id, receipt_number) WHERE receipt_number IS NOT NULL;
CREATE UNIQUE INDEX ux_pay_provider ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE TABLE payment_allocations (
  id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id), invoice_id INTEGER NOT NULL REFERENCES documents(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0), voided_at TEXT
);
CREATE INDEX ix_alloc_inv ON payment_allocations(invoice_id);
CREATE INDEX ix_alloc_pay ON payment_allocations(payment_id);

-- Recurring / comms / audit ---------------------------------------------------
CREATE TABLE recurring_schedules (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id), project_id INTEGER REFERENCES projects(id),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')), interval_n INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL, end_date TEXT, next_run_date TEXT NOT NULL,
  auto_issue INTEGER NOT NULL DEFAULT 0, payment_terms_days INTEGER NOT NULL DEFAULT 14, currency TEXT NOT NULL,
  prices_include_tax INTEGER NOT NULL DEFAULT 0, lines TEXT NOT NULL DEFAULT '[]', notes TEXT, terms TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE recurring_runs (
  id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL REFERENCES recurring_schedules(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL, invoice_id INTEGER REFERENCES documents(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (schedule_id, run_date)
);
CREATE TABLE communications (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id), client_id INTEGER, payment_id INTEGER,
  kind TEXT NOT NULL, to_addr TEXT, subject TEXT, body TEXT,
  status TEXT NOT NULL CHECK (status IN ('drafted','sent','failed')), error TEXT,
  dedupe_key TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
);
CREATE UNIQUE INDEX ux_comm_dedupe ON communications(business_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY, business_id INTEGER, user_id INTEGER, entity TEXT NOT NULL, entity_id INTEGER,
  action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_audit_entity ON audit_events(business_id, entity, entity_id);
CREATE TABLE idempotency_keys (
  business_id INTEGER NOT NULL, key TEXT NOT NULL, route TEXT NOT NULL, response TEXT NOT NULL, status INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (business_id, key, route)
);

-- Integrity triggers -------------------------------------------------------------
CREATE TRIGGER doc_lines_lock_ins BEFORE INSERT ON document_lines
WHEN (SELECT status FROM documents WHERE id = NEW.document_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Issued documents are immutable: cannot add lines'); END;
CREATE TRIGGER doc_lines_lock_upd BEFORE UPDATE ON document_lines
WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Issued documents are immutable: cannot edit lines'); END;
CREATE TRIGGER doc_lines_lock_del BEFORE DELETE ON document_lines
WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft' AND EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id)
BEGIN SELECT RAISE(ABORT, 'Issued documents are immutable: cannot delete lines'); END;
CREATE TRIGGER doc_delete_guard BEFORE DELETE ON documents WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Only draft documents can be deleted; void instead'); END;
CREATE TRIGGER doc_financial_lock BEFORE UPDATE ON documents
WHEN OLD.status <> 'draft' AND (
  NEW.total_cents <> OLD.total_cents OR NEW.subtotal_cents <> OLD.subtotal_cents OR NEW.tax_total_cents <> OLD.tax_total_cents
  OR NEW.discount_cents <> OLD.discount_cents OR NEW.currency <> OLD.currency OR NEW.client_id <> OLD.client_id
  OR NEW.number IS NOT OLD.number OR NEW.issue_date IS NOT OLD.issue_date OR NEW.prices_include_tax <> OLD.prices_include_tax
  OR NEW.tax_summary <> OLD.tax_summary OR NEW.type <> OLD.type)
BEGIN SELECT RAISE(ABORT, 'Issued documents are immutable: financial fields are locked'); END;
CREATE TRIGGER doc_void_final BEFORE UPDATE ON documents WHEN OLD.status = 'void' AND NEW.status <> 'void'
BEGIN SELECT RAISE(ABORT, 'Void documents cannot be reopened'); END;
CREATE TRIGGER doc_no_issue_no_number BEFORE UPDATE ON documents
WHEN OLD.status = 'draft' AND NEW.status IN ('issued') AND NEW.number IS NULL
BEGIN SELECT RAISE(ABORT, 'Issued documents require a number'); END;

CREATE TRIGGER alloc_validate BEFORE INSERT ON payment_allocations
BEGIN
  SELECT RAISE(ABORT, 'Payment is void') WHERE (SELECT voided_at FROM payments WHERE id = NEW.payment_id) IS NOT NULL;
  SELECT RAISE(ABORT, 'Allocation sign must match payment') WHERE (SELECT amount_cents FROM payments WHERE id = NEW.payment_id) * NEW.amount_cents < 0;
  SELECT RAISE(ABORT, 'Allocation exceeds payment amount') WHERE
    ABS(COALESCE((SELECT SUM(amount_cents) FROM payment_allocations WHERE payment_id = NEW.payment_id AND voided_at IS NULL), 0) + NEW.amount_cents)
    > ABS((SELECT amount_cents FROM payments WHERE id = NEW.payment_id));
  SELECT RAISE(ABORT, 'Invoice must be issued, not draft or void') WHERE (SELECT status FROM documents WHERE id = NEW.invoice_id) IN ('draft','void');
  SELECT RAISE(ABORT, 'Allocation target must be an invoice') WHERE (SELECT type FROM documents WHERE id = NEW.invoice_id) <> 'invoice';
  SELECT RAISE(ABORT, 'Payment and invoice belong to different businesses') WHERE
    (SELECT business_id FROM payments WHERE id = NEW.payment_id) <> (SELECT business_id FROM documents WHERE id = NEW.invoice_id);
  SELECT RAISE(ABORT, 'Payment and invoice currencies differ') WHERE
    (SELECT currency FROM payments WHERE id = NEW.payment_id) <> (SELECT currency FROM documents WHERE id = NEW.invoice_id);
  SELECT RAISE(ABORT, 'Allocation would exceed invoice total') WHERE
    COALESCE((SELECT SUM(amount_cents) FROM payment_allocations WHERE invoice_id = NEW.invoice_id AND voided_at IS NULL), 0) + NEW.amount_cents
    > (SELECT total_cents - credited_cents FROM documents WHERE id = NEW.invoice_id);
  SELECT RAISE(ABORT, 'Refund would exceed amount paid') WHERE
    COALESCE((SELECT SUM(amount_cents) FROM payment_allocations WHERE invoice_id = NEW.invoice_id AND voided_at IS NULL), 0) + NEW.amount_cents < 0;
END;
CREATE TRIGGER alloc_immutable BEFORE UPDATE ON payment_allocations
WHEN NEW.amount_cents <> OLD.amount_cents OR NEW.invoice_id <> OLD.invoice_id OR NEW.payment_id <> OLD.payment_id OR (OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'Allocations are immutable (void instead)'); END;
CREATE TRIGGER alloc_nodelete BEFORE DELETE ON payment_allocations
BEGIN SELECT RAISE(ABORT, 'Allocations cannot be deleted (void the payment)'); END;
CREATE TRIGGER pay_nodelete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'Payments cannot be deleted (void instead)'); END;
CREATE TRIGGER pay_amount_lock BEFORE UPDATE ON payments
WHEN NEW.amount_cents <> OLD.amount_cents OR NEW.currency <> OLD.currency OR NEW.client_id <> OLD.client_id OR NEW.kind <> OLD.kind
BEGIN SELECT RAISE(ABORT, 'Payment amount is immutable (void and re-record)'); END;
CREATE TRIGGER alloc_paid_ins AFTER INSERT ON payment_allocations
BEGIN
  UPDATE documents SET amount_paid_cents = COALESCE((SELECT SUM(amount_cents) FROM payment_allocations WHERE invoice_id = NEW.invoice_id AND voided_at IS NULL), 0) WHERE id = NEW.invoice_id;
END;
CREATE TRIGGER alloc_paid_upd AFTER UPDATE OF voided_at ON payment_allocations
BEGIN
  UPDATE documents SET amount_paid_cents = COALESCE((SELECT SUM(amount_cents) FROM payment_allocations WHERE invoice_id = NEW.invoice_id AND voided_at IS NULL), 0) WHERE id = NEW.invoice_id;
END;
CREATE TRIGGER doc_credit_guard BEFORE UPDATE OF credited_cents ON documents
WHEN NEW.credited_cents < 0 OR NEW.credited_cents + NEW.amount_paid_cents > NEW.total_cents
BEGIN SELECT RAISE(ABORT, 'Credits plus payments cannot exceed invoice total'); END;
CREATE TRIGGER doc_void_with_payments BEFORE UPDATE ON documents
WHEN NEW.status = 'void' AND OLD.status <> 'void' AND OLD.type = 'invoice' AND OLD.amount_paid_cents <> 0
BEGIN SELECT RAISE(ABORT, 'Invoice has recorded payments; void or refund them first'); END;
`}
];
