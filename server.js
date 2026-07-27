const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_PASSWORD || '';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set — the app cannot store runs without it.');
}
if (!APP_PASSWORD) {
  console.warn('APP_PASSWORD is not set — the app is running without a login gate.');
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('railway.internal') || DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    })
  : null;

let dbReady = false;

async function initDb() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS runs (
        id SERIAL PRIMARY KEY,
        run_date DATE NOT NULL,
        distance_miles NUMERIC(6,2) NOT NULL CHECK (distance_miles > 0),
        duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        goals JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;
    `);
    dbReady = true;
    console.log('Database schema ready.');
  } catch (err) {
    console.error('Database init failed, retrying in 5s:', err.message);
    setTimeout(initDb, 5000);
  }
}
initDb();

// --- auth -------------------------------------------------------------
// Single-user password gate: the cookie holds an HMAC derived from the
// password, so rotating APP_PASSWORD invalidates existing sessions.

const AUTH_COOKIE = 'rt_auth';

function authToken() {
  return crypto.createHmac('sha256', APP_PASSWORD).update('running-tracker-auth').digest('hex');
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const cookie = getCookie(req, AUTH_COOKIE);
  if (!cookie) return false;
  const expected = authToken();
  const given = String(cookie);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true, dbReady }));

app.get('/api/session', (req, res) => {
  res.json({ authRequired: Boolean(APP_PASSWORD), authed: isAuthed(req), dbReady });
});

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const given = String((req.body && req.body.password) || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 500);
  }
  const secure = process.env.NODE_ENV !== 'development' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${authToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`
  );
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Not logged in' });
  if (!dbReady) return res.status(503).json({ error: 'Database not ready yet, try again shortly' });
  next();
});

// --- runs -------------------------------------------------------------

function parseRun(body) {
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'date must be YYYY-MM-DD' };
  const miles = Number(body.miles);
  if (!Number.isFinite(miles) || miles <= 0 || miles > 300) return { error: 'miles must be a positive number' };
  const seconds = Math.round(Number(body.seconds));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 48 * 3600) return { error: 'duration must be positive' };
  const notes = String(body.notes || '').slice(0, 2000);
  return { date, miles, seconds, notes };
}

const RUN_COLUMNS = `id, to_char(run_date, 'YYYY-MM-DD') AS date,
  distance_miles::float AS miles, duration_seconds AS seconds, notes`;

app.get('/api/runs', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY run_date DESC, id DESC`);
    res.json({ runs: rows });
  } catch (err) {
    console.error('GET /api/runs failed:', err.message);
    res.status(500).json({ error: 'Failed to load runs' });
  }
});

app.post('/api/runs', async (req, res) => {
  const run = parseRun(req.body || {});
  if (run.error) return res.status(400).json({ error: run.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO runs (run_date, distance_miles, duration_seconds, notes)
       VALUES ($1, $2, $3, $4) RETURNING ${RUN_COLUMNS}`,
      [run.date, run.miles, run.seconds, run.notes]
    );
    res.status(201).json({ run: rows[0] });
  } catch (err) {
    console.error('POST /api/runs failed:', err.message);
    res.status(500).json({ error: 'Failed to save run' });
  }
});

app.put('/api/runs/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const run = parseRun(req.body || {});
  if (run.error) return res.status(400).json({ error: run.error });
  try {
    const { rows } = await pool.query(
      `UPDATE runs SET run_date = $1, distance_miles = $2, duration_seconds = $3, notes = $4
       WHERE id = $5 RETURNING ${RUN_COLUMNS}`,
      [run.date, run.miles, run.seconds, run.notes, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Run not found' });
    res.json({ run: rows[0] });
  } catch (err) {
    console.error('PUT /api/runs failed:', err.message);
    res.status(500).json({ error: 'Failed to update run' });
  }
});

app.delete('/api/runs/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM runs WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Run not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/runs failed:', err.message);
    res.status(500).json({ error: 'Failed to delete run' });
  }
});

// --- goals ------------------------------------------------------------

app.get('/api/goals', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT goals FROM settings WHERE id = 1');
    res.json({ goals: rows.length ? rows[0].goals : {} });
  } catch (err) {
    console.error('GET /api/goals failed:', err.message);
    res.status(500).json({ error: 'Failed to load goals' });
  }
});

app.put('/api/goals', async (req, res) => {
  const body = req.body || {};
  const goals = {};
  const weeklyMiles = Number(body.weeklyMiles);
  if (Number.isFinite(weeklyMiles) && weeklyMiles > 0) goals.weeklyMiles = weeklyMiles;
  const raceName = String(body.raceName || '').slice(0, 200);
  const raceDate = String(body.raceDate || '');
  if (raceName && /^\d{4}-\d{2}-\d{2}$/.test(raceDate)) {
    goals.raceName = raceName;
    goals.raceDate = raceDate;
    const raceMiles = Number(body.raceMiles);
    if (Number.isFinite(raceMiles) && raceMiles > 0) goals.raceMiles = raceMiles;
  }
  try {
    await pool.query('UPDATE settings SET goals = $1 WHERE id = 1', [JSON.stringify(goals)]);
    res.json({ goals });
  } catch (err) {
    console.error('PUT /api/goals failed:', err.message);
    res.status(500).json({ error: 'Failed to save goals' });
  }
});

app.listen(PORT, () => console.log(`Running tracker listening on :${PORT}`));
