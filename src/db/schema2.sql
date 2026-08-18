-- Schema v2 — WF3..WF10 (idempotent)

-- ===== Customer invoices (WF3 trigger, WF9 ageing) =====
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  invoice_no TEXT NOT NULL UNIQUE,
  so_id INTEGER REFERENCES sales_orders(id),
  customer TEXT NOT NULL,
  amount REAL NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'   -- open | part_paid | paid
);

-- ===== WF3: Dispatches =====
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  vehicle TEXT, driver TEXT, contact TEXT,
  transporter TEXT, lr_no TEXT, dispatch_date TEXT, packages INTEGER,
  documents TEXT,                        -- JSON [{type,name}]
  status TEXT NOT NULL DEFAULT 'collecting'  -- collecting | ready | email_pending | notified
);

-- ===== WF4: GRN + BOE =====
CREATE TABLE IF NOT EXISTS grns (
  id INTEGER PRIMARY KEY,
  grn_no TEXT NOT NULL UNIQUE,
  vpo_id INTEGER NOT NULL REFERENCES vendor_pos(id),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  detail TEXT
);

CREATE TABLE IF NOT EXISTS boes (
  id INTEGER PRIMARY KEY,
  boe_no TEXT NOT NULL UNIQUE,
  shipment_ref TEXT,
  vpo_id INTEGER REFERENCES vendor_pos(id),
  bill_id INTEGER REFERENCES vendor_bills(id),
  sop_valid INTEGER NOT NULL DEFAULT 0,  -- 1 when SOP checks pass
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== WF5: GSTR-2B =====
CREATE TABLE IF NOT EXISTS gstr2b_rows (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,                  -- '2026-04'
  gstin TEXT NOT NULL,
  vendor TEXT,
  invoice_no TEXT NOT NULL,
  invoice_date TEXT,
  taxable_value REAL NOT NULL,
  tax REAL NOT NULL,
  UNIQUE(period, gstin, invoice_no)
);

CREATE TABLE IF NOT EXISTS gstr2b_recon (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  row_id INTEGER REFERENCES gstr2b_rows(id),
  bill_id INTEGER REFERENCES vendor_bills(id),
  classification TEXT NOT NULL,          -- matched | mismatch | missing_in_books | missing_in_2b
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== WF7: Bank =====
CREATE TABLE IF NOT EXISTS bank_txns (
  id INTEGER PRIMARY KEY,
  bank TEXT NOT NULL,
  txn_date TEXT NOT NULL,
  narration TEXT NOT NULL,
  amount REAL NOT NULL,                  -- +credit / -debit
  import_key TEXT NOT NULL UNIQUE,       -- idempotent import
  matched_type TEXT,                     -- invoice | vendor_bill
  matched_id INTEGER,
  match_method TEXT,                     -- reference | amount_date | manual
  status TEXT NOT NULL DEFAULT 'unmatched'  -- unmatched | suggested | matched
);

-- ===== WF8: Expenses =====
CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY,
  employee TEXT NOT NULL,
  amount REAL NOT NULL,
  source TEXT DEFAULT 'cash',            -- cash | omni_card
  balance REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  employee TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL,
  merchant TEXT,
  amount REAL NOT NULL,
  receipt_ref TEXT,
  advance_id INTEGER REFERENCES advances(id),
  policy_result TEXT,                    -- JSON {ok, violations[]}
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted | approval_pending | approved | posted | rejected
  zoho_expense_id TEXT
);

-- ===== WF9: Reminders =====
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  stage INTEGER NOT NULL,                -- 1..n per cadence
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | approval_pending | sent
  UNIQUE(invoice_id, stage)
);

-- ===== WF10: Registers & compliance =====
CREATE TABLE IF NOT EXISTS registers (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                    -- BG | FD | EMD
  ref_no TEXT NOT NULL,
  party TEXT, bank TEXT,
  amount REAL,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | expired | closed
  UNIQUE(kind, ref_no)
);

CREATE TABLE IF NOT EXISTS compliance_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL,               -- monthly | quarterly | annual
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' -- pending | filed
);
