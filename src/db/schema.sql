-- Techsol Automation Platform — core schema (v1)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Audit (append-only) =====
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,                -- 'system' | user id
  workflow TEXT NOT NULL,             -- WF1..WF10 | core
  action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT,
  outcome TEXT NOT NULL,              -- ok | error | rejected
  detail TEXT                         -- JSON
);

-- ===== Approvals (maker-checker) =====
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  workflow TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- ack_email | quotation | sales_order | vendor_po | vendor_bill | dispatch_email | reminder
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,              -- JSON draft prepared by agents
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  decided_by TEXT, decided_at TEXT,
  decision_note TEXT,
  edited_payload TEXT                 -- JSON if approver edited before approving
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, workflow);

-- ===== Exceptions =====
CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  workflow TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT,                        -- JSON
  status TEXT NOT NULL DEFAULT 'open' -- open | resolved | dismissed
);

-- ===== WF1: Enquiries =====
CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,               -- email | whatsapp
  source_message_id TEXT NOT NULL UNIQUE,  -- idempotency key
  sender TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  attachments TEXT,                   -- JSON [{name,path}]
  extracted TEXT,                     -- JSON {customer,{value,confidence},...}
  crm_account_id TEXT, crm_deal_id TEXT,
  status TEXT NOT NULL DEFAULT 'new'  -- new | extracted | deal_created | ack_pending | ack_sent | exception
);

CREATE TABLE IF NOT EXISTS enquiry_lines (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  qty REAL, uom TEXT, spec TEXT,
  confidence REAL
);

-- ===== Item master & quotes =====
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  spec TEXT, uom TEXT DEFAULT 'EA',
  list_price REAL
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  quote_no TEXT NOT NULL UNIQUE,
  enquiry_id INTEGER REFERENCES enquiries(id),
  customer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | approved | sent | accepted
  total REAL
);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id),
  line_no INTEGER NOT NULL,
  rfq_description TEXT NOT NULL,
  item_id INTEGER REFERENCES items(id),
  match_method TEXT,                  -- exact | fuzzy | manual | unmatched
  match_confidence REAL,
  qty REAL NOT NULL, uom TEXT,
  recommended_price REAL,
  final_price REAL,                   -- set by human, never auto
  price_finalised_by TEXT
);

-- ===== WF2: SO / Vendor PO (SO–PO Engine) =====
CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  so_no TEXT NOT NULL UNIQUE,
  quotation_id INTEGER REFERENCES quotations(id),
  customer TEXT NOT NULL,
  customer_po_no TEXT,
  zoho_so_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' -- draft | approved | invoiced | dispatched | closed
);

CREATE TABLE IF NOT EXISTS vendor_pos (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  vpo_no TEXT NOT NULL UNIQUE,
  vendor TEXT NOT NULL,
  zoho_po_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' -- draft | approved | ordered | supplied | received | billed
);

-- one SO -> many vendor POs; a VPO belongs to exactly one SO (per client model)
CREATE TABLE IF NOT EXISTS so_po_map (
  id INTEGER PRIMARY KEY,
  so_id INTEGER NOT NULL REFERENCES sales_orders(id),
  vpo_id INTEGER NOT NULL UNIQUE REFERENCES vendor_pos(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sopo_so ON so_po_map(so_id);

-- downstream references attach to the map so everything traces to the SO
CREATE TABLE IF NOT EXISTS so_po_refs (
  id INTEGER PRIMARY KEY,
  vpo_id INTEGER NOT NULL REFERENCES vendor_pos(id),
  ref_type TEXT NOT NULL,             -- grn | vendor_bill | boe | payment | bank_txn
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(vpo_id, ref_type, ref_id)
);

-- ===== Vendor bills (WF4 foundation) =====
CREATE TABLE IF NOT EXISTS vendor_bills (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  vendor TEXT NOT NULL,
  gstin TEXT,
  invoice_no TEXT NOT NULL,
  invoice_date TEXT,
  amount REAL NOT NULL,
  vpo_id INTEGER REFERENCES vendor_pos(id),
  zoho_bill_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  UNIQUE(vendor, invoice_no)          -- duplicate guard
);

-- ===== Outbox (idempotent sends) =====
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  idempotency_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,              -- email | whatsapp | zoho
  to_addr TEXT, subject TEXT, body TEXT,
  payload TEXT,
  sent_at TEXT, status TEXT NOT NULL DEFAULT 'queued'  -- queued | sent | failed
);
