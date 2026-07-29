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
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS map_photo_id INTEGER REFERENCES run_photos(id) ON DELETE SET NULL;
      CREATE TABLE IF NOT EXISTS body_metrics (
        id SERIAL PRIMARY KEY,
        metric_date DATE NOT NULL UNIQUE,
        weight_lb NUMERIC(5,1),
        body_fat_pct NUMERIC(4,1),
        subcutaneous_fat_pct NUMERIC(4,1),
        visceral_fat NUMERIC(4,1),
        bmi NUMERIC(4,1),
        body_water_pct NUMERIC(4,1),
        skeletal_muscle_pct NUMERIC(4,1),
        bone_mass_lb NUMERIC(4,1),
        bmr_kcal INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
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
  avg_hr AS "avgHr", max_hr AS "maxHr", mood, map_photo_id AS "mapPhotoId"`;

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

// designate (or clear) one of a run's photos as its route map
app.post('/api/runs/:id/map', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const photoId = req.body && req.body.photoId != null ? Number(req.body.photoId) : null;
  try {
    if (photoId !== null) {
      const { rows } = await pool.query('SELECT 1 FROM run_photos WHERE id = $1 AND run_id = $2', [photoId, id]);
      if (!rows.length) return res.status(404).json({ error: 'Photo not found on this run' });
    }
    const { rowCount } = await pool.query('UPDATE runs SET map_photo_id = $1 WHERE id = $2', [photoId, id]);
    if (!rowCount) return res.status(404).json({ error: 'Run not found' });
    res.json({ ok: true, mapPhotoId: photoId });
  } catch (err) {
    console.error('POST /api/runs/:id/map failed:', err.message);
    res.status(500).json({ error: 'Failed to set route map' });
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
  required: ['activityType', 'date', 'miles', 'seconds', 'avgHr', 'maxHr', 'notes', 'mapImageIndex'],
  properties: {
    activityType: { type: 'string', enum: ['run', 'walk', 'hike', 'ride', 'workout', 'other'] },
    mapImageIndex: { type: ['integer', 'null'], description: '0-based index of the image that shows a route map (a GPS trace on a map), or null if none do' },
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
- notes: a compact 1-2 sentence summary of what's visible: interval structure (e.g. "1:00/1:30 ×8"), cadence, elevation gain, calories, HR zone split, location.
- mapImageIndex: the 0-based index of the image containing a route map (GPS trace drawn on a map), or null if no image shows one.`,
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
    let mapPhotoId = null;
    const mi = parsed.mapImageIndex;
    if (Number.isInteger(mi) && mi >= 0 && mi < photoIds.length) {
      mapPhotoId = photoIds[mi];
      await pool.query('UPDATE runs SET map_photo_id = $1 WHERE id = $2', [mapPhotoId, created.id]);
    }
    res.status(201).json({ run: { ...created, photoIds, mapPhotoId } });
  } catch (err) {
    console.error('POST /api/import failed:', err.message);
    res.status(500).json({ error: 'Import failed — try again or add the workout manually.' });
  }
});

// --- body metrics -------------------------------------------------------
// One row per day (smart-scale weigh-ins); same-date writes update the row.

function optNum(v, min, max) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 10) / 10;
}

function parseBody(body) {
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'date must be YYYY-MM-DD' };
  const m = {
    date,
    weightLb: optNum(body.weightLb, 50, 600),
    bodyFatPct: optNum(body.bodyFatPct, 1, 80),
    subcutaneousFatPct: optNum(body.subcutaneousFatPct, 1, 80),
    visceralFat: optNum(body.visceralFat, 1, 60),
    bmi: optNum(body.bmi, 8, 80),
    bodyWaterPct: optNum(body.bodyWaterPct, 10, 90),
    skeletalMusclePct: optNum(body.skeletalMusclePct, 10, 90),
    boneMassLb: optNum(body.boneMassLb, 1, 30),
    bmrKcal: optInt(body.bmrKcal, 500, 6000),
  };
  if (m.weightLb === null && m.bodyFatPct === null && m.bmi === null) {
    return { error: 'at least a weight, body fat %, or BMI is required' };
  }
  return m;
}

const BODY_COLUMNS = `id, to_char(metric_date, 'YYYY-MM-DD') AS date,
  weight_lb::float AS "weightLb", body_fat_pct::float AS "bodyFatPct",
  subcutaneous_fat_pct::float AS "subcutaneousFatPct", visceral_fat::float AS "visceralFat",
  bmi::float AS bmi, body_water_pct::float AS "bodyWaterPct",
  skeletal_muscle_pct::float AS "skeletalMusclePct", bone_mass_lb::float AS "boneMassLb",
  bmr_kcal AS "bmrKcal"`;

async function upsertBodyMetric(m) {
  const { rows } = await pool.query(
    `INSERT INTO body_metrics (metric_date, weight_lb, body_fat_pct, subcutaneous_fat_pct,
       visceral_fat, bmi, body_water_pct, skeletal_muscle_pct, bone_mass_lb, bmr_kcal)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (metric_date) DO UPDATE SET
       weight_lb = EXCLUDED.weight_lb, body_fat_pct = EXCLUDED.body_fat_pct,
       subcutaneous_fat_pct = EXCLUDED.subcutaneous_fat_pct, visceral_fat = EXCLUDED.visceral_fat,
       bmi = EXCLUDED.bmi, body_water_pct = EXCLUDED.body_water_pct,
       skeletal_muscle_pct = EXCLUDED.skeletal_muscle_pct, bone_mass_lb = EXCLUDED.bone_mass_lb,
       bmr_kcal = EXCLUDED.bmr_kcal
     RETURNING ${BODY_COLUMNS}`,
    [m.date, m.weightLb, m.bodyFatPct, m.subcutaneousFatPct, m.visceralFat, m.bmi,
     m.bodyWaterPct, m.skeletalMusclePct, m.boneMassLb, m.bmrKcal]
  );
  return rows[0];
}

app.get('/api/body', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${BODY_COLUMNS} FROM body_metrics ORDER BY metric_date DESC`);
    res.json({ metrics: rows });
  } catch (err) {
    console.error('GET /api/body failed:', err.message);
    res.status(500).json({ error: 'Failed to load body metrics' });
  }
});

app.post('/api/body', async (req, res) => {
  const m = parseBody(req.body || {});
  if (m.error) return res.status(400).json({ error: m.error });
  try {
    res.status(201).json({ metric: await upsertBodyMetric(m) });
  } catch (err) {
    console.error('POST /api/body failed:', err.message);
    res.status(500).json({ error: 'Failed to save weigh-in' });
  }
});

app.delete('/api/body/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM body_metrics WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Weigh-in not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/body failed:', err.message);
    res.status(500).json({ error: 'Failed to delete weigh-in' });
  }
});

const BODY_IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      description: 'One entry per distinct weigh-in shown (usually one per screenshot)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'weightLb', 'bodyFatPct', 'subcutaneousFatPct', 'visceralFat', 'bmi', 'bodyWaterPct', 'skeletalMusclePct', 'boneMassLb', 'bmrKcal'],
        properties: {
          date: { type: ['string', 'null'], description: 'Weigh-in date YYYY-MM-DD — use the SELECTED/highlighted date tab plus the year shown' },
          weightLb: { type: ['number', 'null'], description: 'Weight in pounds (convert from kg if needed)' },
          bodyFatPct: { type: ['number', 'null'] },
          subcutaneousFatPct: { type: ['number', 'null'] },
          visceralFat: { type: ['number', 'null'] },
          bmi: { type: ['number', 'null'] },
          bodyWaterPct: { type: ['number', 'null'] },
          skeletalMusclePct: { type: ['number', 'null'] },
          boneMassLb: { type: ['number', 'null'], description: 'Bone mass in pounds' },
          bmrKcal: { type: ['integer', 'null'] },
        },
      },
    },
  },
};

app.post('/api/body-import', async (req, res) => {
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
      output_config: { format: { type: 'json_schema', schema: BODY_IMPORT_SCHEMA } },
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
              text: `These are smart-scale / body-composition app screenshots (VeSync or similar). Each screenshot shows ONE weigh-in — return one entry per screenshot (deduplicate if two screenshots show the same date).
- date: the SELECTED (highlighted) date in the date tabs, combined with the year shown, as YYYY-MM-DD. Today is ${defaultDate || 'unknown'} — use it to resolve an ambiguous year, or as the date if none is visible.
- Convert kg to lb if the app shows kg.
- Use null for any value not visible.`,
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

    const saved = [];
    const errors = [];
    for (const entry of (parsed.entries || []).slice(0, 12)) {
      const m = parseBody({ ...entry, date: entry.date || defaultDate });
      if (m.error) { errors.push(m.error); continue; }
      saved.push(await upsertBodyMetric(m));
    }
    if (!saved.length) return res.status(422).json({ error: `Could not read a valid weigh-in (${errors[0] || 'nothing extracted'})` });
    res.status(201).json({ metrics: saved });
  } catch (err) {
    console.error('POST /api/body-import failed:', err.message);
    res.status(500).json({ error: 'Import failed — try again or add the weigh-in manually.' });
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
