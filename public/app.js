'use strict';

// ---------- state ----------

const state = { runs: [], goals: {}, body: [], range: '12W', paceMode: 'run', weeklyPaceMode: 'run' };

// "Running only" = mean of the jog-interval paces (excludes walk recovery);
// falls back to overall pace when a run has no per-rep detail.
function jogPaceMean(r) {
  const reps = (r.detail && r.detail.reps) || [];
  const j = reps.map((x) => x && x.jogSecPerMi).filter((v) => Number.isFinite(v) && v > 0);
  return j.length ? j.reduce((a, b) => a + b, 0) / j.length : null;
}
function runPaceSecPerMi(r, mode) {
  if (mode === 'run') {
    const jp = jogPaceMean(r);
    if (jp) return jp;
  }
  return r.miles > 0 ? r.seconds / r.miles : null;
}

// Execution-quality dot from the coaching read, for the log at a glance.
function runQuality(r) {
  if (r.type && r.type !== 'run') return null;
  const c = r.coaching;
  if (!c) return { dot: '⚪', label: 'No coaching read yet — import the splits + HR-zone screenshots' };
  const m = c.metrics || {};
  const hard = (c.flags || []).filter((f) => f.level === 'flag');
  const blew = hard.some((f) => /surge|ran hot|above zone|overstrid|anaerobic/i.test(f.text))
    || (m.maxHr && m.maxHr >= 158);
  if (m.gate && m.gate.pass) return { dot: '🟢', label: 'Nailed it — held your parameters' };
  if (blew) return { dot: '🔴', label: 'Blew it up — surged / ran hot' };
  if (hard.length) return { dot: '🟡', label: 'Mixed — a couple of flags' };
  return { dot: '🟢', label: 'Held your parameters' };
}

function buildPaceToggle(el, getMode, setMode) {
  el.textContent = '';
  el.className = 'seg pace-seg';
  for (const [val, label] of [['run', 'Running only'], ['all', 'Incl. recovery']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(val === getMode()));
    b.addEventListener('click', () => { setMode(val); });
    el.appendChild(b);
  }
}

const RANGES = [
  { key: '4W', label: '4 wk', weeks: 4 },
  { key: '12W', label: '12 wk', weeks: 12 },
  { key: '26W', label: '26 wk', weeks: 26 },
  { key: 'YTD', label: 'YTD' },
  { key: 'ALL', label: 'All' },
];

const $ = (sel) => document.querySelector(sel);

const MOODS = { 1: ['😖', 'Rough'], 2: ['😕', 'Meh'], 3: ['😐', 'OK'], 4: ['🙂', 'Good'], 5: ['🤩', 'Great'] };
const ACTIVITIES = {
  run: ['🏃', 'Run'], walk: ['🚶', 'Walk'], hike: ['🥾', 'Hike'],
  ride: ['🚴', 'Ride'], workout: ['💪', 'Workout'], other: ['✨', 'Other'],
};
const DISTANCE_TYPES = new Set(['run', 'walk', 'hike', 'ride']);
const actInfo = (t) => ACTIVITIES[t] || ACTIVITIES.other;
const expandedRuns = new Set();

function fillTypeSelect(sel) {
  for (const [val, [emoji, label]] of Object.entries(ACTIVITIES)) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = `${emoji} ${label}`;
    sel.appendChild(opt);
  }
}

// mood picker: 5 emoji toggle buttons writing to a data attribute
function initMoodPicker(el) {
  for (const [val, [emoji, label]] of Object.entries(MOODS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', 'false');
    b.dataset.val = val;
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      if (!on) b.setAttribute('aria-pressed', 'true');
      el.dataset.mood = on ? '' : val;
    });
    el.appendChild(b);
  }
}
function setMoodPicker(el, mood) {
  el.dataset.mood = mood || '';
  el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.val) === mood)));
}
const getMood = (el) => (el.dataset.mood ? Number(el.dataset.mood) : null);

// notes are untrusted text; only http(s) URLs become anchors
function notesToFragment(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const a = document.createElement('a');
      a.href = part;
      a.textContent = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
    } else if (part) {
      frag.appendChild(document.createTextNode(part));
    }
  });
  return frag;
}

// ---------- date & format helpers ----------

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7)); // Monday

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtShort = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const fmtTable = (s) => {
  const d = parseYmd(s);
  return `${DAYS[d.getDay()]}, ${fmtShort(d)}${d.getFullYear() !== new Date().getFullYear() ? ', ' + d.getFullYear() : ''}`;
};

function fmtDur(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
function fmtPace(secPerMile) {
  if (!isFinite(secPerMile) || secPerMile <= 0) return '—';
  const sec = Math.round(secPerMile);
  return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;
}
const fmtMiles = (m) => (Math.round(m * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ---------- api ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Not logged in');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---------- auth ----------

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#loginPassword').focus();
}

const TAGLINES = [
  'The slow jog IS the workout. 🐢',
  'Rep 6 should look like rep 1. 😤',
  'Easy is the win condition. 🎯',
  'Bank it as comfort, not speed. 🏦',
  'Pick the feet up quicker, not farther. 👟',
  'The talk test never lies. 🗣️',
  'Slow is smooth, smooth is fast. 🌊',
  'Run the mile you’re in. 🛣️',
  'Zone 3 is where the magic lives. 💙',
  'Every easy run is a vote for race day. 🗳️',
];

// Curated hue palette — one "vibe" per day, cycled by day-of-year.
// Each is a base hue (the cool arm); the warm arm is +28° in CSS.
const BG_HUES = [
  208, // sky blue
  28,  // sunrise orange
  150, // forest green
  190, // teal
  262, // indigo dusk
  330, // magenta
  45,  // gold
  12,  // track red-clay
  172, // spring green
  228, // twilight
];
const ROUTE_BASE_HUE = 213; // the breadcrumb SVG's built-in blue

function showApp(authRequired) {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#logoutBtn').classList.toggle('hidden', !authRequired);
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  $('#tagline').textContent = TAGLINES[dayOfYear % TAGLINES.length];
  const hue = BG_HUES[dayOfYear % BG_HUES.length];
  const root = document.documentElement.style;
  root.setProperty('--bg-hue', String(hue));
  root.setProperty('--route-rotate', `${hue - ROUTE_BASE_HUE}deg`);
  // daily running photo (1..6), rotated independently of the hue
  const photo = (dayOfYear % 6) + 1;
  const el = $('#bgphoto');
  if (el) el.style.backgroundImage = `url("/bg/run${photo}.jpg")`;
}

async function init() {
  $('#addDate').value = ymd(new Date());
  buildRangeSeg();
  wireForms();

  let session;
  try {
    session = await api('/api/session');
  } catch {
    $('#headerSub').textContent = 'Server unreachable — retrying…';
    return setTimeout(init, 3000);
  }
  if (session.authRequired && !session.authed) return showLogin();
  showApp(session.authRequired);
  if (!session.dbReady) {
    $('#headerSub').textContent = 'Database starting up…';
    return setTimeout(init, 3000);
  }
  await loadData();
}

async function loadData() {
  try {
    const [runsRes, goalsRes, bodyRes] = await Promise.all([api('/api/runs'), api('/api/goals'), api('/api/body')]);
    state.runs = runsRes.runs;
    state.goals = goalsRes.goals || {};
    state.body = bodyRes.metrics || [];
    $('#headerSub').textContent = '';
    renderAll();
  } catch (err) {
    $('#headerSub').textContent = err.message;
  }
}

// ---------- range filtering ----------

function rangeCutoff() {
  const today = new Date();
  const r = RANGES.find((r) => r.key === state.range);
  if (r && r.weeks) return addDays(weekStart(today), -7 * (r.weeks - 1));
  if (state.range === 'YTD') return new Date(today.getFullYear(), 0, 1);
  return null;
}

function filteredRuns() {
  const cutoff = rangeCutoff();
  if (!cutoff) return state.runs;
  const c = ymd(cutoff);
  return state.runs.filter((r) => r.date >= c);
}

function buildRangeSeg() {
  const seg = $('#rangeSeg');
  for (const r of RANGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.label;
    b.setAttribute('aria-pressed', String(r.key === state.range));
    b.addEventListener('click', () => {
      state.range = r.key;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      renderAll();
    });
    seg.appendChild(b);
  }
}

// ---------- rendering ----------

function filteredBody() {
  const cutoff = rangeCutoff();
  if (!cutoff) return state.body;
  const c = ymd(cutoff);
  return state.body.filter((m) => m.date >= c);
}

function renderAll() {
  renderTiles();
  renderGoals();
  renderWeeklyChart();
  renderPaceChart();
  renderRunTrends();
  renderTable();
  renderBodyCharts();
  renderBodyTable();
}

function tile(label, value, unit, delta, deltaUp) {
  const el = document.createElement('div');
  el.className = 'tile';
  const l = document.createElement('div');
  l.className = 't-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 't-value';
  v.textContent = value;
  if (unit) {
    const u = document.createElement('span');
    u.className = 't-unit';
    u.textContent = unit;
    v.appendChild(u);
  }
  const d = document.createElement('div');
  d.className = 't-delta' + (deltaUp ? ' up' : '');
  d.textContent = delta || ' ';
  el.append(l, v, d);
  return el;
}

function sumMiles(runs) {
  return runs.reduce((a, r) => a + r.miles, 0);
}

function renderTiles() {
  const tiles = $('#tiles');
  tiles.textContent = '';
  const all = filteredRuns();
  const runsOnly = all.filter((r) => r.type === 'run' || !r.type);
  const rangeLabel = RANGES.find((r) => r.key === state.range).label;

  const thisWeekStart = ymd(weekStart(new Date()));
  const lastWeekStart = ymd(addDays(weekStart(new Date()), -7));
  const thisWeek = sumMiles(state.runs.filter((r) => r.date >= thisWeekStart));
  const lastWeek = sumMiles(state.runs.filter((r) => r.date >= lastWeekStart && r.date < thisWeekStart));
  const diff = thisWeek - lastWeek;
  tiles.appendChild(tile(
    'This week', fmtMiles(thisWeek), 'mi',
    `${diff >= 0 ? '+' : '−'}${fmtMiles(Math.abs(diff))} mi vs last week`, diff > 0
  ));

  const total = sumMiles(all);
  tiles.appendChild(tile(`Miles · ${rangeLabel}`, fmtMiles(total), 'mi', `${all.length} activit${all.length === 1 ? 'y' : 'ies'}`));

  const runMiles = sumMiles(runsOnly);
  const runSec = runsOnly.reduce((a, r) => a + r.seconds, 0);
  tiles.appendChild(tile(`Avg run pace · ${rangeLabel}`, runMiles > 0 ? fmtPace(runSec / runMiles) : '—', runMiles > 0 ? '/mi' : '', runMiles > 0 ? `${runsOnly.length} run${runsOnly.length === 1 ? '' : 's'}` : ''));

  const longest = all.reduce((best, r) => (best === null || r.miles > best.miles ? r : best), null);
  tiles.appendChild(tile(
    `Longest · ${rangeLabel}`,
    longest && longest.miles > 0 ? fmtMiles(longest.miles) : '—', longest && longest.miles > 0 ? 'mi' : '',
    longest && longest.miles > 0 ? `${actInfo(longest.type)[1]} · ${fmtTable(longest.date)}` : ''
  ));
}

function renderGoals() {
  const body = $('#goalsBody');
  body.textContent = '';
  const g = state.goals;
  let has = false;

  if (g.weeklyMiles > 0) {
    has = true;
    const thisWeekStart = ymd(weekStart(new Date()));
    const thisWeek = sumMiles(state.runs.filter((r) => r.date >= thisWeekStart));
    const pct = Math.min(100, (thisWeek / g.weeklyMiles) * 100);
    const row = document.createElement('div');
    row.className = 'goal-row';
    const label = document.createElement('div');
    label.className = 'g-label';
    const left = document.createElement('span');
    left.textContent = `This week: ${fmtMiles(thisWeek)} of ${fmtMiles(g.weeklyMiles)} mi`;
    const right = document.createElement('span');
    right.textContent = `${Math.round((thisWeek / g.weeklyMiles) * 100)}%`;
    label.append(left, right);
    const meter = document.createElement('div');
    meter.className = 'meter';
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuenow', String(Math.round(pct)));
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    const fill = document.createElement('div');
    fill.style.width = pct + '%';
    meter.appendChild(fill);
    row.append(label, meter);
    body.appendChild(row);
  }

  if (g.raceName && g.raceDate) {
    has = true;
    const row = document.createElement('div');
    row.className = 'goal-row race-line';
    const race = parseYmd(g.raceDate);
    const today = parseYmd(ymd(new Date()));
    const days = Math.round((race - today) / 86400000);
    const name = g.raceName + (g.raceMiles ? ` (${fmtMiles(g.raceMiles)} mi)` : '');
    const when = days > 1 ? `in ${days} days` : days === 1 ? 'tomorrow' : days === 0 ? 'today!' : `${-days} days ago`;
    row.textContent = `${name} — ${fmtShort(race)}: `;
    const strong = document.createElement('span');
    strong.className = 'days';
    strong.textContent = when;
    row.appendChild(strong);
    body.appendChild(row);
  }

  if (!has) {
    const p = document.createElement('div');
    p.className = 'goal-empty';
    p.textContent = 'No goals set — add a weekly mileage target or a race.';
    p.style.marginBottom = '12px';
    body.appendChild(p);
  }
}

// ---------- charts ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceMax(v) {
  if (v <= 0) return { step: 2.5, max: 10 };
  const raw = v / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw);
  return { step, max: Math.ceil(v / step) * step };
}

function makeTooltip(wrap) {
  let tt = wrap.querySelector('.tooltip');
  if (!tt) {
    tt = document.createElement('div');
    tt.className = 'tooltip hidden';
    wrap.appendChild(tt);
  }
  return tt;
}

function fillTooltip(tt, title, rows) {
  tt.textContent = '';
  const t = document.createElement('div');
  t.className = 'tt-title';
  t.textContent = title;
  tt.appendChild(t);
  for (const [val, label, color] of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'tt-key';
    if (color) key.style.borderTopColor = color;
    const v = document.createElement('span');
    v.className = 'tt-val';
    v.textContent = val;
    const l = document.createElement('span');
    l.className = 'tt-label';
    l.textContent = label;
    row.append(key, v, l);
    tt.appendChild(row);
  }
}

function placeTooltip(tt, wrap, x, y) {
  const w = wrap.clientWidth;
  tt.classList.remove('hidden');
  const ttw = tt.offsetWidth;
  tt.style.left = (x + 14 + ttw > w ? x - ttw - 12 : x + 14) + 'px';
  tt.style.top = Math.max(0, y - tt.offsetHeight - 10) + 'px';
}

function weeklyBuckets() {
  const today = new Date();
  const thisWeek = weekStart(today);
  let start = rangeCutoff();
  if (!start) {
    if (!state.runs.length) return [];
    start = weekStart(parseYmd(state.runs[state.runs.length - 1].date));
  }
  start = weekStart(start);
  const buckets = [];
  for (let d = start; d <= thisWeek; d = addDays(d, 7)) {
    buckets.push({ start: d, key: ymd(d), miles: 0, count: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const r of state.runs) {
    const b = byKey.get(ymd(weekStart(parseYmd(r.date))));
    if (b) { b.miles += r.miles; b.count += 1; }
  }
  return buckets;
}

function renderWeeklyChart() {
  const wrap = $('#weeklyChart');
  wrap.textContent = '';
  const buckets = weeklyBuckets();
  $('#weeklySub').textContent = buckets.length ? `${buckets.length} weeks, Mondays-based` : '';
  if (!buckets.length || !state.runs.length) {
    const p = document.createElement('div');
    p.className = 'empty-note';
    p.textContent = 'No runs yet — the weekly chart will fill in as you log them.';
    wrap.appendChild(p);
    return;
  }

  const width = Math.max(320, wrap.clientWidth);
  const height = 240, mL = 40, mR = 14, mT = 18, mB = 28;
  const plotW = width - mL - mR, plotH = height - mT - mB;
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Weekly mileage column chart' });

  const goal = state.goals.weeklyMiles > 0 ? state.goals.weeklyMiles : 0;
  const dataMax = Math.max(...buckets.map((b) => b.miles), goal, 1);
  const { step, max } = niceMax(dataMax);

  const y = (v) => mT + plotH - (v / max) * plotH;
  const slot = plotW / buckets.length;
  const barW = Math.max(3, Math.min(24, slot - 2));

  // gridlines + y ticks
  for (let i = 1; i * step <= max + 1e-9; i++) {
    const v = Math.round(i * step * 100) / 100;
    svg.appendChild(svgEl('line', { x1: mL, x2: width - mR, y1: y(v), y2: y(v), stroke: cssVar('--grid'), 'stroke-width': 1 }));
    const t = svgEl('text', { x: mL - 8, y: y(v) + 4, 'text-anchor': 'end', fill: cssVar('--muted'), 'font-size': 11, style: 'font-variant-numeric: tabular-nums' });
    t.textContent = fmtMiles(v);
    svg.appendChild(t);
  }
  // baseline
  svg.appendChild(svgEl('line', { x1: mL, x2: width - mR, y1: y(0), y2: y(0), stroke: cssVar('--baseline'), 'stroke-width': 1 }));

  const maxBucket = buckets.reduce((a, b) => (b.miles > a.miles ? b : a), buckets[0]);
  const series = cssVar('--series');
  const bars = [];
  buckets.forEach((b, i) => {
    const cx = mL + slot * i + slot / 2;
    const x = cx - barW / 2;
    if (b.miles > 0) {
      const top = y(b.miles), base = y(0);
      const r = Math.min(4, barW / 2, Math.max(0, base - top));
      const bar = svgEl('path', {
        d: `M ${x} ${base} V ${top + r} Q ${x} ${top} ${x + r} ${top} H ${x + barW - r} Q ${x + barW} ${top} ${x + barW} ${top + r} V ${base} Z`,
        fill: series,
      });
      svg.appendChild(bar);
      bars[i] = bar;
      // direct-label the biggest week only
      if (b === maxBucket && base - top > 8) {
        const t = svgEl('text', { x: cx, y: top - 5, 'text-anchor': 'middle', fill: cssVar('--ink-2'), 'font-size': 11, 'font-weight': 600 });
        t.textContent = fmtMiles(b.miles);
        svg.appendChild(t);
      }
    }
    // x labels: at most ~8
    const every = Math.ceil(buckets.length / 8);
    if (i % every === 0) {
      const t = svgEl('text', { x: cx, y: height - 8, 'text-anchor': 'middle', fill: cssVar('--muted'), 'font-size': 11 });
      t.textContent = fmtShort(b.start);
      svg.appendChild(t);
    }
  });

  // goal target line (a real threshold, so dashed is meaningful here)
  if (goal > 0 && goal <= max) {
    svg.appendChild(svgEl('line', { x1: mL, x2: width - mR, y1: y(goal), y2: y(goal), stroke: cssVar('--muted'), 'stroke-width': 1, 'stroke-dasharray': '4 3' }));
    const t = svgEl('text', { x: width - mR, y: y(goal) - 4, 'text-anchor': 'end', fill: cssVar('--muted'), 'font-size': 11 });
    t.textContent = `goal ${fmtMiles(goal)}`;
    svg.appendChild(t);
  }

  wrap.appendChild(svg);
  const tt = makeTooltip(wrap);

  // hover: full-height hit target per week (bigger than the mark)
  buckets.forEach((b, i) => {
    const hit = svgEl('rect', { x: mL + slot * i, y: mT, width: slot, height: plotH, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => {
      if (bars[i]) bars[i].style.filter = 'brightness(1.18)';
      fillTooltip(tt, `Week of ${fmtShort(b.start)}`, [
        [`${fmtMiles(b.miles)} mi`, `${b.count} run${b.count === 1 ? '' : 's'}`],
      ]);
      const rect = wrap.getBoundingClientRect();
      placeTooltip(tt, wrap, e.clientX - rect.left, e.clientY - rect.top);
    });
    hit.addEventListener('pointerleave', () => {
      if (bars[i]) bars[i].style.filter = '';
      tt.classList.add('hidden');
    });
    svg.appendChild(hit);
  });
}

function renderPaceChart() {
  buildPaceToggle($('#paceToggle'), () => state.paceMode, (v) => { state.paceMode = v; renderPaceChart(); });
  const wrap = $('#paceChart');
  wrap.textContent = '';
  const runs = filteredRuns()
    .filter((r) => (r.type === 'run' || !r.type) && Number.isFinite(runPaceSecPerMi(r, state.paceMode)))
    .slice().reverse(); // ascending by date
  if (runs.length < 2) {
    const p = document.createElement('div');
    p.className = 'empty-note';
    p.textContent = 'Log at least two runs to see your pace trend.';
    wrap.appendChild(p);
    return;
  }

  const width = Math.max(320, wrap.clientWidth);
  const height = 240, mL = 46, mR = 46, mT = 14, mB = 28;
  const plotW = width - mL - mR, plotH = height - mT - mB;
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Pace trend line chart' });

  const pts = runs.map((r) => ({ run: r, t: parseYmd(r.date).getTime(), pace: runPaceSecPerMi(r, state.paceMode) }));
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const paces = pts.map((p) => p.pace);
  let pMin = Math.min(...paces), pMax = Math.max(...paces);
  const pad = Math.max((pMax - pMin) * 0.15, 15);
  pMin = Math.max(0, pMin - pad);
  pMax = pMax + pad;

  // pace ticks on clean 15/30/60/120s steps
  const tickStep = [15, 30, 60, 120, 300].find((s) => (pMax - pMin) / s <= 6) || 300;
  const x = (t) => (t1 === t0 ? mL + plotW / 2 : mL + ((t - t0) / (t1 - t0)) * plotW);
  const y = (p) => mT + ((p - pMin) / (pMax - pMin || 1)) * plotH; // lower pace (faster) at top

  const firstTick = Math.ceil(pMin / tickStep) * tickStep;
  for (let v = firstTick; v <= pMax; v += tickStep) {
    svg.appendChild(svgEl('line', { x1: mL, x2: width - mR, y1: y(v), y2: y(v), stroke: cssVar('--grid'), 'stroke-width': 1 }));
    const t = svgEl('text', { x: mL - 8, y: y(v) + 4, 'text-anchor': 'end', fill: cssVar('--muted'), 'font-size': 11, style: 'font-variant-numeric: tabular-nums' });
    t.textContent = fmtPace(v);
    svg.appendChild(t);
  }
  svg.appendChild(svgEl('line', { x1: mL, x2: width - mR, y1: mT + plotH, y2: mT + plotH, stroke: cssVar('--baseline'), 'stroke-width': 1 }));

  // x labels: ~6 date labels
  const nLabels = Math.min(6, pts.length);
  for (let i = 0; i < nLabels; i++) {
    const t = t0 + ((t1 - t0) * i) / Math.max(1, nLabels - 1);
    const lbl = svgEl('text', { x: x(t), y: height - 8, 'text-anchor': 'middle', fill: cssVar('--muted'), 'font-size': 11 });
    lbl.textContent = fmtShort(new Date(t));
    svg.appendChild(lbl);
  }

  const series = cssVar('--series');
  const surface = cssVar('--surface');
  const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p.pace).toFixed(1)}`).join(' ');
  svg.appendChild(svgEl('path', { d, fill: 'none', stroke: series, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  const dots = pts.map((p) =>
    svg.appendChild(svgEl('circle', { cx: x(p.t), cy: y(p.pace), r: 4, fill: series, stroke: surface, 'stroke-width': 2 }))
  );

  // direct label at the line's end: latest pace
  const last = pts[pts.length - 1];
  const endLbl = svgEl('text', { x: x(last.t) + 9, y: y(last.pace) + 4, fill: cssVar('--ink-2'), 'font-size': 11, 'font-weight': 600 });
  endLbl.textContent = fmtPace(last.pace);
  svg.appendChild(endLbl);

  // crosshair + tooltip: snap to nearest run by x
  const cross = svgEl('line', { y1: mT, y2: mT + plotH, stroke: cssVar('--baseline'), 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const overlay = svgEl('rect', { x: mL, y: mT, width: plotW, height: plotH, fill: 'transparent' });
  wrap.appendChild(svg);
  const tt = makeTooltip(wrap);
  let hot = -1;

  overlay.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0, bestDist = Infinity;
    pts.forEach((p, i) => {
      const dx = Math.abs(x(p.t) - px);
      if (dx < bestDist) { bestDist = dx; best = i; }
    });
    if (hot >= 0) dots[hot].setAttribute('r', 4);
    hot = best;
    dots[hot].setAttribute('r', 5.5);
    const p = pts[best];
    cross.setAttribute('x1', x(p.t));
    cross.setAttribute('x2', x(p.t));
    cross.setAttribute('visibility', 'visible');
    const rows = [
      [`${fmtPace(p.pace)} /mi`, 'pace'],
      [`${fmtMiles(p.run.miles)} mi`, fmtDur(p.run.seconds)],
    ];
    if (p.run.avgHr) rows.push([`${p.run.avgHr} bpm`, p.run.maxHr ? `avg HR (max ${p.run.maxHr})` : 'avg HR']);
    fillTooltip(tt, fmtTable(p.run.date), rows);
    const wrect = wrap.getBoundingClientRect();
    placeTooltip(tt, wrap, x(p.t), Math.min(e.clientY - wrect.top, y(p.pace)));
  });
  overlay.addEventListener('pointerleave', () => {
    if (hot >= 0) dots[hot].setAttribute('r', 4);
    hot = -1;
    cross.setAttribute('visibility', 'hidden');
    tt.classList.add('hidden');
  });
  svg.appendChild(overlay);
}

// ---------- generic multi-series trend chart ----------
// series: [{ name, color, points: [{t, v, dateStr}] }] — points ascending by t.
// opts: yFmt, tickCandidates, invertY (pace: faster up), unit, emptyMsg, height

function renderMultiLine(wrap, seriesList, opts = {}) {
  wrap.textContent = '';
  const series = seriesList.filter((s) => s.points.length > 0);
  const totalPts = series.reduce((a, s) => a + s.points.length, 0);
  if (!series.length || totalPts < 2) {
    const p = document.createElement('div');
    p.className = 'empty-note';
    p.textContent = opts.emptyMsg || 'Not enough data yet — two or more points draw a line.';
    wrap.appendChild(p);
    return;
  }

  if (series.length >= 2) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    for (const s of series) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.style.background = s.color;
      const lbl = document.createElement('span');
      lbl.textContent = s.name;
      item.append(key, lbl);
      lg.appendChild(item);
    }
    wrap.appendChild(lg);
  }

  const width = Math.max(300, wrap.clientWidth);
  const height = opts.height || 200, mL = 48, mR = 16, mT = 12, mB = 26;
  const plotW = width - mL - mR, plotH = height - mT - mB;
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

  const ts = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const t0 = ts[0], t1 = ts[ts.length - 1] || t0 + 1;
  const vs = series.flatMap((s) => s.points.map((p) => p.v));
  let vMin = Math.min(...vs), vMax = Math.max(...vs);
  const pad = Math.max((vMax - vMin) * 0.15, vMax === vMin ? Math.abs(vMax) * 0.02 + 1 : 0);
  vMin -= pad; vMax += pad;

  const x = (t) => (t1 === t0 ? mL + plotW / 2 : mL + ((t - t0) / (t1 - t0)) * plotW);
  const y = (v) => (opts.invertY
    ? mT + ((v - vMin) / (vMax - vMin)) * plotH
    : mT + plotH - ((v - vMin) / (vMax - vMin)) * plotH);

  const range = vMax - vMin;
  let step;
  if (opts.tickCandidates) {
    step = opts.tickCandidates.find((s) => range / s <= 6) || opts.tickCandidates[opts.tickCandidates.length - 1];
  } else {
    const raw = range / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) || mag * 10;
  }
  const yFmt = opts.yFmt || ((v) => fmtMiles(v));
  for (let v = Math.ceil(vMin / step) * step; v <= vMax + 1e-9; v += step) {
    const vv = Math.round(v * 1000) / 1000;
    svg.appendChild(svgEl('line', { x1: mL, x2: width - mR, y1: y(vv), y2: y(vv), stroke: cssVar('--grid'), 'stroke-width': 1 }));
    const t = svgEl('text', { x: mL - 8, y: y(vv) + 4, 'text-anchor': 'end', fill: cssVar('--muted'), 'font-size': 11, style: 'font-variant-numeric: tabular-nums' });
    t.textContent = yFmt(vv);
    svg.appendChild(t);
  }
  svg.appendChild(svgEl('line', { x1: mL, x2: width - mR, y1: mT + plotH, y2: mT + plotH, stroke: cssVar('--baseline'), 'stroke-width': 1 }));

  const nLabels = Math.min(5, ts.length);
  for (let i = 0; i < nLabels; i++) {
    const t = t0 + ((t1 - t0) * i) / Math.max(1, nLabels - 1);
    const lbl = svgEl('text', { x: x(t), y: height - 8, 'text-anchor': 'middle', fill: cssVar('--muted'), 'font-size': 11 });
    lbl.textContent = fmtShort(new Date(t));
    svg.appendChild(lbl);
  }

  const surface = cssVar('--surface');
  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (const p of s.points) {
      svg.appendChild(svgEl('circle', { cx: x(p.t), cy: y(p.v), r: 4, fill: s.color, stroke: surface, 'stroke-width': 2 }));
    }
    // single series: direct-label the latest value; flip inside when it won't fit
    if (series.length === 1 && s.points.length) {
      const last = s.points[s.points.length - 1];
      const lx = x(last.t);
      const fits = lx + 9 + 42 <= width;
      const endLbl = svgEl('text', {
        x: fits ? lx + 9 : lx - 8,
        y: fits ? y(last.v) + 4 : y(last.v) - 9,
        'text-anchor': fits ? 'start' : 'end',
        fill: cssVar('--ink-2'), 'font-size': 11, 'font-weight': 600,
      });
      endLbl.textContent = yFmt(last.v);
      svg.appendChild(endLbl);
    }
  }

  const cross = svgEl('line', { y1: mT, y2: mT + plotH, stroke: cssVar('--baseline'), 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const overlay = svgEl('rect', { x: mL, y: mT, width: plotW, height: plotH, fill: 'transparent' });
  wrap.appendChild(svg);
  const tt = makeTooltip(wrap);

  overlay.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = ts[0], bestDist = Infinity;
    for (const t of ts) {
      const dx = Math.abs(x(t) - px);
      if (dx < bestDist) { bestDist = dx; best = t; }
    }
    cross.setAttribute('x1', x(best));
    cross.setAttribute('x2', x(best));
    cross.setAttribute('visibility', 'visible');
    const rows = [];
    let title = fmtShort(new Date(best));
    for (const s of series) {
      const p = s.points.find((q) => q.t === best);
      if (p) {
        rows.push([`${yFmt(p.v)}${opts.unit ? ` ${opts.unit}` : ''}`, s.name, s.color]);
        if (p.dateStr) title = fmtTable(p.dateStr);
      }
    }
    if (!rows.length) return;
    fillTooltip(tt, title, rows);
    const wrect = wrap.getBoundingClientRect();
    placeTooltip(tt, wrap, x(best), e.clientY - wrect.top);
  });
  overlay.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tt.classList.add('hidden');
  });
  svg.appendChild(overlay);
}

const V1 = () => cssVar('--series');
const V2 = () => cssVar('--series-2');
const V3 = () => cssVar('--series-3');

function renderRunTrends() {
  const runs = filteredRuns().filter((r) => (r.type === 'run' || !r.type)).slice().reverse();

  renderMultiLine($('#hrChart'), [{
    name: 'Avg HR',
    color: V1(),
    points: runs.filter((r) => r.avgHr).map((r) => ({ t: parseYmd(r.date).getTime(), v: r.avgHr, dateStr: r.date })),
  }], {
    yFmt: (v) => String(Math.round(v)),
    unit: 'bpm',
    emptyMsg: 'Log avg HR on two or more runs to see the trend.',
  });

  // weekly average pace — distance-weighted mean of each run's chosen pace
  buildPaceToggle($('#weeklyPaceToggle'), () => state.weeklyPaceMode, (v) => { state.weeklyPaceMode = v; renderRunTrends(); });
  const byWeek = new Map();
  for (const r of runs) {
    if (!(r.miles > 0)) continue;
    const p = runPaceSecPerMi(r, state.weeklyPaceMode);
    if (!Number.isFinite(p)) continue;
    const wk = ymd(weekStart(parseYmd(r.date)));
    if (!byWeek.has(wk)) byWeek.set(wk, { paceMiles: 0, miles: 0 });
    const b = byWeek.get(wk);
    b.paceMiles += p * r.miles;
    b.miles += r.miles;
  }
  const weekPts = [...byWeek.entries()]
    .map(([wk, b]) => ({ t: parseYmd(wk).getTime(), v: b.paceMiles / b.miles, dateStr: wk }))
    .sort((a, b) => a.t - b.t);

  renderMultiLine($('#weeklyPaceChart'), [{ name: 'Weekly pace', color: V1(), points: weekPts }], {
    yFmt: fmtPace,
    unit: '/mi',
    invertY: true,
    tickCandidates: [15, 30, 60, 120, 300],
    emptyMsg: 'Two or more weeks of runs draw the pace trend.',
  });
}

// ---------- body metrics ----------

const expandedBody = new Set();

const BODY_FIELDS = [
  ['weightLb', 'Weight', 'lb'],
  ['bodyFatPct', 'Body fat', '%'],
  ['skeletalMusclePct', 'Skeletal muscle', '%'],
  ['bodyWaterPct', 'Body water', '%'],
  ['bmi', 'BMI', ''],
  ['subcutaneousFatPct', 'Subcutaneous fat', '%'],
  ['visceralFat', 'Visceral fat', ''],
  ['boneMassLb', 'Bone mass', 'lb'],
  ['bmrKcal', 'BMR', 'kcal'],
];

function renderBodyCharts() {
  const rows = filteredBody().slice().reverse(); // ascending
  const pts = (field) => rows.filter((m) => m[field] != null)
    .map((m) => ({ t: parseYmd(m.date).getTime(), v: m[field], dateStr: m.date }));

  renderMultiLine($('#weightChart'), [{ name: 'Weight', color: V1(), points: pts('weightLb') }], {
    yFmt: (v) => v.toFixed(1),
    unit: 'lb',
    emptyMsg: 'Two or more weigh-ins draw the weight trend.',
  });

  renderMultiLine($('#compChart'), [
    { name: 'Body fat %', color: V2(), points: pts('bodyFatPct') },
    { name: 'Muscle %', color: V3(), points: pts('skeletalMusclePct') },
    { name: 'Water %', color: V1(), points: pts('bodyWaterPct') },
  ], {
    yFmt: (v) => v.toFixed(1),
    unit: '%',
    emptyMsg: 'Two or more weigh-ins draw the composition trends.',
  });
}

function renderBodyTable() {
  const rows = filteredBody();
  const tbody = $('#bodyTable tbody');
  tbody.textContent = '';
  $('#bodyEmpty').classList.toggle('hidden', rows.length > 0);

  const fmt = (v, unit) => (v == null ? '—' : `${v}${unit === '%' ? '%' : ''}`);
  for (const m of rows) {
    const expanded = expandedBody.has(m.id);
    const tr = document.createElement('tr');
    tr.className = 'run-row';
    tr.tabIndex = 0;
    tr.setAttribute('aria-expanded', String(expanded));
    const chev = document.createElement('td');
    chev.className = 'chev';
    chev.textContent = expanded ? '▼' : '▶';
    tr.appendChild(chev);
    const cells = [
      [fmtTable(m.date), ''],
      [m.weightLb != null ? `${m.weightLb} lb` : '—', 'num'],
      [fmt(m.bodyFatPct, '%'), 'num'],
      [fmt(m.skeletalMusclePct, '%'), 'num'],
      [fmt(m.bodyWaterPct, '%'), 'num'],
      [fmt(m.bmi, ''), 'num'],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    const toggle = () => {
      if (expandedBody.has(m.id)) expandedBody.delete(m.id);
      else expandedBody.add(m.id);
      renderBodyTable();
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    tbody.appendChild(tr);

    if (expanded) {
      const dtr = document.createElement('tr');
      dtr.className = 'detail-row';
      const td = document.createElement('td');
      td.colSpan = 7;
      const grid = document.createElement('div');
      grid.className = 'detail-grid';
      for (const [field, label, unit] of BODY_FIELDS) {
        const item = document.createElement('div');
        item.className = 'd-item';
        const l = document.createElement('div');
        l.className = 'd-label';
        l.textContent = label;
        const v = document.createElement('div');
        v.className = 'd-value';
        v.textContent = m[field] == null ? '—' : `${m[field]}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
        item.append(l, v);
        grid.appendChild(item);
      }
      td.appendChild(grid);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openBodyDialog(m));
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete the weigh-in on ${fmtTable(m.date)}?`)) return;
        try {
          await api(`/api/body/${m.id}`, { method: 'DELETE' });
          state.body = state.body.filter((x) => x.id !== m.id);
          expandedBody.delete(m.id);
          renderAll();
        } catch (err) { alert(err.message); }
      });
      actions.append(edit, del);
      td.appendChild(actions);
      dtr.appendChild(td);
      tbody.appendChild(dtr);
    }
  }
}

function upsertBodyState(metric) {
  state.body = state.body.filter((x) => x.date !== metric.date);
  state.body.push(metric);
  state.body.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function openBodyDialog(m) {
  const d = $('#bodyDialog');
  d.dataset.metricId = m ? String(m.id) : '';
  d.dataset.origDate = m ? m.date : '';
  $('#bodyDialogTitle').textContent = m ? 'Edit weigh-in' : 'Add weigh-in';
  $('#bDate').value = m ? m.date : ymd(new Date());
  const map = { bWeight: 'weightLb', bFat: 'bodyFatPct', bMuscle: 'skeletalMusclePct', bWater: 'bodyWaterPct', bBmi: 'bmi', bSubq: 'subcutaneousFatPct', bVisceral: 'visceralFat', bBone: 'boneMassLb', bBmr: 'bmrKcal' };
  for (const [inputId, field] of Object.entries(map)) {
    $(`#${inputId}`).value = m && m[field] != null ? m[field] : '';
  }
  d.showModal();
}

function wireBody() {
  const dialog = $('#bodyDialog');
  $('#bodyAddBtn').addEventListener('click', () => openBodyDialog(null));
  $('#bodyCancel').addEventListener('click', () => dialog.close());
  $('#bodyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const date = $('#bDate').value;
      const origDate = dialog.dataset.origDate;
      const { metric } = await api('/api/body', {
        method: 'POST',
        body: JSON.stringify({
          date,
          weightLb: $('#bWeight').value || null,
          bodyFatPct: $('#bFat').value || null,
          skeletalMusclePct: $('#bMuscle').value || null,
          bodyWaterPct: $('#bWater').value || null,
          bmi: $('#bBmi').value || null,
          subcutaneousFatPct: $('#bSubq').value || null,
          visceralFat: $('#bVisceral').value || null,
          boneMassLb: $('#bBone').value || null,
          bmrKcal: $('#bBmr').value || null,
        }),
      });
      // date change on an existing row: remove the old row
      if (origDate && origDate !== date) {
        const old = state.body.find((x) => x.date === origDate);
        if (old) {
          await api(`/api/body/${old.id}`, { method: 'DELETE' }).catch(() => {});
          state.body = state.body.filter((x) => x.id !== old.id);
        }
      }
      upsertBodyState(metric);
      dialog.close();
      renderAll();
    } catch (err) { alert(err.message); }
  });

  const btn = $('#bodyImportBtn');
  const input = $('#bodyImportFiles');
  const msg = $('#bodyMsg');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []).slice(0, 6);
    input.value = '';
    if (!files.length) return;
    btn.disabled = true;
    msg.textContent = `Reading ${files.length} screenshot${files.length === 1 ? '' : 's'}…`;
    try {
      const images = [];
      for (const f of files) images.push(await prepareImage(f));
      const { metrics } = await api('/api/body-import', {
        method: 'POST',
        body: JSON.stringify({ images, defaultDate: ymd(new Date()) }),
      });
      for (const m of metrics) upsertBodyState(m);
      renderAll();
      msg.textContent = `Imported ${metrics.length} weigh-in${metrics.length === 1 ? '' : 's'} ✓`;
      setTimeout(() => { if (msg.textContent.startsWith('Imported')) msg.textContent = ''; }, 4000);
    } catch (err) {
      msg.textContent = err.message;
    }
    btn.disabled = false;
  });
}

// ---------- run log table ----------

function renderTable() {
  const runs = filteredRuns();
  const tbody = $('#runTable tbody');
  tbody.textContent = '';
  $('#logSub').textContent = `${runs.length} run${runs.length === 1 ? '' : 's'} in range — click a row for details`;
  $('#logEmpty').classList.toggle('hidden', runs.length > 0);

  for (const r of runs) {
    const expanded = expandedRuns.has(r.id);
    const tr = document.createElement('tr');
    tr.className = 'run-row';
    tr.tabIndex = 0;
    tr.setAttribute('aria-expanded', String(expanded));

    const chev = document.createElement('td');
    chev.className = 'chev';
    chev.textContent = expanded ? '▼' : '▶';
    tr.appendChild(chev);

    const typeCell = document.createElement('td');
    typeCell.className = 'type-cell';
    typeCell.textContent = actInfo(r.type)[0];
    typeCell.title = actInfo(r.type)[1];
    tr.appendChild(typeCell);

    const cells = [
      [fmtTable(r.date), ''],
      [r.miles > 0 ? fmtMiles(r.miles) : '—', 'num'],
      [fmtDur(r.seconds), 'num'],
      [r.miles > 0 ? fmtPace(r.seconds / r.miles) : '—', 'num'],
      [r.avgHr ? String(r.avgHr) : '—', 'num'],
      [r.mood ? MOODS[r.mood][0] : '—', 'mood-cell'],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      if (cls === 'mood-cell' && r.mood) td.title = MOODS[r.mood][1];
      tr.appendChild(td);
    }

    const q = runQuality(r);
    const qCell = document.createElement('td');
    qCell.className = 'quality-cell';
    qCell.textContent = q ? q.dot : '';
    if (q) qCell.title = q.label;
    tr.appendChild(qCell);

    const toggle = () => {
      if (expandedRuns.has(r.id)) expandedRuns.delete(r.id);
      else expandedRuns.add(r.id);
      renderTable();
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    tbody.appendChild(tr);

    if (expanded) tbody.appendChild(buildDetailRow(r));
  }
}

function buildDetailRow(r) {
  const tr = document.createElement('tr');
  tr.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 9;

  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  const items = [
    ['Activity', `${actInfo(r.type)[0]} ${actInfo(r.type)[1]}`],
    ['Distance', r.miles > 0 ? `${fmtMiles(r.miles)} mi` : '—'],
    ['Time', fmtDur(r.seconds)],
    ['Pace', r.miles > 0 ? `${fmtPace(r.seconds / r.miles)} /mi` : '—'],
    ['Avg HR', r.avgHr ? `${r.avgHr} bpm` : '—'],
    ['Max HR', r.maxHr ? `${r.maxHr} bpm` : '—'],
    ['Felt', r.mood ? `${MOODS[r.mood][0]} ${MOODS[r.mood][1]}` : 'Not rated'],
  ];
  for (const [label, value] of items) {
    const item = document.createElement('div');
    item.className = 'd-item';
    const l = document.createElement('div');
    l.className = 'd-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'd-value';
    v.textContent = value;
    item.append(l, v);
    grid.appendChild(item);
  }
  td.appendChild(grid);

  if (r.notes) {
    const notes = document.createElement('div');
    notes.className = 'detail-notes';
    notes.appendChild(notesToFragment(r.notes));
    td.appendChild(notes);
  }

  // coaching read
  if (r.coaching) td.appendChild(buildCoachingBlock(r));

  // route map: a designated screenshot shown large, Strava-style
  const setMap = async (photoId) => {
    try {
      await api(`/api/runs/${r.id}/map`, { method: 'POST', body: JSON.stringify({ photoId }) });
      r.mapPhotoId = photoId;
      renderTable();
    } catch (err) { alert(err.message); }
  };
  if (r.mapPhotoId && (r.photoIds || []).includes(r.mapPhotoId)) {
    const fig = document.createElement('div');
    fig.className = 'map-figure';
    const a = document.createElement('a');
    a.href = `/api/photos/${r.mapPhotoId}`;
    a.target = '_blank';
    a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = `/api/photos/${r.mapPhotoId}`;
    img.loading = 'lazy';
    img.alt = 'Route map';
    a.appendChild(img);
    const cap = document.createElement('div');
    cap.className = 'map-caption';
    const capText = document.createElement('span');
    capText.textContent = '🗺️ Route';
    const unset = document.createElement('button');
    unset.type = 'button';
    unset.textContent = 'unset';
    unset.title = 'Stop using this screenshot as the route map';
    unset.addEventListener('click', () => setMap(null));
    cap.append(capText, unset);
    fig.append(a, cap);
    td.appendChild(fig);
  }

  // remaining screenshots
  const strip = document.createElement('div');
  strip.className = 'photo-strip';
  for (const pid of r.photoIds || []) {
    if (pid === r.mapPhotoId) continue;
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb-wrap';
    const a = document.createElement('a');
    a.href = `/api/photos/${pid}`;
    a.target = '_blank';
    a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = `/api/photos/${pid}`;
    img.loading = 'lazy';
    img.alt = 'Run screenshot';
    img.className = 'photo-thumb';
    a.appendChild(img);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'photo-del';
    x.textContent = '×';
    x.title = 'Remove screenshot';
    x.addEventListener('click', async () => {
      if (!confirm('Remove this screenshot?')) return;
      try {
        await api(`/api/photos/${pid}`, { method: 'DELETE' });
        r.photoIds = r.photoIds.filter((p) => p !== pid);
        if (r.mapPhotoId === pid) r.mapPhotoId = null;
        renderTable();
      } catch (err) { alert(err.message); }
    });
    const mapBtn = document.createElement('button');
    mapBtn.type = 'button';
    mapBtn.className = 'photo-del photo-map-btn';
    mapBtn.textContent = '🗺️';
    mapBtn.title = 'Use as route map';
    mapBtn.addEventListener('click', () => setMap(pid));
    wrap.append(a, x, mapBtn);
    strip.appendChild(wrap);
  }
  td.appendChild(strip);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openEdit(r));
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete the ${fmtMiles(r.miles)} mi run on ${fmtTable(r.date)}?`)) return;
    try {
      await api(`/api/runs/${r.id}`, { method: 'DELETE' });
      state.runs = state.runs.filter((x) => x.id !== r.id);
      expandedRuns.delete(r.id);
      renderAll();
    } catch (err) { alert(err.message); }
  });
  const addPhoto = document.createElement('button');
  addPhoto.type = 'button';
  addPhoto.textContent = '📷 Add screenshots';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.hidden = true;
  addPhoto.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    addPhoto.disabled = true;
    addPhoto.textContent = 'Uploading…';
    try {
      for (const file of files) {
        const res = await fetch(`/api/runs/${r.id}/photos`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'image/jpeg' },
          body: file,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Upload failed');
        r.photoIds = [...(r.photoIds || []), body.photoId];
      }
    } catch (err) { alert(err.message); }
    renderTable();
  });
  // coaching read (re)run — only meaningful for runs
  if (r.type === 'run' || !r.type) {
    const coachBtn = document.createElement('button');
    coachBtn.type = 'button';
    coachBtn.textContent = r.coaching ? '🔄 Re-run coaching read' : '🏃 Coaching read';
    coachBtn.addEventListener('click', async () => {
      coachBtn.disabled = true;
      const orig = coachBtn.textContent;
      coachBtn.textContent = 'Analyzing… ~15s';
      try {
        const { coaching, detail } = await api(`/api/runs/${r.id}/analyze`, { method: 'POST' });
        r.coaching = coaching;
        if (detail) r.detail = detail; // backfilled — pace filter now has jog splits
        renderAll();
      } catch (err) {
        alert(err.message);
        coachBtn.textContent = orig;
        coachBtn.disabled = false;
      }
    });
    actions.append(coachBtn);
  }
  actions.append(edit, del, addPhoto, fileInput);
  td.appendChild(actions);

  tr.appendChild(td);
  return tr;
}

const GATE_LABEL = { peaksOk: 'HR peaks ≤ low 150s', noSurge: 'No back-half surge', zonesOk: 'Zone 4+ under 10%' };

function buildCoachingBlock(r) {
  const c = r.coaching;
  const box = document.createElement('div');
  box.className = 'coach-box';

  const head = document.createElement('div');
  head.className = 'coach-head';
  const title = document.createElement('span');
  title.className = 'coach-title';
  title.textContent = '🏃 Coaching read';
  head.appendChild(title);
  if (c.metrics && c.metrics.gate) {
    const gate = document.createElement('span');
    gate.className = 'coach-gate ' + (c.metrics.gate.pass ? 'pass' : 'hold');
    gate.textContent = c.metrics.gate.pass ? 'Advancement gate: PASS' : 'Advancement gate: HOLD';
    head.appendChild(gate);
  }
  box.appendChild(head);

  if (c.verdict) {
    const v = document.createElement('div');
    v.className = 'coach-verdict';
    v.textContent = c.verdict;
    box.appendChild(v);
  }

  for (const o of c.observations || []) {
    const p = document.createElement('div');
    p.className = 'coach-obs';
    p.textContent = o;
    box.appendChild(p);
  }

  if (c.advancement) {
    const a = document.createElement('div');
    a.className = 'coach-advance';
    a.textContent = c.advancement;
    box.appendChild(a);
  }

  // computed flag chips
  if ((c.flags || []).length) {
    const chips = document.createElement('div');
    chips.className = 'coach-chips';
    for (const f of c.flags) {
      const chip = document.createElement('span');
      chip.className = 'coach-chip ' + (f.level === 'flag' ? 'bad' : f.level === 'good' ? 'good' : 'info');
      chip.textContent = (f.level === 'flag' ? '⚠ ' : f.level === 'good' ? '✓ ' : 'ℹ ') + f.text;
      chips.appendChild(chip);
    }
    box.appendChild(chips);
  }

  // gate criteria detail
  if (c.metrics && c.metrics.gate) {
    const g = c.metrics.gate;
    const line = document.createElement('div');
    line.className = 'coach-gate-detail';
    const parts = [];
    for (const k of ['peaksOk', 'noSurge', 'zonesOk']) {
      if (g[k] === null || g[k] === undefined) continue;
      parts.push(`${g[k] ? '✓' : '✗'} ${GATE_LABEL[k]}`);
    }
    line.textContent = parts.join('  ·  ');
    if (parts.length) box.appendChild(line);
  }

  const foot = document.createElement('div');
  foot.className = 'coach-foot';
  foot.textContent = 'Execution read from your screenshots — not medical advice. Perceived effort runs ~15 bpm hot; the data is the governor.';
  box.appendChild(foot);
  return box;
}

// ---------- forms ----------

function readDuration(prefix) {
  const h = Number($(`#${prefix}H`).value || 0);
  const m = Number($(`#${prefix}M`).value || 0);
  const s = Number($(`#${prefix}S`).value || 0);
  return Math.round(h * 3600 + m * 60 + s);
}

function wireForms() {
  initMoodPicker($('#addMood'));
  initMoodPicker($('#editMood'));
  fillTypeSelect($('#addType'));
  fillTypeSelect($('#editType'));
  wireImport();
  wireBody();

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#loginPassword').value.trim() }) });
      location.reload();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  $('#addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#addMsg');
    msg.textContent = '';
    const type = $('#addType').value;
    const miles = Number($('#addMiles').value || 0);
    if (DISTANCE_TYPES.has(type) && miles <= 0) { msg.textContent = `Miles is required for a ${actInfo(type)[1].toLowerCase()}.`; return; }
    const seconds = readDuration('add');
    if (seconds <= 0) { msg.textContent = 'Duration must be more than zero.'; return; }
    try {
      const { run } = await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          date: $('#addDate').value,
          type,
          miles,
          seconds,
          notes: $('#addNotes').value.trim(),
          avgHr: $('#addAvgHr').value || null,
          maxHr: $('#addMaxHr').value || null,
          mood: getMood($('#addMood')),
        }),
      });
      state.runs.push({ ...run, photoIds: [] });
      state.runs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
      for (const id of ['addMiles', 'addH', 'addM', 'addS', 'addNotes', 'addAvgHr', 'addMaxHr']) $(`#${id}`).value = '';
      $('#addH').value = '0'; $('#addS').value = '0';
      setMoodPicker($('#addMood'), null);
      msg.textContent = 'Added ✓';
      setTimeout(() => { if (msg.textContent === 'Added ✓') msg.textContent = ''; }, 2500);
      renderAll();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  // edit dialog
  const editDialog = $('#editDialog');
  $('#editCancel').addEventListener('click', () => editDialog.close());
  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = Number(editDialog.dataset.runId);
    try {
      const { run } = await api(`/api/runs/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          date: $('#editDate').value,
          type: $('#editType').value,
          miles: Number($('#editMiles').value || 0),
          seconds: readDuration('edit'),
          notes: $('#editNotes').value.trim(),
          avgHr: $('#editAvgHr').value || null,
          maxHr: $('#editMaxHr').value || null,
          mood: getMood($('#editMood')),
        }),
      });
      const i = state.runs.findIndex((r) => r.id === id);
      if (i >= 0) state.runs[i] = { ...run, photoIds: state.runs[i].photoIds || [] };
      state.runs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
      editDialog.close();
      renderAll();
    } catch (err) { alert(err.message); }
  });

  // goals dialog
  const goalsDialog = $('#goalsDialog');
  $('#goalsCancel').addEventListener('click', () => goalsDialog.close());
  $('#editGoalsBtn').addEventListener('click', () => {
    const g = state.goals;
    $('#goalWeekly').value = g.weeklyMiles || '';
    $('#goalRaceName').value = g.raceName || '';
    $('#goalRaceDate').value = g.raceDate || '';
    $('#goalRaceMiles').value = g.raceMiles || '';
    goalsDialog.showModal();
  });
  $('#goalsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { goals } = await api('/api/goals', {
        method: 'PUT',
        body: JSON.stringify({
          weeklyMiles: Number($('#goalWeekly').value),
          raceName: $('#goalRaceName').value.trim(),
          raceDate: $('#goalRaceDate').value,
          raceMiles: Number($('#goalRaceMiles').value),
        }),
      });
      state.goals = goals;
      goalsDialog.close();
      renderAll();
    } catch (err) { alert(err.message); }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderWeeklyChart(); renderPaceChart(); renderRunTrends(); renderBodyCharts(); }, 150);
  });
}

// ---------- screenshot import ----------

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.readAsDataURL(blob);
  });
}

// Downscale big phone screenshots before upload — faster, cheaper, still legible
async function prepareImage(file) {
  const MAX_EDGE = 1800;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1_500_000) {
      return { mediaType: file.type || 'image/jpeg', data: await blobToBase64(file) };
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return { mediaType: 'image/jpeg', data: await blobToBase64(blob) };
  } catch {
    return { mediaType: file.type || 'image/jpeg', data: await blobToBase64(file) };
  }
}

function wireImport() {
  const btn = $('#importBtn');
  const input = $('#importFiles');
  const msg = $('#importMsg');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []).slice(0, 6);
    input.value = '';
    if (!files.length) return;
    btn.disabled = true;
    msg.textContent = `Reading ${files.length} screenshot${files.length === 1 ? '' : 's'}… this takes ~15 seconds`;
    try {
      const images = [];
      for (const f of files) {
        images.push(await prepareImage(f));
      }
      const { run } = await api('/api/import', {
        method: 'POST',
        body: JSON.stringify({ images, defaultDate: ymd(new Date()) }),
      });
      state.runs.push(run);
      state.runs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
      expandedRuns.add(run.id);
      renderAll();
      const what = `${actInfo(run.type)[1].toLowerCase()}${run.miles > 0 ? ` · ${fmtMiles(run.miles)} mi` : ''}`;
      msg.textContent = run.coaching
        ? `Imported: ${what} on ${fmtTable(run.date)} ✓ — coaching read is in the expanded row below.`
        : `Imported: ${what} on ${fmtTable(run.date)} ✓ — check the expanded row below and edit anything I misread.`;
    } catch (err) {
      msg.textContent = err.message;
    }
    btn.disabled = false;
  });
}

function openEdit(r) {
  const d = $('#editDialog');
  d.dataset.runId = String(r.id);
  $('#editType').value = r.type || 'run';
  $('#editDate').value = r.date;
  $('#editMiles').value = r.miles > 0 ? r.miles : '';
  $('#editH').value = String(Math.floor(r.seconds / 3600));
  $('#editM').value = String(Math.floor((r.seconds % 3600) / 60));
  $('#editS').value = String(r.seconds % 60);
  $('#editNotes').value = r.notes || '';
  $('#editAvgHr').value = r.avgHr || '';
  $('#editMaxHr').value = r.maxHr || '';
  setMoodPicker($('#editMood'), r.mood || null);
  d.showModal();
}

init();
