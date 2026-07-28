const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
if (!anthropic) {
  console.warn('ANTHROPIC_API_KEY is not set — screenshot import is disabled.');
}

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
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS avg_hr INTEGER;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS max_hr INTEGER;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS mood SMALLINT;
      CREATE TABLE IF NOT EXISTS run_photos (
        id SERIAL PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        content_type TEXT NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS activity_type TEXT NOT NULL DEFAULT 'run';
      ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_distance_miles_check;
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
// generous limit: /api/import carries base64 screenshots in its JSON body
app.use(express.json({ limit: '60mb' }));
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

function optInt(v, min, max) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

const ACTIVITY_TYPES = new Set(['run', 'walk', 'hike', 'ride', 'workout', 'other']);
const DISTANCE_TYPES = new Set(['run', 'walk', 'hike', 'ride']);

function parseRun(body) {
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'date must be YYYY-MM-DD' };
  const type = ACTIVITY_TYPES.has(body.type) ? body.type : 'run';
  const miles = Number(body.miles || 0);
  if (!Number.isFinite(miles) || miles < 0 || miles > 300) return { error: 'miles must be a non-negative number' };
  if (DISTANCE_TYPES.has(type) && miles <= 0) return { error: `miles is required for a ${type}` };
  const seconds = Math.round(Number(body.seconds));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 48 * 3600) return { error: 'duration must be positive' };
  const notes = String(body.notes || '').slice(0, 2000);
  const avgHr = optInt(body.avgHr, 30, 250);
  const maxHr = optInt(body.maxHr, 30, 250);
  const mood = optInt(body.mood, 1, 5);
  return { date, type, miles, seconds, notes, avgHr, maxHr, mood };
}

const RUN_COLUMNS = `id, to_char(run_date, 'YYYY-MM-DD') AS date, activity_type AS type,
  distance_miles::float AS miles, duration_seconds AS seconds, notes,
  avg_hr AS "avgHr", max_hr AS "maxHr", mood`;

app.get('/api/runs', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY run_date DESC, id DESC`);
    const { rows: photos } = await pool.query('SELECT id, run_id FROM run_photos ORDER BY id');
    const byRun = new Map();
    for (const p of photos) {
      if (!byRun.has(p.run_id)) byRun.set(p.run_id, []);
      byRun.get(p.run_id).push(p.id);
    }
    res.json({ runs: rows.map((r) => ({ ...r, photoIds: byRun.get(r.id) || [] })) });
  } catch (err) {
    console.error('GET /api/runs failed:', err.message);
    res.status(500).json({ error: 'Failed to load runs' });
  }
});

// --- photos (screenshots attached to a run) ----------------------------

const PHOTO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic']);

app.post('/api/runs/:id/photos', express.raw({ type: 'image/*', limit: '15mb' }), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!PHOTO_TYPES.has(type)) return res.status(400).json({ error: 'Unsupported image type' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty upload' });
  try {
    const { rows: exists } = await pool.query('SELECT 1 FROM runs WHERE id = $1', [id]);
    if (!exists.length) return res.status(404).json({ error: 'Run not found' });
    const { rows } = await pool.query(
      'INSERT INTO run_photos (run_id, content_type, data) VALUES ($1, $2, $3) RETURNING id',
      [id, type, req.body]
    );
    res.status(201).json({ photoId: rows[0].id });
  } catch (err) {
    console.error('POST photo failed:', err.message);
    res.status(500).json({ error: 'Failed to save photo' });
  }
});

app.get('/api/photos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const { rows } = await pool.query('SELECT content_type, data FROM run_photos WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    res.set('Content-Type', rows[0].content_type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(rows[0].data);
  } catch (err) {
    console.error('GET photo failed:', err.message);
    res.status(500).json({ error: 'Failed to load photo' });
  }
});

app.delete('/api/photos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM run_photos WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Photo not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE photo failed:', err.message);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

app.post('/api/runs', async (req, res) => {
  const run = parseRun(req.body || {});
  if (run.error) return res.status(400).json({ error: run.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO runs (run_date, activity_type, distance_miles, duration_seconds, notes, avg_hr, max_hr, mood)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${RUN_COLUMNS}`,
      [run.date, run.type, run.miles, run.seconds, run.notes, run.avgHr, run.maxHr, run.mood]
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
      `UPDATE runs SET run_date = $1, activity_type = $2, distance_miles = $3, duration_seconds = $4,
         notes = $5, avg_hr = $6, max_hr = $7, mood = $8
       WHERE id = $9 RETURNING ${RUN_COLUMNS}`,
      [run.date, run.type, run.miles, run.seconds, run.notes, run.avgHr, run.maxHr, run.mood, id]
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

// --- screenshot import -------------------------------------------------
// The client sends 1-6 screenshots of ONE workout; Claude extracts the
// numbers, we create the activity and attach the screenshots to it.

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['activityType', 'date', 'miles', 'seconds', 'avgHr', 'maxHr', 'notes'],
  properties: {
    activityType: { type: 'string', enum: ['run', 'walk', 'hike', 'ride', 'workout', 'other'] },
    date: { type: ['string', 'null'], description: 'Workout date as YYYY-MM-DD if visible, else null' },
    miles: { type: ['number', 'null'], description: 'Total distance in miles (convert from km if needed); null if not a distance activity' },
    seconds: { type: ['integer', 'null'], description: 'Total workout duration in seconds' },
    avgHr: { type: ['integer', 'null'] },
    maxHr: { type: ['integer', 'null'] },
    notes: { type: 'string', description: 'One or two sentences: interval structure, cadence, elevation gain, calories, HR zone split — whatever is visible' },
  },
};

app.post('/api/import', async (req, res) => {
  if (!anthropic) {
    return res.status(501).json({ error: 'Screenshot import is not configured — set ANTHROPIC_API_KEY on the server.' });
  }
  const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 6) : [];
  if (!images.length) return res.status(400).json({ error: 'No images provided' });
  for (const img of images) {
    if (!IMAGE_TYPES.has(img.mediaType) || typeof img.data !== 'string' || !img.data) {
      return res.status(400).json({ error: 'Unsupported or empty image' });
    }
  }
  const defaultDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.defaultDate || '')) ? req.body.defaultDate : null;

  try {
    const response = await anthropic.beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2048,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: IMPORT_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            ...images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.data },
            })),
            {
              type: 'text',
              text: `These fitness-app screenshots (Samsung Health, Strava, or similar) all describe ONE workout. Extract its data.
- miles: total distance in miles (convert km to miles if the app shows km); null for non-distance activities like strength workouts.
- seconds: total workout duration in seconds.
- date: the workout date as YYYY-MM-DD only if a date is visible in the screenshots, else null. Today is ${defaultDate || 'unknown'}.
- notes: a compact 1-2 sentence summary of what's visible: interval structure (e.g. "1:00/1:30 ×8"), cadence, elevation gain, calories, HR zone split, location.`,
            },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(502).json({ error: 'The model declined to read these images — try different screenshots.' });
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No data extracted from the screenshots' });
    const parsed = JSON.parse(textBlock.text);

    const run = parseRun({
      date: parsed.date || defaultDate,
      type: parsed.activityType,
      miles: parsed.miles ?? 0,
      seconds: parsed.seconds,
      notes: String(parsed.notes || '').trim(),
      avgHr: parsed.avgHr,
      maxHr: parsed.maxHr,
    });
    if (run.error) return res.status(422).json({ error: `Could not read a valid workout from the screenshots (${run.error})` });

    const { rows } = await pool.query(
      `INSERT INTO runs (run_date, activity_type, distance_miles, duration_seconds, notes, avg_hr, max_hr, mood)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${RUN_COLUMNS}`,
      [run.date, run.type, run.miles, run.seconds, run.notes, run.avgHr, run.maxHr, null]
    );
    const created = rows[0];
    const photoIds = [];
    for (const img of images) {
      const { rows: p } = await pool.query(
        'INSERT INTO run_photos (run_id, content_type, data) VALUES ($1, $2, $3) RETURNING id',
        [created.id, img.mediaType, Buffer.from(img.data, 'base64')]
      );
      photoIds.push(p[0].id);
    }
    res.status(201).json({ run: { ...created, photoIds } });
  } catch (err) {
    console.error('POST /api/import failed:', err.message);
    res.status(500).json({ error: 'Import failed — try again or add the workout manually.' });
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
