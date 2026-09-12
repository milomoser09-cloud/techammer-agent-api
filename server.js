/**
 * Techammer Agent API
 *
 * Implements the three tools the Mike agent calls, plus the suppression
 * check you must run before any outbound SMS.
 *
 * Design principle: this service is the part you own. The voice platform
 * is rented plumbing. Business logic and call data live here, so migrating
 * off Retell (or anywhere else) is a config change, not a rebuild.
 */

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'agent.db');
const API_KEY = process.env.API_KEY;
const TRANSFER_NUMBER = process.env.TRANSFER_NUMBER;
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error('FATAL: API_KEY environment variable is required.');
  process.exit(1);
}

// ---------------------------------------------------------------- database

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS suppression (
    phone_e164     TEXT PRIMARY KEY,
    reason         TEXT NOT NULL DEFAULT 'consumer_request',
    verbatim       TEXT,
    source         TEXT NOT NULL DEFAULT 'voice',
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS qualifications (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id               TEXT,
    phone_e164            TEXT,
    first_name            TEXT,
    last_name             TEXT,
    email                 TEXT,
    vehicle_year          INTEGER,
    vehicle_make          TEXT,
    vehicle_model         TEXT,
    mileage               INTEGER,
    current_issue         INTEGER NOT NULL DEFAULT 0,
    current_issue_detail  TEXT,
    created_at            TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS call_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id      TEXT,
    phone_e164   TEXT,
    event_type   TEXT NOT NULL,
    reason       TEXT,
    summary      TEXT,
    payload      TEXT,
    prompt_ver   TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_call ON call_events(call_id);
  CREATE INDEX IF NOT EXISTS idx_quals_phone ON qualifications(phone_e164);
`);

const now = () => new Date().toISOString();

// ------------------------------------------------------------------ helpers

/**
 * Normalize a US phone number to E.164. Suppression matching is worthless
 * if "(305) 555-1234" and "+13055551234" are stored as different people.
 */
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(raw).trim().startsWith('+')) return `+${digits}`;
  return null;
}

function logEvent({ call_id, phone_e164, event_type, reason, summary, payload, prompt_ver }) {
  db.prepare(`
    INSERT INTO call_events
      (call_id, phone_e164, event_type, reason, summary, payload, prompt_ver, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    call_id || null,
    phone_e164 || null,
    event_type,
    reason || null,
    summary || null,
    payload ? JSON.stringify(payload) : null,
    prompt_ver || null,
    now()
  );
}

// Shared-secret auth. Voice platforms send custom headers on tool calls.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// -------------------------------------------------------------------- tools

/**
 * transfer_to_human
 * Returns the destination number for the platform to bridge to.
 * Always logs, even when no human is available, so you can measure how
 * often callers ask for a person and don't get one.
 */
app.post('/tools/transfer', (req, res) => {
  const { call_id, phone, reason, summary, prompt_version } = req.body || {};
  const phone_e164 = toE164(phone);

  if (!reason) return res.status(400).json({ error: 'reason is required' });

  logEvent({
    call_id,
    phone_e164,
    event_type: 'transfer_requested',
    reason,
    summary,
    prompt_ver: prompt_version
  });

  if (!TRANSFER_NUMBER) {
    // Honest fallback. The prompt instructs Mike to say so and book a
    // callback rather than pretend a transfer happened.
    return res.json({
      transfer_available: false,
      message: 'No transfer destination configured. Book a callback instead.'
    });
  }

  const withinHours = isWithinBusinessHours();
  if (!withinHours) {
    logEvent({ call_id, phone_e164, event_type: 'transfer_unavailable', reason: 'outside_hours' });
    return res.json({
      transfer_available: false,
      message: 'Outside business hours. Book a callback instead.'
    });
  }

  res.json({ transfer_available: true, transfer_to: TRANSFER_NUMBER });
});

/**
 * save_qualification
 * Stores what Mike collected. Nothing here is a decision — it's the file
 * the human specialist picks up.
 */
app.post('/tools/qualification', (req, res) => {
  const {
    call_id, phone, first_name, last_name, email,
    vehicle_year, vehicle_make, vehicle_model, mileage,
    current_issue, current_issue_detail, prompt_version
  } = req.body || {};

  const phone_e164 = toE164(phone);

  const info = db.prepare(`
    INSERT INTO qualifications
      (call_id, phone_e164, first_name, last_name, email,
       vehicle_year, vehicle_make, vehicle_model, mileage,
       current_issue, current_issue_detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    call_id || null,
    phone_e164,
    first_name || null,
    last_name || null,
    email || null,
    vehicle_year || null,
    vehicle_make || null,
    vehicle_model || null,
    mileage || null,
    current_issue ? 1 : 0,
    current_issue_detail || null,
    now()
  );

  logEvent({
    call_id,
    phone_e164,
    event_type: 'qualification_saved',
    summary: `${first_name || '?'} ${last_name || ''} — ${vehicle_year || '?'} ${vehicle_make || ''} ${vehicle_model || ''}`.trim(),
    prompt_ver: prompt_version
  });

  res.json({ saved: true, qualification_id: info.lastInsertRowid });
});

/**
 * log_opt_out
 * Writes synchronously before responding. An opt-out that sits in a queue
 * is an opt-out that didn't happen.
 */
app.post('/tools/opt-out', (req, res) => {
  const { call_id, phone, verbatim_request, source, prompt_version } = req.body || {};
  const phone_e164 = toE164(phone);

  if (!phone_e164) {
    return res.status(400).json({ error: 'a valid phone number is required' });
  }

  db.prepare(`
    INSERT INTO suppression (phone_e164, reason, verbatim, source, created_at)
    VALUES (?, 'consumer_request', ?, ?, ?)
    ON CONFLICT(phone_e164) DO UPDATE SET
      verbatim = excluded.verbatim,
      created_at = excluded.created_at
  `).run(phone_e164, verbatim_request || null, source || 'voice', now());

  logEvent({
    call_id,
    phone_e164,
    event_type: 'opt_out',
    summary: verbatim_request || null,
    prompt_ver: prompt_version
  });

  res.json({ suppressed: true, phone: phone_e164 });
});

// ------------------------------------------------------- suppression check

/**
 * Call this before EVERY outbound message. Not a suggestion.
 */
app.get('/suppression/:phone', (req, res) => {
  const phone_e164 = toE164(req.params.phone);
  if (!phone_e164) return res.status(400).json({ error: 'invalid phone number' });

  const row = db.prepare('SELECT * FROM suppression WHERE phone_e164 = ?').get(phone_e164);
  res.json({
    phone: phone_e164,
    suppressed: !!row,
    since: row ? row.created_at : null,
    source: row ? row.source : null
  });
});

/** Bulk check — scrub a whole send list in one call. */
app.post('/suppression/check', (req, res) => {
  const { phones } = req.body || {};
  if (!Array.isArray(phones)) return res.status(400).json({ error: 'phones array required' });

  const stmt = db.prepare('SELECT 1 FROM suppression WHERE phone_e164 = ?');
  const results = phones.map(p => {
    const e164 = toE164(p);
    return { input: p, phone: e164, suppressed: e164 ? !!stmt.get(e164) : false, valid: !!e164 };
  });

  res.json({
    checked: results.length,
    suppressed_count: results.filter(r => r.suppressed).length,
    results
  });
});

/** Manual opt-out entry — for STOP replies and anything logged by a human. */
app.post('/suppression', (req, res) => {
  const { phone, source, verbatim } = req.body || {};
  const phone_e164 = toE164(phone);
  if (!phone_e164) return res.status(400).json({ error: 'invalid phone number' });

  db.prepare(`
    INSERT INTO suppression (phone_e164, reason, verbatim, source, created_at)
    VALUES (?, 'consumer_request', ?, ?, ?)
    ON CONFLICT(phone_e164) DO NOTHING
  `).run(phone_e164, verbatim || null, source || 'manual', now());

  res.json({ suppressed: true, phone: phone_e164 });
});

// ------------------------------------------------------------------- audit

/** Full event history for one call — this is your discovery record. */
app.get('/calls/:call_id', (req, res) => {
  const events = db.prepare(
    'SELECT * FROM call_events WHERE call_id = ? ORDER BY id ASC'
  ).all(req.params.call_id);
  const qual = db.prepare(
    'SELECT * FROM qualifications WHERE call_id = ? ORDER BY id DESC LIMIT 1'
  ).get(req.params.call_id);
  res.json({ call_id: req.params.call_id, qualification: qual || null, events });
});

/** Transfer-reason breakdown. Containment rate lives here. */
app.get('/stats/transfers', (req, res) => {
  const rows = db.prepare(`
    SELECT reason, COUNT(*) AS count
    FROM call_events WHERE event_type = 'transfer_requested'
    GROUP BY reason ORDER BY count DESC
  `).all();
  const total = rows.reduce((s, r) => s + r.count, 0);
  res.json({ total_transfers: total, by_reason: rows });
});

app.get('/health', (_req, res) => res.json({ ok: true, time: now() }));

// --------------------------------------------------------------- utilities

function isWithinBusinessHours() {
  // Conservative default: 9am-6pm Eastern, Mon-Fri.
  // Replace with EazeDrive's actual staffed hours.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', hour12: false, weekday: 'short'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const hour = parseInt(parts.hour, 10);
  const day = parts.weekday;
  if (day === 'Sat' || day === 'Sun') return false;
  return hour >= 9 && hour < 18;
}

app.listen(PORT, () => {
  console.log(`Techammer agent API listening on ${PORT}`);
  console.log(`Transfer destination: ${TRANSFER_NUMBER || 'NOT SET — callbacks only'}`);
});
