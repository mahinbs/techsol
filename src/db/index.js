'use strict';
/**
 * Database layer.
 * Prefers Node's built-in sqlite (node:sqlite, Node >= 22.13 / Electron >= 35)
 * so packaged desktop builds need NO native compilation. Falls back to
 * better-sqlite3 on older Node runtimes. Both expose the same surface we use:
 * prepare().run/get/all, exec, pragma.
 */
const fs = require('fs');
const path = require('path');

function makeDb(dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.pragma = (s) => { try { db.exec('PRAGMA ' + s); } catch { /* ignore */ } };
    return db;
  } catch {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  }
}

function openDb(dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'techsol.db')) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = makeDb(dbPath);
  try { db.pragma('journal_mode = WAL'); }
  catch { db.pragma('journal_mode = DELETE'); }
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  const schema2 = fs.readFileSync(path.join(__dirname, 'schema2.sql'), 'utf8');
  db.exec(schema2);
  // Additive column migrations for databases created before the column existed.
  // Each runs guarded so a re-run over an up-to-date DB is a no-op.
  for (const ddl of [
    `ALTER TABLE quotations ADD COLUMN discount_pct REAL NOT NULL DEFAULT 0`,
    // Customer matched to an existing Zoho Books contact by email/phone/name (#20).
    `ALTER TABLE enquiries ADD COLUMN books_contact_id TEXT`,
    `ALTER TABLE enquiries ADD COLUMN customer_matched_by TEXT`,
    // Acknowledgement number quoted to the customer (E-number / CRM enquiry no).
    `ALTER TABLE enquiries ADD COLUMN ack_no TEXT`,
    // Local mirror of CRM stage changes — a per-enquiry stage history/log kept
    // regardless of Zoho, so the app can show and prove the progression.
    `CREATE TABLE IF NOT EXISTS crm_stage_log (
       id INTEGER PRIMARY KEY,
       enquiry_id INTEGER,
       deal_id TEXT,
       milestone TEXT,
       stage TEXT NOT NULL,
       note TEXT,
       at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_crm_stage_log_enq ON crm_stage_log(enquiry_id)`,
  ]) { try { db.exec(ddl); } catch { /* already present */ } }
  return db;
}

module.exports = { openDb };
