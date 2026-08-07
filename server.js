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
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS detail JSONB;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS coaching JSONB;
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
  avg_hr AS "avgHr", max_hr AS "maxHr", mood, map_photo_id AS "mapPhotoId",
  detail, coaching`;

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

// ===== Coaching analysis =====================================================
// Reproduces the by-hand session-review pass. This is about EXECUTION DISCIPLINE,
// not fitness — see docs/COACHING_CONTEXT.md. A well-run easy session ends on its
// slowest, calmest rep; the recurring failure is the back-half surge.

const COACH = {
  // current base-building targets (directional — zone boundaries aren't gospel)
  paceBandSecPerMi: [810, 840], // 13:30–14:00/mi prescribed belt pace
  avgHrBand: [130, 140],
  peakBand: [145, 152],
  maxCeiling: 154, // "low 150s" graduation ceiling
  z4MaxFrac: 0.10, // Zone 4+ time target under 10%; flag over 15%
  z4FlagFrac: 0.15,
  cadenceTarget: 125,
  cadenceLow: 122,
};

function linregSlope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (ys[i] - ym); den += (i - xm) ** 2; }
  return den ? num / den : 0;
}
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const paceStr = (secPerMi) => {
  if (!Number.isFinite(secPerMi) || secPerMi <= 0) return '—';
  const s = Math.round(secPerMi);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Deterministic metrics + flags. Never rewards "faster".
function computeCoaching(run, detail) {
  const flags = [];
  const m = {};
  const treadmill = detail && detail.surface === 'treadmill';
  const jog = ((detail && detail.reps) || [])
    .map((r) => r && r.jogSecPerMi)
    .filter((v) => Number.isFinite(v) && v > 0);
  m.repCount = jog.length;

  // pace-based checks only make sense with real GPS (outdoor)
  if (!treadmill && jog.length >= 3) {
    const slope = linregSlope(jog); // sec/mi per rep; negative = speeding up
    const first = jog[0], last = jog[jog.length - 1], med = median(jog);
    m.paceSlopeSecPerRep = Math.round(slope * 10) / 10;
    m.lastVsFirstSec = Math.round(first - last); // + = last rep faster
    m.lastVsMedianSec = Math.round(med - last);
    m.lastRepSlowest = last >= Math.max(...jog) - 3;
    const surging = slope < -5 || (first - last) > 45;
    if (surging) {
      flags.push({ level: 'flag', text: `Back-half surge: jog reps ramped from ${paceStr(first)} to ${paceStr(last)}/mi (${Math.round(first - last)}s/mi faster). A clean easy session ends on its slowest rep.` });
    } else if (m.lastRepSlowest) {
      flags.push({ level: 'good', text: `Even pacing — last rep was the slowest/calmest. This is exactly the target shape.` });
    }
    // vs prescription band
    const [lo, hi] = COACH.paceBandSecPerMi;
    const inBand = jog.filter((v) => v >= lo - 15 && v <= hi + 15).length;
    m.repsInBand = inBand;
    m.meanPaceSecPerMi = Math.round(jog.reduce((a, b) => a + b, 0) / jog.length);
    if (m.meanPaceSecPerMi < lo - 30) {
      flags.push({ level: 'flag', text: `Ran hot vs the ${paceStr(lo)}–${paceStr(hi)}/mi prescription — mean jog ${paceStr(m.meanPaceSecPerMi)}/mi, ${inBand}/${jog.length} reps in band.` });
    }
  } else if (treadmill) {
    flags.push({ level: 'info', text: 'Treadmill session — GPS pace is fictional, so this read leans on HR zones and cadence.' });
  }

  // HR zone distribution
  const z = detail && detail.zones;
  if (z) {
    const tot = ['z1Sec', 'z2Sec', 'z3Sec', 'z4Sec', 'z5Sec'].reduce((a, k) => a + (z[k] || 0), 0);
    if (tot > 0) {
      m.pctAboveZ4 = Math.round(((z.z4Sec || 0) + (z.z5Sec || 0)) / tot * 100);
      m.pctZ5 = Math.round((z.z5Sec || 0) / tot * 100);
      if (m.pctAboveZ4 > COACH.z4FlagFrac * 100) {
        flags.push({ level: 'flag', text: `${m.pctAboveZ4}% of the session above Zone 3 (target under 10%). Too much time anaerobic for an easy day.` });
      } else if (m.pctAboveZ4 <= COACH.z4MaxFrac * 100) {
        flags.push({ level: 'good', text: `Only ${m.pctAboveZ4}% above Zone 3 — zone discipline held.` });
      }
    }
  }

  // avg / peak HR
  if (run.avgHr) {
    m.avgHr = run.avgHr;
    if (run.avgHr >= COACH.avgHrBand[0] && run.avgHr <= COACH.avgHrBand[1]) {
      flags.push({ level: 'good', text: `Session avg HR ${run.avgHr} — right in the 130–140 easy band.` });
    } else if (run.avgHr > COACH.avgHrBand[1]) {
      flags.push({ level: 'flag', text: `Session avg HR ${run.avgHr}, above the 130–140 easy band.` });
    }
  }
  if (run.maxHr) m.maxHr = run.maxHr;

  // cadence vs pace — overstriding is the hip-flexor mechanism
  const cad = detail && detail.cadenceSpm;
  if (cad) {
    m.cadenceSpm = cad;
    const sped = m.lastVsFirstSec > 30 || (m.paceSlopeSecPerRep != null && m.paceSlopeSecPerRep < -5);
    if (cad < COACH.cadenceLow && sped) {
      flags.push({ level: 'flag', text: `Cadence ${cad} spm while pace rose = overstriding (reaching, not turning over). This is the hip-flexor mechanism — pick the feet up quicker, don't lengthen the stride.` });
    } else if (cad < COACH.cadenceLow) {
      flags.push({ level: 'info', text: `Cadence ${cad} spm — still under the 125 target. A live lever for next time.` });
    }
  }

  // perceived-vs-measured: subjective "easy" against the flag count
  const subjective = String(run.notes || '').toLowerCase();
  const saysEasy = /\beasy|felt (good|great|fine)|comfortable|no problem/.test(subjective);
  const hardFlags = flags.filter((f) => f.level === 'flag').length;
  if (saysEasy && hardFlags > 0) {
    flags.push({ level: 'flag', text: `You logged it as feeling easy, but the trace shows ${hardFlags} execution issue${hardFlags === 1 ? '' : 's'}. Perceived effort runs ~15 bpm hot for you — the data is the governor, not the feel.` });
    m.perceivedGap = true;
  }

  // advancement gate — data, not feeling
  const gate = {};
  gate.peaksOk = run.maxHr != null ? run.maxHr <= COACH.maxCeiling : null;
  gate.noSurge = (!treadmill && jog.length >= 3) ? !(m.paceSlopeSecPerRep < -5 || m.lastVsFirstSec > 45) : null;
  gate.zonesOk = m.pctAboveZ4 != null ? m.pctAboveZ4 <= COACH.z4MaxFrac * 100 : null;
  const known = [gate.peaksOk, gate.noSurge, gate.zonesOk].filter((v) => v !== null);
  gate.pass = known.length > 0 && known.every((v) => v === true);
  m.gate = gate;

  return { metrics: m, flags, treadmill };
}

const NARRATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'observations', 'advancement'],
  properties: {
    verdict: { type: 'string', description: 'One blunt sentence: was this session executed correctly? Never praise "faster".' },
    observations: { type: 'array', items: { type: 'string' }, description: '2-4 short execution-focused observations, most important first' },
    advancement: { type: 'string', description: 'The advancement call, stating the criterion explicitly (talk test held + peaks low 150s + no negative pace slope + Z4 under 10%).' },
  },
};

const COACH_SYSTEM = `You are Dan's running coach reviewing one session. Dan is 52, a returning runner in walk-to-run base building for a 5K (Oct 17) then a 15K (Jan 31, 2027).

THIS IS ABOUT EXECUTION DISCIPLINE, NOT FITNESS. His aerobic fitness is fine; every meaningful failure has been a pacing-control failure. NEVER congratulate him for running faster or "finishing strong" — a strong finish on an easy day is the exact failure being trained out.

Rules, most important first:
1. Perceived effort runs ~15 bpm hot. "It felt easy" is a prompt to check the trace, never corroboration.
2. The back-half surge is the recurring failure: reps getting faster, late Zone 4/5 spikes. A well-executed easy session ends on its SLOWEST, calmest rep.
3. Progression is cleared by DATA, not feeling. Graduation = talk test held throughout AND HR peaks only in the low 150s. State the criterion explicitly when you clear or hold him.
4. External constraints beat willpower. Outdoors he has no governor (the treadmill belt was doing the pacing); the fix is a governor, not "try to hold back."
5. Overstriding (faster pace at flat/low cadence, under 125 spm) is his hip-flexor mechanism — flag it and prescribe quicker turnover, not longer stride.
6. Heat: Georgia summer adds 10–20 bpm; a hot day isn't automatically bad, but isn't automatically excused.
7. Progression is jog LONGER and walk LESS — never run faster. There is no "next pace target." Current prescribed easy pace is ~13:30–14:00/mi.
8. Do NOT give diet or calorie targets.

What good looks like: jog reps within ~15 s/mi of each other, last rep slowest; avg HR 130–140; peaks 145–152; Zone 4 under 10%; Zone 5 ~zero; cadence trending to 125.

You are given deterministic metrics already computed from the screenshots — trust them; short-interval GPS pace is noisy so read the trend, not any one rep. Be direct, warm, and concise. Give him credit for the part he earned before naming the part he didn't.`;

async function narrateCoaching(run, detail, computed) {
  if (!anthropic) return null;
  const payload = {
    date: run.date,
    activityType: run.type,
    surface: detail && detail.surface,
    subjective: run.notes || null,
    prescribedPace: '13:30–14:00/mi (easy)',
    metrics: computed.metrics,
    reps: (detail && detail.reps) || null,
    zones: (detail && detail.zones) || null,
    cadenceSpm: detail && detail.cadenceSpm,
    elevationGainFt: detail && detail.elevationGainFt,
    flagsComputed: computed.flags,
  };
  const response = await anthropic.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1200,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: COACH_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: NARRATIVE_SCHEMA } },
    messages: [{ role: 'user', content: `Review this session and return the structured read.\n\n${JSON.stringify(payload, null, 2)}` }],
  });
  if (response.stop_reason === 'refusal') return null;
  const tb = response.content.find((b) => b.type === 'text');
  if (!tb) return null;
  return JSON.parse(tb.text);
}

// full pass: compute + narrate + persist on the run
async function analyzeAndStore(run, detail) {
  const computed = computeCoaching(run, detail);
  let narrative = null;
  try { narrative = await narrateCoaching(run, detail, computed); }
  catch (err) { console.error('narrateCoaching failed:', err.message); }
  const coaching = {
    generatedAt: new Date().toISOString(),
    treadmill: computed.treadmill,
    metrics: computed.metrics,
    flags: computed.flags,
    verdict: narrative && narrative.verdict,
    observations: (narrative && narrative.observations) || [],
    advancement: narrative && narrative.advancement,
  };
  await pool.query('UPDATE runs SET coaching = $1 WHERE id = $2', [JSON.stringify(coaching), run.id]);
  return coaching;
}

const REP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['jogSecPerMi', 'walkSecPerMi'],
  properties: {
    jogSecPerMi: { type: ['integer', 'null'], description: 'Jog/run interval pace in seconds per mile (e.g. 12:07/mi = 727)' },
    walkSecPerMi: { type: ['integer', 'null'], description: 'Following walk/recovery pace in seconds per mile' },
  },
};

const ZONES_SCHEMA = {
  type: ['object', 'null'], additionalProperties: false,
  required: ['z1Sec', 'z2Sec', 'z3Sec', 'z4Sec', 'z5Sec'],
  properties: {
    z1Sec: { type: ['integer', 'null'] }, z2Sec: { type: ['integer', 'null'] },
    z3Sec: { type: ['integer', 'null'] }, z4Sec: { type: ['integer', 'null'] },
    z5Sec: { type: ['integer', 'null'] },
  },
};

const IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['activityType', 'date', 'miles', 'seconds', 'avgHr', 'maxHr', 'notes', 'mapImageIndex',
    'surface', 'cadenceSpm', 'elevationGainFt', 'warmupSecPerMi', 'reps', 'zones'],
  properties: {
    activityType: { type: 'string', enum: ['run', 'walk', 'hike', 'ride', 'workout', 'other'] },
    mapImageIndex: { type: ['integer', 'null'], description: '0-based index of the image that shows a route map (a GPS trace on a map), or null if none do' },
    date: { type: ['string', 'null'], description: 'Workout date as YYYY-MM-DD if visible, else null' },
    miles: { type: ['number', 'null'], description: 'Total distance in miles (convert from km if needed); null if not a distance activity' },
    seconds: { type: ['integer', 'null'], description: 'Total workout duration in seconds' },
    avgHr: { type: ['integer', 'null'] },
    maxHr: { type: ['integer', 'null'] },
    notes: { type: 'string', description: 'One or two sentences: interval structure, cadence, elevation gain, calories, HR zone split — whatever is visible' },
    surface: { type: ['string', 'null'], enum: ['treadmill', 'outdoor', null], description: 'treadmill if a belt speed / no GPS map; outdoor if there is a GPS route/map; null if unclear' },
    cadenceSpm: { type: ['integer', 'null'], description: 'Average cadence in steps per minute' },
    elevationGainFt: { type: ['number', 'null'], description: 'Elevation gain in feet' },
    warmupSecPerMi: { type: ['integer', 'null'], description: 'Warm-up pace in seconds per mile, if a distinct warm-up segment is shown' },
    reps: {
      type: ['array', 'null'],
      description: 'One entry per interval, in order, from the per-interval/splits screen (Workout/Recovery rows). Null if no interval breakdown is visible.',
      items: REP_SCHEMA,
    },
    zones: ZONES_SCHEMA,
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
- notes: a compact 1-2 sentence summary of what's visible: interval structure (e.g. "1:00/1:30 ×8"), cadence, elevation gain, calories, HR zone split, location. If a subjective "how it felt" note is visible, include it.
- mapImageIndex: the 0-based index of the image containing a route map (GPS trace drawn on a map), or null if no image shows one.
- surface: "treadmill" if a belt speed is shown or there is no GPS map; "outdoor" if a GPS route/map is present; null if unclear.
- cadenceSpm, elevationGainFt: from the summary if shown.
- warmupSecPerMi: pace of the warm-up segment if the splits screen shows a distinct warm-up row.
- reps: if a per-interval / splits screen is present (rows like Warm-up / Workout / Recovery with a Pace column), return one array entry per WORK interval in order — jogSecPerMi = that Workout row's pace in seconds per mile, walkSecPerMi = the following Recovery row's pace. Convert mm'ss" to total seconds (12'07" = 727). Do NOT include the warm-up as a rep. Null if no per-interval breakdown is visible.
- zones: seconds spent in each HR zone from the Heart rate zones screen (convert mm:ss to seconds). Null if no zone breakdown is shown.`,
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

    // capture session detail for the coaching pass
    const reps = Array.isArray(parsed.reps)
      ? parsed.reps.filter((r) => r && (Number.isFinite(r.jogSecPerMi) || Number.isFinite(r.walkSecPerMi)))
          .map((r, i) => ({ n: i + 1, jogSecPerMi: r.jogSecPerMi ?? null, walkSecPerMi: r.walkSecPerMi ?? null }))
      : [];
    const detail = {
      surface: parsed.surface || null,
      cadenceSpm: Number.isFinite(parsed.cadenceSpm) ? parsed.cadenceSpm : null,
      elevationGainFt: Number.isFinite(parsed.elevationGainFt) ? parsed.elevationGainFt : null,
      warmupSecPerMi: Number.isFinite(parsed.warmupSecPerMi) ? parsed.warmupSecPerMi : null,
      reps,
      zones: parsed.zones || null,
    };
    await pool.query('UPDATE runs SET detail = $1 WHERE id = $2', [JSON.stringify(detail), created.id]);
    created.detail = detail;

    // coach the interval running sessions automatically
    let coaching = null;
    if (created.type === 'run' && (reps.length >= 2 || detail.zones)) {
      try { coaching = await analyzeAndStore(created, detail); }
      catch (err) { console.error('auto-coaching failed:', err.message); }
    }
    res.status(201).json({ run: { ...created, photoIds, mapPhotoId, coaching } });
  } catch (err) {
    console.error('POST /api/import failed:', err.message);
    res.status(500).json({ error: 'Import failed — try again or add the workout manually.' });
  }
});

// re-run the coaching read on an existing run (manual button)
app.post('/api/runs/:id/analyze', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Run not found' });
    const run = rows[0];
    const detail = run.detail || null;
    if (!detail || (!(detail.reps && detail.reps.length >= 2) && !detail.zones)) {
      return res.status(422).json({ error: 'Not enough detail to analyze — import the interval-splits and HR-zone screenshots for this run.' });
    }
    const coaching = await analyzeAndStore(run, detail);
    res.json({ coaching });
  } catch (err) {
    console.error('POST /api/runs/:id/analyze failed:', err.message);
    res.status(500).json({ error: 'Analysis failed — try again.' });
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
