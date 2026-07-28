'use strict';

// ---------- state ----------

const state = { runs: [], goals: {}, range: '12W' };

const RANGES = [
  { key: '4W', label: '4 wk', weeks: 4 },
  { key: '12W', label: '12 wk', weeks: 12 },
  { key: '26W', label: '26 wk', weeks: 26 },
  { key: 'YTD', label: 'YTD' },
  { key: 'ALL', label: 'All' },
];

const $ = (sel) => document.querySelector(sel);

const MOODS = { 1: ['😖', 'Rough'], 2: ['😕', 'Meh'], 3: ['😐', 'OK'], 4: ['🙂', 'Good'], 5: ['🤩', 'Great'] };
const expandedRuns = new Set();

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

function showApp(authRequired) {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#logoutBtn').classList.toggle('hidden', !authRequired);
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
    const [runsRes, goalsRes] = await Promise.all([api('/api/runs'), api('/api/goals')]);
    state.runs = runsRes.runs;
    state.goals = goalsRes.goals || {};
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

function renderAll() {
  renderTiles();
  renderGoals();
  renderWeeklyChart();
  renderPaceChart();
  renderTable();
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
  const runs = filteredRuns();
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

  const total = sumMiles(runs);
  tiles.appendChild(tile(`Miles · ${rangeLabel}`, fmtMiles(total), 'mi', `${runs.length} run${runs.length === 1 ? '' : 's'}`));

  const totalSec = runs.reduce((a, r) => a + r.seconds, 0);
  tiles.appendChild(tile(`Avg pace · ${rangeLabel}`, total > 0 ? fmtPace(totalSec / total) : '—', total > 0 ? '/mi' : '', total > 0 ? fmtDur(totalSec) + ' total' : ''));

  const longest = runs.reduce((best, r) => (best === null || r.miles > best.miles ? r : best), null);
  tiles.appendChild(tile(
    `Longest · ${rangeLabel}`,
    longest ? fmtMiles(longest.miles) : '—', longest ? 'mi' : '',
    longest ? fmtTable(longest.date) : ''
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
  for (const [val, label] of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'tt-key';
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
  const wrap = $('#paceChart');
  wrap.textContent = '';
  const runs = filteredRuns().slice().reverse(); // ascending by date
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

  const pts = runs.map((r) => ({ run: r, t: parseYmd(r.date).getTime(), pace: r.seconds / r.miles }));
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

    const cells = [
      [fmtTable(r.date), ''],
      [fmtMiles(r.miles), 'num'],
      [fmtDur(r.seconds), 'num'],
      [fmtPace(r.seconds / r.miles), 'num'],
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
  td.colSpan = 7;

  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  const items = [
    ['Distance', `${fmtMiles(r.miles)} mi`],
    ['Time', fmtDur(r.seconds)],
    ['Pace', `${fmtPace(r.seconds / r.miles)} /mi`],
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

  // screenshots
  const strip = document.createElement('div');
  strip.className = 'photo-strip';
  for (const pid of r.photoIds || []) {
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
        renderTable();
      } catch (err) { alert(err.message); }
    });
    wrap.append(a, x);
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
  actions.append(edit, del, addPhoto, fileInput);
  td.appendChild(actions);

  tr.appendChild(td);
  return tr;
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
    const seconds = readDuration('add');
    if (seconds <= 0) { msg.textContent = 'Duration must be more than zero.'; return; }
    try {
      const { run } = await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          date: $('#addDate').value,
          miles: Number($('#addMiles').value),
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
      msg.textContent = 'Run added ✓';
      setTimeout(() => { if (msg.textContent === 'Run added ✓') msg.textContent = ''; }, 2500);
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
          miles: Number($('#editMiles').value),
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
    resizeTimer = setTimeout(() => { renderWeeklyChart(); renderPaceChart(); }, 150);
  });
}

function openEdit(r) {
  const d = $('#editDialog');
  d.dataset.runId = String(r.id);
  $('#editDate').value = r.date;
  $('#editMiles').value = r.miles;
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
