'use strict';
/**
 * Database layer — encrypted-at-rest in production (SQLCipher build of better-sqlite3).
 * The schema is idempotent; applying it on boot doubles as migration v1.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function openDb(dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'techsol.db')) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try { db.pragma('journal_mode = WAL'); }
  catch { db.pragma('journal_mode = DELETE'); } // WAL unsupported on some mounts/network drives
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  const schema2 = fs.readFileSync(path.join(__dirname, 'schema2.sql'), 'utf8');
  db.exec(schema2);
  return db;
}

module.exports = { openDb };
