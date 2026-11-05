'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  template TEXT NOT NULL,
  role TEXT NOT NULL,
  industry TEXT NOT NULL,
  team_size INTEGER NOT NULL,
  company_desc TEXT NOT NULL,
  decision_text TEXT NOT NULL,
  extras TEXT NOT NULL DEFAULT '{}',
  utm_source TEXT,
  ip TEXT,
  email TEXT,
  released INTEGER NOT NULL DEFAULT 0,
  released_at TEXT,
  cost_inr REAL NOT NULL DEFAULT 0,
  error TEXT,
  graph TEXT,
  posts TEXT,
  report TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  type TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  inr REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_ip_created ON runs(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_email ON runs(email);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_spend_created ON spend(created_at);
`;

function open(dbPath) {
  if (db) db.close();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

function get() {
  if (!db) throw new Error('database not open');
  return db;
}

function close() {
  if (db) db.close();
  db = null;
}

function nowIso() {
  return new Date().toISOString();
}

function logEvent(runId, type, meta = {}) {
  get()
    .prepare('INSERT INTO events (run_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, type, JSON.stringify(meta), nowIso());
}

function addSpend(runId, inr) {
  get().prepare('INSERT INTO spend (run_id, inr, created_at) VALUES (?, ?, ?)').run(runId, inr, nowIso());
}

function startOfTodayUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}
function startOfMonthUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function spendSince(iso) {
  const row = get().prepare('SELECT COALESCE(SUM(inr), 0) AS total FROM spend WHERE created_at >= ?').get(iso);
  return Number(row.total) || 0;
}

const JSON_FIELDS = ['extras', 'graph', 'posts', 'report'];

function getRun(id) {
  const row = get().prepare('SELECT * FROM runs WHERE id = ?').get(id);
  if (!row) return null;
  const run = { ...row };
  for (const f of JSON_FIELDS) run[f] = run[f] ? JSON.parse(run[f]) : null;
  run.released = !!run.released;
  return run;
}

function updateRun(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => {
    const v = fields[k];
    if (JSON_FIELDS.includes(k) && v !== null && v !== undefined) return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v === undefined ? null : v;
  });
  get()
    .prepare(`UPDATE runs SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...vals, nowIso(), id);
}

module.exports = {
  open,
  get,
  close,
  nowIso,
  logEvent,
  addSpend,
  spendSince,
  startOfTodayUtc,
  startOfMonthUtc,
  getRun,
  updateRun,
};
