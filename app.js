/* Trail Book. A private, offline companion for a long walk.
   This file is code only. It holds no plan, no dates, no names and no log: those are fetched once from a
   private repository with a key the owner pastes in, and are then kept on the device for offline use. */
'use strict';
const VERSION = '0.1.4';
let TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';      // replaced by the plan's own time zone once a plan is loaded
const DEF = { start: 'the start', end: 'the finish', endName: 'The finish', tzName: 'local time', quiet: 'remote country', who: 'a hiker on the trail', floorNote: '', coldName: '', coldMile: null, coldAfter: '', coldWarn: '', dirNote: 'from the start' };
const L = k => (S.plan && S.plan.meta && S.plan.meta.labels && S.plan.meta.labels[k] != null) ? S.plan.meta.labels[k] : DEF[k];
const COMMITTER = { name: 'Trail Book', email: '102565410+nikkirouda@users.noreply.github.com' };
const REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 1) => (v == null || isNaN(v)) ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const int = v => num(v, 0);

/* ---------- dates (the walker lives on US Eastern time) ---------- */
const parseD = s => new Date(s + 'T12:00:00Z');
const isoD = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return isoD(d); };
const dayDiff = (a, b) => Math.round((parseD(a) - parseD(b)) / 864e5);        // a minus b, in days
const realToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const today = () => (S.settings.preview && DATE_RE.test(S.settings.preview)) ? S.settings.preview : realToday();
const fmtD = (s, o) => parseD(s).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }, o || {}));
const fmtDL = s => fmtD(s, { weekday: 'long', month: 'long', year: 'numeric' });
const fmtT = d => d ? d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '';

/* ---------- storage ---------- */
const db = (() => {
  let p; const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('trailbook', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  return {
    get: k => open().then(d => new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })),
    set: (k, v) => open().then(d => new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); })),
    clear: () => open().then(d => new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').clear(); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }))
  };
})();
const S = {
  settings: { mode: 'hiker', repo: '', token: '', preview: '', card: { name: '', contact: '', medical: '' } },
  plan: null, track: null, logs: {}, st: { todo: {}, gear: {}, oz: {}, floor: '', updated: 0 },
  meta: { shas: {}, dirty: [], stDirty: false, lastSync: 0, lastErr: '' }, gps: null, busy: false
};
function loadSettings() { try { const s = JSON.parse(localStorage.getItem('tb.settings') || '{}'); Object.assign(S.settings, s, { card: Object.assign({}, S.settings.card, s.card || {}) }); } catch (e) { /* first run */ } if (!REPO_RE.test(S.settings.repo)) S.settings.repo = ''; }
function saveSettings() { try { localStorage.setItem('tb.settings', JSON.stringify(S.settings)); } catch (e) { toast('This browser is not keeping settings.'); } }
const saveLogs = () => db.set('logs', S.logs);
const saveSt = () => db.set('st', S.st);
const saveMeta = () => db.set('meta', S.meta);
const isHome = () => S.settings.mode === 'home';
const roNote = () => isHome() ? `<div class="box amber"><b>This device is set as the home contact's, so it can look but not change anything.</b> If this is the walker's own phone, change "This device is" in <a href="#/settings">Settings</a>.</div>` : '';
function keyInfo(t) { if (!t) return 'No key in the box yet.'; const kind = t.startsWith('github_pat_') ? 'a fine-grained key' : /^gh[pousr]_/.test(t) ? 'a classic key (it will work, but a fine-grained one limited to the one repository is safer)' : 'NOT a GitHub key: those begin github_pat_'; return `In the box: ${t.length} characters, ${kind}${/\s/.test(t) ? ', with a space or line break inside it (paste it again)' : ''}.`; }
function keyProblem(status) { return status === 401 ? 'GitHub did not accept the key (401). It is mistyped, cut short, expired or deleted. Clear the box and paste it again; if that fails, make a new key.' : (status === 403 || status === 404) ? `The key is real but cannot see ${S.settings.repo} (${status}). Check the repository name above, and that the key's Repository access lists it.` : 'GitHub answered ' + status + '.'; }

/* ---------- track: the trail line with miles and elevations ---------- */
function decodeTrack(t) {
  const n = t.n, un = (a, k) => { const o = new Float64Array(n); let c = 0; for (let i = 0; i < n; i++) { c += a[i]; o[i] = c / k; } return o; };
  const T = { n, mi: un(t.mi, 100), lat: un(t.lat, 1e5), lon: un(t.lon, 1e5), el: un(t.el, 1) };
  const cup = new Float64Array(n); let ref = T.el[0], acc = 0;      // climbs counted once they pass 10 ft, as in the plan
  for (let i = 1; i < n; i++) { const d = T.el[i] - ref; if (d >= 10) { acc += d; ref = T.el[i]; } else if (d <= -10) ref = T.el[i]; cup[i] = acc; }
  T.cup = cup; return T;
}
function idxAt(m) { const a = S.track.mi; let lo = 0, hi = a.length - 1; if (m <= a[0]) return 0; if (m >= a[hi]) return hi; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid] <= m) lo = mid; else hi = mid; } return lo; }
function interp(arr, m) { const T = S.track, i = idxAt(m), j = Math.min(i + 1, T.n - 1), w = T.mi[j] > T.mi[i] ? (m - T.mi[i]) / (T.mi[j] - T.mi[i]) : 0; return arr[i] + (arr[j] - arr[i]) * Math.max(0, Math.min(1, w)); }
const climb = (a, b) => S.track ? Math.max(0, interp(S.track.cup, b) - interp(S.track.cup, a)) : 0;
const hrsAt = (a, b, mph) => (b - a) / mph + climb(a, b) / 2000;
function nearest(lat, lon) {
  const T = S.track, k = Math.cos(lat * Math.PI / 180); let best = 1e18, bi = 0;
  for (let i = 0; i < T.n; i++) { const dx = (T.lon[i] - lon) * k, dy = T.lat[i] - lat, d = dx * dx + dy * dy; if (d < best) { best = d; bi = i; } }
  let mile = T.mi[bi], d2 = best;
  [[bi - 1, bi], [bi, bi + 1]].forEach(([i, j]) => { if (i < 0 || j >= T.n) return; const ax = (T.lon[i] - lon) * k, ay = T.lat[i] - lat, bx = (T.lon[j] - lon) * k, by = T.lat[j] - lat, vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy; if (!L) return; const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L)), px = ax + vx * t, py = ay + vy * t, d = px * px + py * py; if (d < d2) { d2 = d; mile = T.mi[i] + (T.mi[j] - T.mi[i]) * t; } });
  return { mile, offFt: Math.sqrt(d2) * 69.0 * 5280, el: interp(T.el, mile) };
}
function sunTimes(dateStr, lat, lon) {
  const rad = Math.PI / 180, d = parseD(dateStr), N = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5), lh = lon / 15;
  const calc = rising => {
    const t = N + ((rising ? 6 : 18) - lh) / 24, M = 0.9856 * t - 3.289;
    let L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634) % 360; if (L < 0) L += 360;
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad; RA = ((RA % 360) + 360) % 360; RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec)), cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null;
    const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15; let UT = (H + RA - 0.06571 * t - 6.622 - lh) % 24; if (UT < 0) UT += 24; return UT;
  };
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), r = calc(true); let s = calc(false);
  if (r == null || s == null) return {}; if (s < r) s += 24;
  return { rise: new Date(base + r * 36e5), set: new Date(base + s * 36e5) };
}

/* ---------- plan lookups ---------- */
const P = () => S.plan;
const total = () => P().meta.miles;
const planArr = () => P().days.map(d => [d.date, d.b]);
function mileOn(arr, date) { if (date < arr[0][0]) return 0; let m = arr[0][1]; for (const [d, c] of arr) { if (d <= date) m = c; else break; } return m; }
function dateAtMile(arr, m) { for (const [d, c] of arr) if (c >= m - 0.05) return d; return arr[arr.length - 1][0]; }
const dayByDate = date => P().days.find(d => d.date === date);
const dayByMile = m => P().days.find(d => d.mi > 0 && m >= d.a - 0.05 && m < d.b) || P().days[P().days.length - 1];
function entries() { return Object.values(S.logs).filter(e => e && DATE_RE.test(e.date) && !e.deleted).sort((a, b) => a.date < b.date ? -1 : 1); }
function myLast() { const e = entries().filter(x => typeof x.b === 'number'); return e[e.length - 1] || null; }
const myMile = () => { const l = myLast(); return l ? l.b : null; };
function sitesAhead(m, n, kinds) {
  const out = []; const want = kinds || 'sctrh';
  P().points.forEach(p => { if (p.m > m + 0.05 && want.includes(p.k)) out.push(p); });
  if (want.includes('t')) P().towns.forEach(t => { if (t.m > m + 0.05) out.push({ k: 't', n: t.name, m: t.m, st: t.state, off: 0, note: t.note, zero: t.zero }); });
  return out.sort((a, b) => a.m - b.m).slice(0, n);
}
const KIND = { s: 'Shelter', c: 'Campsite', r: 'Road', t: 'Town', h: 'Hut: paid lodging, booking needed' };
const nextTown = m => P().towns.filter(t => t.kind === 'town').find(t => t.m > m + 0.05);

/* ---------- GitHub: the private data repository ---------- */
const hdr = accept => ({ Authorization: 'Bearer ' + S.settings.token, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
function apiUrl(path) { if (!REPO_RE.test(S.settings.repo) || !/^[\w./-]*$/.test(path) || path.includes('..')) throw new Error('bad address'); return `https://api.github.com/repos/${S.settings.repo}/contents/${path}`; }
const b64enc = s => { const b = new TextEncoder().encode(s); let o = ''; for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(o); };
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
async function ghList(dir) { const r = await fetch(apiUrl(dir), { headers: hdr() }); if (r.status === 404) return []; if (!r.ok) throw new Error(`list ${dir}: ${r.status}`); const j = await r.json(); return Array.isArray(j) ? j.map(x => ({ name: String(x.name), sha: String(x.sha) })) : []; }
async function ghRaw(path) { const r = await fetch(apiUrl(path), { headers: hdr('application/vnd.github.raw+json') }); if (!r.ok) throw new Error(`get ${path}: ${r.status}`); return r.json(); }
async function ghGet(path) { const r = await fetch(apiUrl(path), { headers: hdr() }); if (r.status === 404) return null; if (!r.ok) throw new Error(`get ${path}: ${r.status}`); const j = await r.json(); return { sha: j.sha, data: JSON.parse(b64dec(j.content)) }; }
async function ghPut(path, obj, sha, message) { const body = { message, content: b64enc(JSON.stringify(obj, null, 1)), committer: COMMITTER }; if (sha) body.sha = sha; const r = await fetch(apiUrl(path), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr()), body: JSON.stringify(body) }); if (!r.ok) throw new Error(`save ${path}: ${r.status}`); return (await r.json()).content.sha; }

function cleanPlan(j) {
  if (!j || !Array.isArray(j.days) || !j.meta) return null; const n = v => +v || 0;
  j.meta.miles = n(j.meta.miles); j.meta.mph = n(j.meta.mph) || 2; ['built', 'start', 'finish', 'control_finish', 'status', 'tz'].forEach(k => { j.meta[k] = str(String(j.meta[k] == null ? '' : j.meta[k]), 60); });
  if (!DATE_RE.test(j.meta.start) || !(j.meta.miles > 0)) return null;
  j.days = j.days.filter(d => d && DATE_RE.test(d.date)); j.days.forEach(d => { ['day', 'mi', 'walk', 'a', 'b', 'up', 'down', 'hrs', 'book', 'high', 'light', 'off', 'lat', 'lon'].forEach(k => { d[k] = n(d[k]); }); d.roads = Array.isArray(d.roads) ? d.roads.map(String) : []; d.notes = Array.isArray(d.notes) ? d.notes.filter(x => x && typeof x.text === 'string').map(x => ({ flag: str(String(x.flag || ''), 12), text: x.text })) : []; ['frm', 'to', 'state', 'kind', 'note', 'food'].forEach(k => { d[k] = String(d[k] == null ? '' : d[k]); }); });
  if (!j.days.length) return null;
  j.control = (Array.isArray(j.control) ? j.control : []).filter(c => Array.isArray(c) && DATE_RE.test(c[0])).map(c => [c[0], n(c[1])]); if (!j.control.length) j.control = j.days.map(d => [d.date, d.b]);
  j.points = (Array.isArray(j.points) ? j.points : []).filter(p => p && 'sctrh'.includes(p.k) && p.k.length === 1).map(p => ({ k: p.k, n: String(p.n || ''), st: String(p.st || ''), m: n(p.m), off: n(p.off), lat: n(p.lat), lon: n(p.lon), food: String(p.food || '') }));
  j.towns = (Array.isArray(j.towns) ? j.towns : []).map(t => ({ name: String(t.name || ''), m: n(t.m), state: String(t.state || ''), kind: t.kind === 'option' ? 'option' : 'town', zero: n(t.zero), note: String(t.note || '') }));
  j.resupply = (Array.isArray(j.resupply) ? j.resupply : []).map(r => { const o = { m: numOr(r.m) }; ['state', 'place', 'access', 'off', 'how', 'grocery', 'outfitter', 'mail', 'lodging', 'other', 'season', 'conf', 'src', 'mile_src'].forEach(k => { o[k] = String(r[k] == null ? '' : r[k]); }); return o; });
  j.calendar = (Array.isArray(j.calendar) ? j.calendar : []).filter(c => c && /^[\w-]{1,60}$/.test(c.id)).map(c => ({ id: c.id, label: String(c.label || ''), text: String(c.text || ''), key: !!c.key, trail: !!c.trail }));
  const dp = j.decision || {}; j.decision = { note: String(dp.note || ''), points: (Array.isArray(dp.points) ? dp.points : []).filter(p => p && DATE_RE.test(p.plan) && DATE_RE.test(p.control)).map(p => ({ name: String(p.name || ''), m: n(p.m), plan: p.plan, control: p.control, text: String(p.text || '') })) };
  j.docs = (Array.isArray(j.docs) ? j.docs : []).filter(d => d && typeof d.md === 'string').map(d => ({ title: String(d.title || ''), md: d.md }));
  j.content = (j.content && typeof j.content === 'object') ? j.content : {};
  return j;
}
function usePlan(j) { S.plan = j; if (j.meta.tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: j.meta.tz }); TZ = j.meta.tz; } catch (e) { /* keep device zone */ } } }
/* everything that arrives from outside is reduced to the fields and types the app expects */
const str = (v, n) => typeof v === 'string' ? v.slice(0, n || 400) : '';
const numOr = v => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null);
function cleanEntry(e) {
  if (!e || !DATE_RE.test(e.date)) return null;
  return { date: e.date, rest: !!e.rest, a: numOr(e.a), b: numOr(e.b), place: str(e.place, 120), start: /^\d{2}:\d{2}$/.test(e.start) ? e.start : '', end: /^\d{2}:\d{2}$/.test(e.end) ? e.end : '',
    breaks: numOr(e.breaks), hours: numOr(e.hours), wx: Array.isArray(e.wx) ? e.wx.filter(x => WX.includes(x)) : [], feet: numOr(e.feet), energy: numOr(e.energy), sleepH: numOr(e.sleepH), sleepQ: numOr(e.sleepQ),
    food: numOr(e.food), weight: numOr(e.weight), notes: str(e.notes, 4000), lat: numOr(e.lat), lon: numOr(e.lon), t: numOr(e.t) || 0, deleted: !!e.deleted };
}
function cleanSt(s) { const pick = o => { const r = {}; if (o && typeof o === 'object') Object.keys(o).slice(0, 600).forEach(k => { if (/^[\w-]{1,60}$/.test(k)) r[k] = typeof o[k] === 'number' ? o[k] : !!o[k]; }); return r; }; s = s || {}; return { todo: pick(s.todo), gear: pick(s.gear), oz: pick(s.oz), floor: str(String(s.floor == null ? '' : s.floor), 8), updated: numOr(s.updated) || 0 }; }
function mergeEntries(remote) { let changed = false; Object.values(remote || {}).forEach(r => { const e = cleanEntry(r); if (!e) return; const mine = S.logs[e.date]; if (!mine || (e.t || 0) > (mine.t || 0)) { S.logs[e.date] = e; changed = true; } }); return changed; }
const monthOf = d => d.slice(0, 7);

async function sync(manual) {
  if (S.busy) { S.again = true; return; } if (!S.settings.token || !S.settings.repo) { if (manual) toast('Enter the repository and paste the key in Settings first.'); return; }
  if (!navigator.onLine) { if (manual) toast('No signal. Everything is saved on the phone.'); return; }
  S.busy = true; setNet('Syncing…');
  try {
    const files = await ghList('plan'); let got = false;
    if (!files.some(f => f.name === 'plan.json')) throw new Error(`No plan found in ${S.settings.repo}. Check the repository name, and that the key's Repository access lists it.`);
    for (const f of files) {
      if (!['plan.json', 'track.json'].includes(f.name) || S.meta.shas[f.name] === f.sha) continue;
      let j = await ghRaw('plan/' + f.name); const key = f.name.replace('.json', '');
      if (key === 'plan') { j = cleanPlan(j); if (!j) throw new Error('plan file not understood'); }
      if (key === 'track' && !(j && j.n > 1 && ['mi', 'lat', 'lon', 'el'].every(k => Array.isArray(j[k]) && j[k].length === j.n))) throw new Error('track file not understood');
      if (S.plan && S[key === 'plan' ? 'plan' : 'track']) {      // a plan is already in use: hold the new one until the owner accepts it
        S.pending = S.pending || { shas: {} }; S.pending[key] = j; S.pending.shas[f.name] = f.sha; S.pending.built = key === 'plan' ? j.meta.built : (S.pending.built || ''); await db.set('pending', S.pending); continue;
      }
      await db.set(key, j); S.meta.shas[f.name] = f.sha; got = true;
      if (key === 'plan') usePlan(j); else S.track = decodeTrack(j);
    }
    const logFiles = await ghList('log'); const bySha = {}; logFiles.forEach(f => { bySha[f.name] = f.sha; });
    const months = new Set(S.meta.dirty);
    logFiles.forEach(f => { if (/^\d{4}-\d{2}\.json$/.test(f.name) && S.meta.shas['log/' + f.name] !== f.sha) months.add(f.name.slice(0, 7)); });
    for (const m of months) {
      const file = `log/${m}.json`, remote = bySha[m + '.json'] ? await ghGet(file) : null;
      if (remote) mergeEntries(remote.data && remote.data.entries);
      if (!isHome() && S.meta.dirty.includes(m)) {
        const t0 = Date.now(), mine = {}; Object.values(S.logs).forEach(e => { if (monthOf(e.date) === m) mine[e.date] = e; });
        S.meta.shas['log/' + m + '.json'] = await ghPut(file, { entries: mine, updated: Date.now() }, remote && remote.sha, `log ${m}`);
        if ((DIRTY_T[m] || 0) <= t0) S.meta.dirty = S.meta.dirty.filter(x => x !== m);      // keep the flag if something was saved meanwhile
      } else if (remote) S.meta.shas['log/' + m + '.json'] = remote.sha;
    }
    await saveLogs();
    if (bySha['state.json'] !== S.meta.shas['log/state.json'] || S.meta.stDirty) {
      const remote = bySha['state.json'] ? await ghGet('log/state.json') : null; const rs = remote ? cleanSt(remote.data) : null;
      if (rs && rs.updated > S.st.updated) { S.st = rs; S.meta.stDirty = false; await saveSt(); if (remote) S.meta.shas['log/state.json'] = remote.sha; }
      else if (!isHome() && S.meta.stDirty) { const u0 = S.st.updated; S.meta.shas['log/state.json'] = await ghPut('log/state.json', S.st, remote && remote.sha, 'checklists'); if (S.st.updated === u0) S.meta.stDirty = false; }
      else if (remote) S.meta.shas['log/state.json'] = remote.sha;
    }
    S.meta.lastSync = Date.now(); S.meta.lastErr = ''; await saveMeta();
    if (manual) toast(got ? 'Synced. The plan was updated.' : 'Synced.');
    render();
  } catch (e) { const m = /: (401|403|404)$/.exec(String(e.message || '')); S.meta.lastErr = m ? keyProblem(+m[1]) : String(e.message || e).slice(0, 200); await saveMeta(); if (manual) toast('Sync did not finish: ' + S.meta.lastErr); }
  S.busy = false; setNet();
  if (S.again) { S.again = false; if (S.meta.dirty.length || S.meta.stDirty) sync(false); }
}
function setNet(msg) {
  const el = $('#net'); if (!el) return;
  if (msg) { el.textContent = msg; return; }
  const pending = S.meta.dirty.length || S.meta.stDirty;
  el.textContent = !navigator.onLine ? (pending ? 'Offline · saved on phone' : 'Offline') : S.meta.lastErr ? 'Sync issue' : pending ? 'Not yet synced' : '';
}
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3800); }

/* ---------- small renderers ---------- */
const RED = ['FORD', 'ALPINE', 'COLD'], FLAG = new Proxy({}, { get: (_, f) => RED.includes(f) ? 'red' : f === 'FEE' ? '' : 'amber' });
const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${esc(l)}</span></div>`;
function profile(a, b, meMile) {
  if (!S.track || !(b > a)) return '';
  const T = S.track, W = 320, H = 96, n = 120, pts = []; let lo = 1e9, hi = -1e9;
  for (let i = 0; i <= n; i++) { const m = a + (b - a) * i / n, e = interp(T.el, m); pts.push([m, e]); lo = Math.min(lo, e); hi = Math.max(hi, e); }
  const pad = Math.max(100, (hi - lo) * 0.1); lo -= pad; hi += pad;
  const x = m => 4 + (m - a) / (b - a) * (W - 8), y = e => H - 14 - (e - lo) / (hi - lo) * (H - 26);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
  const me = (meMile != null && meMile >= a && meMile <= b) ? `<circle class="me" cx="${x(meMile).toFixed(1)}" cy="${y(interp(T.el, meMile)).toFixed(1)}" r="4.5"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation profile, ${int(Math.min(...pts.map(p => p[1])))} to ${int(Math.max(...pts.map(p => p[1])))} feet"><path class="area" d="${line} L${x(b).toFixed(1)} ${H - 14} L${x(a).toFixed(1)} ${H - 14}Z"/><path class="line" d="${line}"/><line class="axis" x1="4" y1="${H - 14}" x2="${W - 4}" y2="${H - 14}"/>${me}<text x="4" y="${H - 3}">mile ${num(a)}</text><text x="${W - 4}" y="${H - 3}" text-anchor="end">${num(b)}</text><text x="4" y="10">high ${int(Math.max(...pts.map(p => p[1])))} ft</text><text x="${W - 4}" y="10" text-anchor="end">low ${int(Math.min(...pts.map(p => p[1])))} ft</text></svg>`;
}
function noteHtml(n) { const c = FLAG[n.flag] || ''; return `<div class="note ${c}"><span class="flag ${c}">${esc(n.flag)}</span>${esc(n.text)}</div>`; }
function dayCard(d, opts) {
  opts = opts || {}; const s = sunTimes(d.date, d.lat, d.lon), rest = d.kind === 'rest day';
  const place = esc(d.to) + (d.off > 500 ? ` <span class="muted small">(${int(d.off)} ft off trail)</span>` : '');
  let h = `<div class="card"><p class="kicker">Day ${d.day} · ${esc(fmtD(d.date))}${opts.tag ? ' · ' + esc(opts.tag) : ''}</p><p class="big">${rest ? 'Rest day in ' + esc(d.to) : place}</p>`;
  if (!rest) h += `<p class="muted small">from ${esc(d.frm)}${d.state ? ' · ' + esc(d.state) : ''}${d.food ? ' · food storage: ' + esc(d.food) : ''}</p>
    <div class="stats">${stat(num(d.mi), 'miles')}${stat(int(d.up), 'ft climb')}${stat(num(d.hrs), `hrs at ${P().meta.mph} mph`)}${stat(num(d.book), 'hrs book pace')}${stat(num(d.light), 'hrs daylight')}${stat(num(d.b), 'mile tonight')}</div>`;
  if (s.rise) h += `<p class="small muted">Sunrise ${esc(fmtT(s.rise))} · sunset ${esc(fmtT(s.set))} (${esc(L('tzName'))})${d.day === 1 ? ' · ' + num(d.walk) + ' miles walked today' : ''}</p>`;
  if (!rest && d.book > d.light - 1.5) h += `<div class="box amber">At book pace this day fills the daylight. Start at first light, headlamp to hand.</div>`;
  if (!rest) h += profile(d.a, d.b, opts.me);
  if (d.note) h += `<div class="note"><span class="flag">${d.kind === 'town' || rest ? 'TOWN' : 'NOTE'}</span>${esc(d.note)}</div>`;
  h += d.notes.map(noteHtml).join('');
  if (d.roads.length) h += `<p class="small"><b>Roads crossed (ways out):</b> ${d.roads.map(esc).join(' · ')}</p>`;
  return h + '</div>';
}
function mdToHtml(md) {
  const inl = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const L = String(md).split('\n'), out = []; let i = 0, para = [];
  const flush = () => { if (para.length) { out.push('<p>' + inl(para.join(' ')) + '</p>'); para = []; } };
  while (i < L.length) {
    const l = L[i];
    if (/^```/.test(l)) { flush(); const b = []; i++; while (i < L.length && !/^```/.test(L[i])) b.push(L[i++]); i++; out.push('<pre>' + esc(b.join('\n')) + '</pre>'); continue; }
    if (/^\s*\|/.test(l)) { flush(); const rows = []; while (i < L.length && /^\s*\|/.test(L[i])) rows.push(L[i++]); const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const hasHead = rows[1] && /^\s*\|[\s:|-]+\|?\s*$/.test(rows[1]); let t = '<div class="scroll"><table>';
      rows.forEach((r, k) => { if (hasHead && k === 1) return; const tag = hasHead && k === 0 ? 'th' : 'td'; t += '<tr>' + cells(r).map(c => `<${tag}>${inl(c)}</${tag}>`).join('') + '</tr>'; }); out.push(t + '</table></div>'); continue; }
    const hm = /^(#{1,4})\s+(.*)$/.exec(l); if (hm) { flush(); const lv = Math.min(4, hm[1].length); out.push(`<h${lv}>${inl(hm[2])}</h${lv}>`); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) { flush(); const ord = /^\s*\d+\./.test(l), items = []; while (i < L.length && (/^\s*([-*]|\d+\.)\s+/.test(L[i]) || (/^\s{2,}\S/.test(L[i]) && items.length))) { if (/^\s*([-*]|\d+\.)\s+/.test(L[i])) items.push(L[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); else items[items.length - 1] += ' ' + L[i].trim(); i++; }
      out.push(`<${ord ? 'ol' : 'ul'}>` + items.map(x => '<li>' + inl(x.replace(/^\[ \]\s*/, '☐ ').replace(/^\[x\]\s*/i, '☑ ')) + '</li>').join('') + `</${ord ? 'ol' : 'ul'}>`); continue; }
    if (/^\s*---+\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush(); return out.join('\n');
}

/* ---------- pace ---------- */
function pace() {
  const es = entries(), walk = es.filter(e => !e.rest && typeof e.a === 'number' && typeof e.b === 'number' && e.b > e.a);
  const last = myLast(); if (!last) return null;
  const r = { last, mile: last.b, walkDays: walk.length, restDays: es.filter(e => e.rest).length };
  const tot = walk.reduce((s, e) => s + (e.b - e.a), 0); r.avg = walk.length ? tot / walk.length : null;
  const timed = walk.filter(e => e.hours > 0).slice(-10).map(e => { const c = climb(e.a, e.b) / 2000, flat = e.hours - c; return flat > 0.5 ? (e.b - e.a) / flat : null; }).filter(Boolean).sort((a, b) => a - b);
  r.mph = timed.length ? timed[Math.floor(timed.length / 2)] : null; r.mphN = timed.length;
  const pa = planArr(), ca = P().control;
  r.vsPlan = dayDiff(dateAtMile(pa, last.b), last.date); r.vsControl = dayDiff(dateAtMile(ca, last.b), last.date);
  const from = addDays(last.date, -14), first = es.find(e => e.date >= from && typeof e.b === 'number');
  if (first && first.date < last.date) { const m0 = typeof first.a === 'number' ? first.a : first.b, span = dayDiff(last.date, first.date) + (typeof first.a === 'number' ? 1 : 0); r.rate = span >= 3 ? (last.b - m0) / span : null; r.span = span; }
  const proj = m => (r.rate > 0 && r.span >= 7 && last.b < m) ? addDays(last.date, Math.ceil((m - last.b) / r.rate)) : null;
  r.cold = L('coldMile') ? proj(L('coldMile')) : null; r.finish = proj(total());
  return r;
}
const aheadTxt = n => n === 0 ? 'level with' : `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ${n > 0 ? 'ahead of' : 'behind'}`;
function paceChart() {
  const pa = planArr(), ca = P().control, d0 = pa[0][0], d1 = ca[ca.length - 1][0], span = dayDiff(d1, d0), W = 320, H = 150;
  const x = d => 6 + dayDiff(d, d0) / span * (W - 12), y = m => H - 16 - m / total() * (H - 26);
  const path = arr => arr.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
  const mine = entries().filter(e => typeof e.b === 'number').map(e => [e.date, e.b]);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Miles against date: the plan, the book-pace control and your log"><line class="axis" x1="6" y1="${H - 16}" x2="${W - 6}" y2="${H - 16}"/><path class="p-control" d="${path(ca)}"/><path class="p-plan" d="${path(pa)}"/>${mine.length > 1 ? `<path class="p-you" d="${path(mine)}"/>` : mine.length ? `<circle class="me" cx="${x(mine[0][0]).toFixed(1)}" cy="${y(mine[0][1]).toFixed(1)}" r="4"/>` : ''}<text x="6" y="${H - 4}">${esc(fmtD(d0, { weekday: undefined }))}</text><text x="${W - 6}" y="${H - 4}" text-anchor="end">${esc(fmtD(d1, { weekday: undefined }))}</text><text x="6" y="10">${esc(L('endName'))}, ${int(total())} mi</text></svg>
  <div class="legend"><span><i></i>Plan</span><span><i class="c"></i>Book-pace control</span><span><i class="y"></i>Your log</span></div>`;
}
function paceCard(full) {
  const r = pace(); if (!r) return `<div class="card"><h2>Pace</h2><p class="muted">No log entries yet. Once you log a day's miles and walking hours, this compares you with the plan and with the book-pace control.</p>${full ? paceChart() : ''}</div>`;
  const dp = P().decision.points.map(p => { const reached = entries().find(e => typeof e.b === 'number' && e.b >= p.m - 0.05); const late = reached ? reached.date > p.control : (r.last.date > p.control && r.mile < p.m); return late ? `<div class="box red"><b>Decision point: ${esc(p.name)}.</b> ${esc(p.text)}</div>` : ''; }).join('');
  let h = `<div class="card"><h2>Pace</h2><p>At mile <b class="num">${num(r.mile)}</b> on ${esc(fmtD(r.last.date))} you are <b>${esc(aheadTxt(r.vsPlan))}</b> the plan and <b>${esc(aheadTxt(r.vsControl))}</b> the book-pace control.</p>
  <div class="stats">${stat(r.avg ? num(r.avg) : '–', 'mi per walking day')}${stat(r.rate ? num(r.rate) : '–', 'mi per day, last 2 wks')}${stat(r.mph ? num(r.mph) : '–', 'mph on the flat')}</div>`;
  if (r.mph) h += `<p class="small muted">Flat speed is worked back from your last ${r.mphN} timed day${r.mphN === 1 ? '' : 's'}: miles ÷ (walking hours − 30 min per 1,000 ft climbed). The plan assumes ${P().meta.mph}; book pace is 2.</p>`;
  if (r.rate && r.span < 7) h += `<p class="small muted">Projected dates appear once a week of entries is in.</p>`;
  if (r.cold || r.finish) h += `<p>At your last two weeks' rate: ${r.cold ? `${esc(L('coldName'))} about <b>${esc(fmtD(r.cold))}</b>; ` : ''}${r.finish ? `${esc(L('end'))} about <b>${esc(fmtD(r.finish))}</b>.` : ''}</p>`;
  if (r.cold && L('coldAfter') && r.cold > L('coldAfter')) h += `<div class="box amber">${esc(L('coldWarn'))}</div>`;
  return h + dp + (full ? paceChart() : '<a class="btn ghost block" href="#/log/pace">Pace in full</a>') + '</div>';
}

/* ---------- views ---------- */
const V = {};
function needPlan() {
  return `<h1>Trail Book</h1><div class="card"><p>This is the empty shell. The plan lives in a private place and has not been fetched to this ${isHome() ? 'device' : 'phone'} yet.</p>
  <ol><li>Open <b>Settings</b> and paste the key.</li><li>Tap <b>Sync now</b> once, with signal.</li><li>After that everything works with no signal at all.</li></ol><a class="btn block" href="#/settings">Open Settings</a></div>`;
}
function whereCard(d) {
  const g = S.gps; let h = `<div class="card"><h2>Where am I</h2>`;
  if (!S.track) return h + '<p class="muted">The trail line is not on this phone yet.</p></div>';
  if (g && g.err) h += `<div class="box amber">${esc(g.err)}</div>`;
  if (g && g.mile != null) {
    const off = g.offFt > 1500;
    h += `<p class="big num">Mile ${num(g.mile)}</p><p class="muted small">${int(g.el)} ft on the trail profile · fix within ${int(g.acc * 3.28)} ft · ${esc(fmtT(new Date(g.t)))}</p>`;
    if (off) h += `<div class="box ${g.offFt > 26400 ? 'amber' : 'red'}"><b>You appear to be ${g.offFt > 5280 ? num(g.offFt / 5280, g.offFt > 52800 ? 0 : 1) + ' miles' : int(g.offFt) + ' ft'} from the trail.</b> The mile shown is the nearest point on it.${g.offFt > 26400 ? '' : ' Check the paper map.'}</div>`;
    if (d && d.mi > 0 && g.mile < d.b) h += `<p>To tonight's stop (${esc(d.to)}): <b class="num">${num(d.b - g.mile)} mi</b>, ${int(climb(g.mile, d.b))} ft of climb, about ${num(hrsAt(g.mile, d.b, P().meta.mph))} h at plan pace, ${num(hrsAt(g.mile, d.b, 2))} h at book pace.</p>`;
    h += '<ul class="list">' + sitesAhead(g.mile, 6).map(p => `<li><span class="item"><span class="d">${num(p.m - g.mile)} mi</span><span class="t">${esc(p.n)}<span class="sub">${KIND[p.k]}${p.off > 500 ? ' · ' + int(p.off) + ' ft off trail' : ''}${p.food ? ' · ' + esc(p.food) : ''}</span></span><span class="r">${num(p.m)}</span></span></li>`).join('') + '</ul>';
  } else if (!g || !g.err) h += '<p class="muted">Uses the phone\'s GPS. It works with no signal. It is an aid only: carry the paper map.</p>';
  return h + `<div class="btns"><button class="btn" data-act="gps">${g && g.wait ? 'Finding you…' : 'Find me on the trail'}</button>${g && g.mile != null ? `<a class="btn ghost" href="geo:${g.lat.toFixed(5)},${g.lon.toFixed(5)}">Open in maps</a>` : ''}</div></div>`;
}
V.today = () => {
  if (!P()) return needPlan();
  if (isHome()) return V.home();
  const t = today(), start = P().meta.start, last = P().days[P().days.length - 1].date, mm = myMile(); let h = '';
  if (S.pending) h += `<div class="box amber"><b>A changed plan has arrived</b>${S.pending.built ? ' (built ' + esc(S.pending.built) + '; yours was built ' + esc(P().meta.built) + ')' : ''}. If you were not expecting one, keep yours and ask home.<div class="btns"><button class="btn" data-act="acceptplan">Use the new plan</button><button class="btn ghost" data-act="keepplan">Keep mine</button></div></div>`;
  if (S.settings.preview) h += `<div class="box amber">Preview: showing the app as on ${esc(fmtDL(t))}. <button class="btn ghost" data-act="nopreview">Back to today</button></div>`;
  if (t < start) {
    const n = dayDiff(start, t), todo = P().calendar.filter(c => !S.st.todo[c.id]).slice(0, 3);
    h += `<h1>${n} days to ${esc(L('start'))}</h1><p class="muted">${esc(fmtDL(t))} · the plan is a ${esc(P().meta.status)}</p>
    <div class="card"><h2>Next to do</h2>${todo.map(todoRow).join('') || '<p class="muted">Everything is ticked.</p>'}<a class="btn ghost block" href="#/plan/todo">All dates and bookings</a></div>` + whereCard(null) + dayCard(P().days[0], { tag: 'the first day' }) + `<div class="btns"><a class="btn ghost block" href="#/log/edit/${esc(t)}">Log a practice day</a></div>`;
  } else {
    const d = dayByDate(t) || P().days[P().days.length - 1];
    h += `<h1>${t > last ? 'After the plan\'s last day' : 'Today'}</h1><p class="muted">${esc(fmtDL(t))}</p>`;
    if (mm != null && Math.abs(mm - mileOn(planArr(), t)) > 12) { const dm = dayByMile(mm); h += `<div class="box amber">Your log puts you at mile ${num(mm)}, which is plan day ${dm.day}. Today's date is plan day ${d.day}. <a href="#/day/${dm.day}">Show day ${dm.day}</a></div>`; }
    h += dayCard(d, { me: S.gps && S.gps.mile }) + whereCard(d);
    const base = mm != null ? mm : d.a, nt = nextTown(base);
    if (nt) { const lastE = myLast(), r = pace(), rate = r && r.rate ? r.rate : 16, days = (nt.m - base) / rate;
      h += `<div class="card"><h2>Next town</h2><p class="big">${esc(nt.name)}</p><p><b class="num">${num(nt.m - base)} mi</b> ahead, about ${num(days)} days at ${r && r.rate ? 'your recent rate' : '16 miles a day'}${nt.zero ? ' · rest day planned' : ''}.</p>
      ${lastE && lastE.food != null ? `<div class="box ${lastE.food + 0.5 < days ? 'red' : 'green'}">Food in the pack at your last entry: <b>${num(lastE.food)} days</b>. ${lastE.food + 0.5 < days ? 'That is short of the distance. See the stops list for stores on the way.' : 'That covers it.'}</div>` : ''}<p class="small muted">${esc(nt.note)}</p><a class="btn ghost block" href="#/stops">Stops and food</a></div>`; }
    h += `<div class="btns"><a class="btn block" href="#/log/edit/${esc(realToday() === t ? t : t)}">Log this day</a></div>` + paceCard(false);
  }
  return h;
};
V.home = () => {
  const t = today(), last = myLast(), d = dayByDate(t), r = pace();
  let h = `<h1>Home view</h1><p class="muted">${esc(fmtDL(t))} · this device reads only. <a href="#/settings">Change in Settings</a> if it is the walker's own phone.</p><div class="card"><h2>Last word from the phone</h2>`;
  if (last) h += `<p class="big">${esc(last.place || 'Mile ' + num(last.b))}</p><p>Mile <b class="num">${num(last.b)}</b> on ${esc(fmtDL(last.date))}${last.rest ? ' (rest day)' : ''}.</p>${last.notes ? `<div class="note">${esc(last.notes)}</div>` : ''}<p class="small muted">Entry written ${last.t ? esc(new Date(last.t).toLocaleString('en-US', { timeZone: TZ })) + ' ' + esc(L('tzName')) : 'time unknown'}. This device last checked ${S.meta.lastSync ? esc(new Date(S.meta.lastSync).toLocaleString('en-US', { timeZone: TZ })) : 'never'}.</p>`;
  else h += '<p class="muted">No log entries have arrived yet.</p>';
  h += `<div class="box amber"><b>What this is not.</b> The phone sends its log only when it finds signal, which can be days apart in ${esc(L('quiet'))}. Silence here is normal. The daily check-in is the satellite message, not this page. If a check-in is missed, follow the steps under Emergency.</div><div class="btns"><button class="btn" data-act="sync">Check now</button><a class="btn ghost" href="#/sos">Emergency steps and numbers</a></div></div>`;
  if (d) h += dayCard(d, { tag: 'where the plan puts him today' });
  if (r) h += paceCard(false);
  return h;
};
V.day = n => { if (!P()) return needPlan(); const d = P().days.find(x => x.day === +n); if (!d) return '<p>No such day.</p>'; return `<div class="btns">${d.day > 1 ? `<a class="btn ghost" href="#/day/${d.day - 1}">‹ Day ${d.day - 1}</a>` : ''}<a class="btn ghost" href="#/plan">Schedule</a>${d.day < P().days.length ? `<a class="btn ghost" href="#/day/${d.day + 1}">Day ${d.day + 1} ›</a>` : ''}</div>` + dayCard(d) + (isHome() ? '' : `<a class="btn block" href="#/log/edit/${d.date}">Log this day</a>`); };
const planSeg = cur => `<div class="seg">${[['schedule', 'Schedule'], ['check', 'Checkpoints'], ['todo', 'To do'], ['docs', 'Papers']].map(([k, l]) => `<a href="#/plan/${k}" ${k === cur ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</div>`;
function todoRow(c) { const done = !!S.st.todo[c.id]; return `<label class="check ${done ? 'done' : ''} ${c.key ? 'key' : ''}"><input type="checkbox" data-todo="${esc(c.id)}" ${done ? 'checked' : ''} ${isHome() ? 'disabled' : ''}><span class="t"><b>${esc(c.label)}</b><br>${esc(c.text)}</span></label>`; }
V.plan = sub => {
  if (!P()) return needPlan(); sub = sub || 'schedule'; let h = '<h1>The plan</h1>' + planSeg(sub);
  if (sub === 'schedule') {
    const t = today(); let month = '';
    h += `<p class="muted small">${P().days.length} days · ${int(total())} miles · day 1 ${esc(fmtD(P().meta.start))} · ${esc(L('end'))} ${esc(fmtD(P().meta.finish))} (book-pace control ${esc(fmtD(P().meta.control_finish))}). A ${esc(P().meta.status)}.</p>`;
    P().days.forEach(d => { const m = fmtD(d.date, { weekday: undefined, day: undefined, month: 'long', year: 'numeric' }); if (m !== month) { if (month) h += '</ul>'; month = m; h += `<h2 class="month">${esc(m)}</h2><ul class="list">`; }
      const dots = [...new Set(d.notes.map(n => FLAG[n.flag]).filter(Boolean))].map(c => `<i class="dot ${c}"></i>`).join('');
      h += `<li><a class="item ${d.kind === 'rest day' ? 'rest' : ''} ${d.date === t ? 'today' : ''}" href="#/day/${d.day}"><span class="d">${d.day} · ${esc(fmtD(d.date, { weekday: undefined }))}</span><span class="t">${d.kind === 'rest day' ? 'Rest day, ' : ''}${esc(d.to)}${d.kind === 'town' ? ' <span class="flag green">TOWN</span>' : ''}${dots}</span><span class="r">${d.mi ? num(d.mi) : ''}</span></a></li>`; });
    h += '</ul>';
  } else if (sub === 'check') {
    const ca = P().control, pa = planArr(), es = entries();
    h += `<div class="card"><p class="small muted">Plan = your pace. Control = book pace, ten hours a day. If you are later than the control date, you are outside the range the plan was built for.</p><div class="scroll"><table><tr><th>Checkpoint</th><th>Plan</th><th>Control</th><th>You</th></tr>` +
      P().towns.filter(t => t.kind === 'town').concat([{ name: L('endName'), m: total() }]).map(t => { const you = es.find(e => typeof e.b === 'number' && e.b >= t.m - 0.05), c = dateAtMile(ca, t.m); return `<tr><td>${esc(t.name)}<br><span class="muted small num">mile ${num(t.m)}${t.zero ? ' · rest day' : ''}</span></td><td>${esc(fmtD(dateAtMile(pa, t.m), { weekday: undefined }))}</td><td>${esc(fmtD(c, { weekday: undefined }))}</td><td>${you ? `<span class="flag ${you.date > c ? 'red' : 'green'}">${esc(fmtD(you.date, { weekday: undefined }))}</span>` : ''}</td></tr>`; }).join('') + '</table></div></div>' +
      `<div class="card"><h2>Decision points</h2>${P().decision.points.map(p => `<p><b>${esc(p.name)}</b> (plan ${esc(fmtD(p.plan))}, control ${esc(fmtD(p.control))}). ${esc(p.text)}</p>`).join('')}<p class="small muted">${esc(P().decision.note)}</p></div>`;
  } else if (sub === 'todo') {
    const pre = P().calendar.filter(c => !c.trail), tr = P().calendar.filter(c => c.trail);
    h += roNote() + `<div class="card"><h2>Before the trail</h2>${pre.map(todoRow).join('')}</div><div class="card"><h2>Bookings on the trail</h2>${tr.map(todoRow).join('')}</div><a class="btn ghost block" href="#/rules/permits">Every permit in detail</a>`;
  } else h += '<ul class="list card">' + P().docs.map((d, i) => `<li><a class="item" href="#/doc/${i}"><span class="t">${esc(d.title)}</span><span class="r">${int(d.md.length / 1000)}k</span></a></li>`).join('') + '</ul><p class="small muted">The full written record, as researched. All of it is on the phone.</p>';
  return h;
};
V.doc = i => { const d = P() && P().docs[+i]; return d ? `<div class="btns"><a class="btn ghost" href="#/plan/docs">‹ Papers</a></div><div class="md">${mdToHtml(d.md)}</div>` : '<p>Not found.</p>'; };
V.stops = sub => {
  if (!P()) return needPlan(); sub = sub || 'towns'; const base = myMile() != null ? myMile() : mileOn(planArr(), today()), pa = planArr();
  let h = `<h1>Stops and food</h1><div class="seg">${[['towns', 'Towns'], ['ahead', 'Sites ahead'], ['all', 'Every option']].map(([k, l]) => `<a href="#/stops/${k}" ${k === sub ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</div><p class="small muted">From mile ${num(base)} (${myMile() != null ? 'your last log entry' : 'where the plan puts you today'}).</p>`;
  if (sub === 'towns') {
    const ts = P().towns.filter(t => t.kind === 'town');
    h += '<ul class="list card">' + ts.map((t, i) => { const nx = ts[i + 1], gone = t.m <= base; return `<li><a class="item ${gone ? 'rest' : ''}" href="#/town/${i}"><span class="d">${gone ? 'passed' : num(t.m - base) + ' mi'}</span><span class="t">${esc(t.name)}${t.zero ? ' <span class="flag green">REST</span>' : ''}<span class="sub">plan ${esc(fmtD(dateAtMile(pa, t.m)))}${nx ? ' · next town in ' + num(nx.m - t.m) + ' mi' : ''}</span></span><span class="r">${num(t.m)}</span></a></li>`; }).join('') + '</ul><p class="small muted">Scheduled town nights. Stores passed between them are under "Every option".</p>';
  } else if (sub === 'ahead') {
    h += '<ul class="list card">' + sitesAhead(base, 60).map(p => `<li><span class="item"><span class="d">${num(p.m - base)} mi</span><span class="t">${esc(p.n)}<span class="sub">${KIND[p.k]}${p.st ? ' · ' + esc(p.st) : ''}${p.off > 500 ? ' · ' + int(p.off) + ' ft off trail' : ''}${p.food ? ' · ' + esc(p.food) : ''}</span></span><span class="r">${num(p.m)}</span></span></li>`).join('') + '</ul><p class="small muted">Official shelters, campsites and road crossings from the Park Service data (2026 edition of a 2015–17 survey). A shelter may have closed since: confirm against a current guide.</p>';
  } else {
    h += '<ul class="list card">' + P().resupply.map((r, i) => `<li><a class="item ${r.m != null && r.m <= base ? 'rest' : ''}" href="#/resupply/${i}"><span class="d">${r.m != null ? num(r.m) : '–'}</span><span class="t">${esc(r.place)}<span class="sub">${esc(r.state)} · ${esc(r.grocery.slice(0, 70))}</span></span><span class="r">${esc(r.conf.split(/[ (]/)[0])}</span></a></li>`).join('') + '</ul>';
  }
  return h;
};
const kv = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : '';
V.town = i => { const ts = P().towns.filter(t => t.kind === 'town'), t = ts[+i]; if (!t) return '<p>Not found.</p>'; const near = P().resupply.map((r, k) => [r, k]).filter(([r]) => r.m != null && Math.abs(r.m - t.m) <= 2.5);
  return `<div class="btns"><a class="btn ghost" href="#/stops">‹ Towns</a></div><div class="card"><p class="kicker">Mile ${num(t.m)} · ${esc(t.state)}${t.zero ? ' · rest day' : ''}</p><p class="big">${esc(t.name)}</p><p>Plan arrival ${esc(fmtDL(dateAtMile(planArr(), t.m)))}; control ${esc(fmtD(dateAtMile(P().control, t.m)))}.</p><p>${esc(t.note)}</p></div>` + near.map(([r, k]) => resupplyCard(r)).join(''); };
function resupplyCard(r) { return `<div class="card"><p class="kicker">${r.m != null ? 'Mile ' + num(r.m) : 'Mile not published'} · ${esc(r.state)}</p><h2>${esc(r.place)}</h2><div class="scroll"><table>${kv('Leave the trail at', r.access)}${kv('Off trail', r.off)}${kv('How reached', r.how)}${kv('Food', r.grocery)}${kv('Outfitter, fuel', r.outfitter)}${kv('Post, mail drop', r.mail)}${kv('Lodging', r.lodging)}${kv('Other', r.other)}${kv('Season', r.season)}${kv('How far to trust this', r.conf)}${kv('Sources', r.src)}</table></div></div>`; }
V.resupply = i => { const r = P().resupply[+i]; return r ? `<div class="btns"><a class="btn ghost" href="#/stops/all">‹ Every option</a></div>` + resupplyCard(r) : '<p>Not found.</p>'; };

/* ---------- the log ---------- */
const WX = ['clear', 'cloud', 'rain', 'storm', 'snow', 'hot', 'cold', 'wind', 'fog'];
V.log = sub => {
  if (!P()) return needPlan();
  if (sub === 'pace') return `<div class="btns"><a class="btn ghost" href="#/log">‹ Log</a></div>` + paceCard(true) + weightCard();
  const es = entries().reverse();
  let h = `<h1>Log</h1>${isHome() ? '' : `<a class="btn block" href="#/log/edit/${esc(today())}">Log ${today() === realToday() ? 'today' : esc(fmtD(today()))}</a>`}<div class="btns"><a class="btn ghost" href="#/log/pace">Pace and weight</a></div>`;
  h += es.length ? '<ul class="list card">' + es.map(e => `<li><a class="item ${e.rest ? 'rest' : ''}" href="#/log/edit/${e.date}"><span class="d">${esc(fmtD(e.date, { weekday: undefined }))}</span><span class="t">${e.rest ? 'Rest day' : esc(e.place || 'Mile ' + num(e.b))}<span class="sub">${e.hours ? num(e.hours) + ' h walking' : ''}${e.wx.length ? ' · ' + esc(e.wx.join(', ')) : ''}${e.food != null ? ' · food ' + num(e.food) + ' d' : ''}</span></span><span class="r">${typeof e.a === 'number' && typeof e.b === 'number' && !e.rest ? num(e.b - e.a) + ' mi' : ''}</span></a></li>`).join('') + '</ul>' : '<div class="card"><p class="muted">Nothing logged yet. One entry a day takes a minute and is what tells you, and home, whether the plan is holding.</p></div>';
  return h;
};
function weightCard() { const ws = entries().filter(e => e.weight > 0); const fl = parseFloat(S.st.floor); let h = `<div class="card"><h2>Weight</h2>`;
  h += ws.length ? `<div class="scroll"><table><tr><th>Date</th><th class="n">lb</th><th class="n">change</th></tr>${ws.map((e, i) => `<tr><td>${esc(fmtD(e.date))}</td><td class="n">${num(e.weight)}</td><td class="n">${i ? num(e.weight - ws[0].weight) : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted">Add your weight to a log entry on rest days.</p>';
  if (fl && ws.length && ws[ws.length - 1].weight < fl) h += `<div class="box red"><b>Below your floor of ${num(fl)} lb.</b> Stop in the next town and eat for a day before going on.</div>`;
  return h + `<label for="floor">Floor (lb): the weight below which you stop and eat. ${esc(L('floorNote'))}</label><input id="floor" inputmode="decimal" value="${esc(S.st.floor)}" data-floor ${isHome() ? 'disabled' : ''}><p class="small muted">Weight is health data. It stays in the private log.</p></div>`; }
V.edit = date => {
  if (!P()) return needPlan(); if (!DATE_RE.test(date)) return '<p>Bad date.</p>';
  const prev = entries().filter(e => e.date < date && typeof e.b === 'number').pop(), pd = dayByDate(date);
  const e = S.logs[date] && !S.logs[date].deleted ? S.logs[date] : { date, a: prev ? prev.b : (pd ? pd.a : 0), b: null, wx: [], rest: pd ? pd.kind === 'rest day' : false };
  const a = typeof e.a === 'number' ? e.a : 0, opts = sitesAhead(a - 0.06, 45).map(p => `<option value="${p.m}|${esc(p.n)}">${num(p.m - a)} mi · ${esc(p.n)} (${KIND[p.k]})</option>`).join('');
  const five = (name, v) => `<div class="chips">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="${name}" value="${n}" ${v === n ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>`;
  return `<h1>${S.logs[date] ? 'Edit' : 'Log'} ${esc(fmtD(date))}</h1>${pd ? `<p class="muted small">Plan day ${pd.day}: ${pd.kind === 'rest day' ? 'rest day in ' : ''}${esc(pd.to)}${pd.mi ? ', ' + num(pd.mi) + ' mi to mile ' + num(pd.b) : ''}.</p>` : ''}
  <form id="logform" class="card" data-date="${esc(date)}" autocomplete="off">
  <label class="check"><input type="checkbox" name="rest" ${e.rest ? 'checked' : ''}><span class="t">Rest day (no miles)</span></label>
  <div class="two"><div><label for="la">Started at mile</label><input id="la" name="a" inputmode="decimal" value="${typeof e.a === 'number' ? e.a : ''}"></div><div><label for="lb">Ended at mile</label><input id="lb" name="b" inputmode="decimal" value="${typeof e.b === 'number' ? e.b : ''}"></div></div>
  <label for="pick">Where the day ended</label><select id="pick" data-pick><option value="">Choose a site ahead…</option>${opts}</select>
  <input name="place" aria-label="Place name" placeholder="Place name" value="${esc(e.place || '')}">
  <div class="btns"><button type="button" class="btn ghost" data-act="gpslog">Use GPS for the mile</button></div>
  <div class="two"><div><label for="ls">Set off</label><input id="ls" type="time" name="start" value="${esc(e.start || '')}"></div><div><label for="le">Stopped</label><input id="le" type="time" name="end" value="${esc(e.end || '')}"></div></div>
  <div class="two"><div><label for="lk">Breaks (minutes)</label><input id="lk" name="breaks" inputmode="numeric" value="${e.breaks != null ? e.breaks : ''}"></div><div><label for="lh">Walking hours</label><input id="lh" name="hours" inputmode="decimal" value="${e.hours != null ? e.hours : ''}"></div></div>
  <p class="small muted">Walking hours fill in from the times and breaks, or type them.</p>
  <label>Weather</label><div class="chips">${WX.map(w => `<label><input type="checkbox" name="wx" value="${w}" ${e.wx.includes(w) ? 'checked' : ''}><span>${w}</span></label>`).join('')}</div>
  <label>Feet and legs (1 bad, 5 good)</label>${five('feet', e.feet)}<label>Energy (1 low, 5 high)</label>${five('energy', e.energy)}
  <div class="two"><div><label for="lsh">Sleep last night (hours)</label><input id="lsh" name="sleepH" inputmode="decimal" value="${e.sleepH != null ? e.sleepH : ''}"></div><div><label>Sleep quality</label>${five('sleepQ', e.sleepQ)}</div></div>
  <div class="two"><div><label for="lf">Food in the pack (days)</label><input id="lf" name="food" inputmode="decimal" value="${e.food != null ? e.food : ''}"></div><div><label for="lw">Weight, lb (rest days)</label><input id="lw" name="weight" inputmode="decimal" value="${e.weight != null ? e.weight : ''}"></div></div>
  <label for="ln">Notes</label><textarea id="ln" name="notes">${esc(e.notes || '')}</textarea>
  <div class="btns"><button class="btn" type="submit">Save</button><a class="btn ghost" href="#/log">Cancel</a>${S.logs[date] ? '<button type="button" class="btn danger" data-act="dellog">Delete</button>' : ''}</div>
  <p class="small muted">Saved on the phone at once; sent to the private log when there is signal.</p></form>`;
};

/* ---------- guide, gear, rules, emergency ---------- */
const C = k => (P() && P().content && P().content[k]) || null;
const ul = (a, cls) => (a && a.length) ? `<ul${cls ? ` class="${cls}"` : ''}>${a.map(x => `<li>${esc(typeof x === 'string' ? x : x.text || JSON.stringify(x))}</li>`).join('')}</ul>` : '';
const sect = (title, a) => (a && a.length) ? `<h3>${esc(title)}</h3>${ul(a)}` : '';
const srcs = a => (a && a.length) ? `<h3>Sources</h3><ul class="small muted">${a.map(s => `<li>${esc(s.name || '')}${s.url ? '<br>' + esc(s.url) : ''}</li>`).join('')}</ul>` : '';
V.more = () => `<h1>More</h1><ul class="list card">${[['#/guide', 'Survival guide', 'Fords, cold, weather, injury, water, ticks, bears'], ['#/gear', 'Gear checklist', 'What to carry, what to swap and where'], ['#/rules', 'Rules and permits', 'Where you may sleep, fees, closures, hunting'], ['#/sos', 'Emergency', 'What to do, numbers, your position'], ['#/plan/docs', 'Papers', 'The plan and all the research, in full'], ['#/settings', 'Settings', 'Key, sync, backup']].map(([h, t, s]) => `<li><a class="item" href="${h}"><span class="t">${t}<span class="sub">${s}</span></span><span class="r">›</span></a></li>`).join('')}</ul><p class="small muted">Trail Book ${VERSION}${P() ? ' · plan built ' + esc(P().meta.built) : ''}</p>`;
V.guide = id => {
  const g = C('guide'); if (!g) return '<h1>Survival guide</h1><div class="card"><p class="muted">The guide has not been loaded to this phone yet. Sync once with signal.</p></div>';
  if (!id) return `<h1>Survival guide</h1><p class="small muted">What the authorities say, from the research. Not a substitute for judgement, training or a physician.</p><ul class="list card">${g.cards.map(c => `<li><a class="item" href="#/guide/${esc(c.id)}"><span class="t">${esc(c.title)}<span class="sub">${esc(c.headline || '')}</span></span><span class="r">›</span></a></li>`).join('')}</ul>`;
  const c = g.cards.find(x => x.id === id); if (!c) return '<p>Not found.</p>';
  return `<div class="btns"><a class="btn ghost" href="#/guide">‹ Guide</a></div><h1>${esc(c.title)}</h1><p class="muted">${esc(c.where_when || '')}</p>${c.headline ? `<div class="box green"><b>${esc(c.headline)}</b></div>` : ''}
  ${c.stop_if && c.stop_if.length ? `<div class="box red"><b>Stop, turn back or get help if:</b>${ul(c.stop_if)}</div>` : ''}<div class="card">${sect('What to do', c.do)}${sect('If it goes wrong', c.if_it_goes_wrong)}${sect('Signs', c.signs)}${sect('Prevent it', c.prevent)}${sect('Ask your physician', c.ask_physician)}${sect('Where the authorities differ', c.authorities_disagree)}${sect('Not settled', c.tbd)}${srcs(c.sources)}</div>`;
};
V.gear = () => {
  const g = C('gear'); if (!g) return '<h1>Gear</h1><div class="card"><p class="muted">The gear list has not been loaded to this phone yet. Sync once with signal.</p></div>';
  let tot = 0, n = 0, done = 0; g.groups.forEach(gr => gr.items.forEach(it => { n++; if (S.st.gear[it.id]) done++; if (S.st.oz[it.id] > 0) tot += S.st.oz[it.id]; }));
  let h = `<h1>Gear checklist</h1>` + roNote() + `<div class="card"><div class="stats two">${stat(done + ' / ' + n, 'ticked')}${stat(tot ? num(tot / 16) + ' lb' : '–', 'weighed so far')}</div><p class="small muted">${esc(g.base_weight_note || '')}</p></div>`;
  if (g.swaps && g.swaps.length) h += `<div class="card"><h2>Changes on the way</h2>${g.swaps.map(s => `<p><b>${esc(s.where)}</b>${s.when ? ', ' + esc(s.when) : ''}: ${esc(s.what)}</p>`).join('')}</div>`;
  g.groups.forEach(gr => { h += `<div class="card"><h2>${esc(gr.title)}</h2>${gr.note ? `<p class="small muted">${esc(gr.note)}</p>` : ''}` + gr.items.map(it => `<div class="check ${S.st.gear[it.id] ? 'done' : ''}"><input type="checkbox" aria-label="${esc(it.name)}" data-gear="${esc(it.id)}" ${S.st.gear[it.id] ? 'checked' : ''} ${isHome() ? 'disabled' : ''}><span class="t"><b>${esc(it.name)}</b>${it.why ? '<br>' + esc(it.why) : ''}${it.spec ? `<br><span class="small muted">${esc(it.spec)}</span>` : ''}${it.tbd ? `<br><span class="small"><span class="flag amber">TBD</span>${esc(it.tbd)}</span>` : ''}<br><input class="oz" inputmode="decimal" aria-label="Weight of ${esc(it.name)} in ounces" placeholder="oz" data-oz="${esc(it.id)}" value="${S.st.oz[it.id] > 0 ? S.st.oz[it.id] : ''}" ${isHome() ? 'disabled' : ''}></span></div>`).join('') + '</div>'; });
  if (g.consumables && g.consumables.length) h += `<div class="card"><h2>Consumables</h2>${ul(g.consumables.map(c => c.name + (c.note ? ': ' + c.note : '')))}</div>`;
  return h;
};
V.rules = id => {
  const r = C('rules'); if (!r) return '<h1>Rules and permits</h1><div class="card"><p class="muted">The rules have not been loaded to this phone yet. Sync once with signal.</p></div>';
  const tbl = (rows, cols) => `<div class="scroll"><table><tr>${cols.map(c => `<th>${esc(c[1])}</th>`).join('')}</tr>${rows.map(x => `<tr>${cols.map(c => `<td>${esc(x[c[0]] == null ? '' : x[c[0]])}</td>`).join('')}</tr>`).join('')}</table></div>`;
  if (id === 'permits') return `<div class="btns"><a class="btn ghost" href="#/rules">‹ Rules</a></div><h1>Permits and reservations</h1><div class="card">${tbl(r.permits || [], [['what', 'What'], ['earliest', 'Earliest'], ['lead_time', 'Rule'], ['cost', 'Cost'], ['where', 'Where'], ['status', 'Status']])}</div>`;
  if (id === 'closures') return `<div class="btns"><a class="btn ghost" href="#/rules">‹ Rules</a></div><h1>Closures and detours</h1><p class="small muted">As read on the date in the research. These change: check the trail's own updates page whenever you have signal.</p><div class="card">${tbl(r.closures || [], [['entry', 'Notice'], ['date_on_page', 'Dated'], ['status', 'Status']])}</div><h2>Seasonal shut-downs</h2><div class="card">${tbl(r.seasonal || [], [['facility', 'Facility'], ['dates', 'Dates'], ['year', 'Year']])}</div>`;
  if (id === 'hunting') { const hu = r.hunting || {}; return `<div class="btns"><a class="btn ghost" href="#/rules">‹ Rules</a></div><h1>Hunting season</h1><div class="card"><p>${esc(hu.atc_guidance || '')}</p><p>${esc(hu.what_it_means || '')}</p></div><div class="card">${tbl(hu.states || [], [['state', 'State'], ['dates', 'Dates'], ['orange', 'Orange rule'], ['status', 'Status']])}</div>`; }
  const u = id && (r.units || []).find(x => x.id === id);
  if (u) return `<div class="btns"><a class="btn ghost" href="#/rules">‹ Rules</a></div><h1>${esc(u.name)}</h1><p class="muted">${esc((u.states || []).join(', '))}${u.sobo_from != null ? ` · mile ${num(u.sobo_from)} to ${num(u.sobo_to)}` : ''}</p><div class="card">${sect('Where you may sleep', u.sleep)}${sect('Fires', u.fires)}${sect('Food storage', u.food_storage)}${sect('Permits', u.permits)}${sect('Fees', u.fees)}${sect('Also', u.other)}${sect('Where sources differ', u.conflicts)}${sect('Not settled', u.tbd)}${srcs(u.sources)}</div>`;
  const m = myMile() != null ? myMile() : mileOn(planArr(), today());
  return `<h1>Rules and permits</h1><ul class="list card">${[['permits', 'Permits and reservations'], ['closures', 'Closures, detours and seasonal shut-downs'], ['hunting', 'Hunting season']].map(([k, t]) => `<li><a class="item" href="#/rules/${k}"><span class="t">${t}</span><span class="r">›</span></a></li>`).join('')}</ul>${r.food_summary ? `<div class="card"><h2>Food storage in brief</h2>${ul(r.food_summary)}</div>` : ''}<h2>By land, north to south</h2><ul class="list card">${(r.units || []).map(x => `<li><a class="item" href="#/rules/${esc(x.id)}"><span class="t">${esc(x.name)}${x.sobo_from != null && m >= x.sobo_from && m <= x.sobo_to ? ' <span class="flag green">YOU ARE HERE</span>' : ''}<span class="sub">${esc((x.states || []).join(', '))}</span></span><span class="r">›</span></a></li>`).join('')}</ul>`;
};
V.sos = () => {
  const em = C('emergency'), g = S.gps, card = S.settings.card;
  let h = `<h1>Emergency</h1><div class="box red"><b>Life in danger: call 911, or press SOS on the satellite device.</b> ${em ? esc(em.first || '') : 'Tell the dispatcher you are ' + esc(L('who')) + ' and give your location.'}</div><div class="card"><h2>Your position</h2>`;
  if (g && g.lat != null) { h += `<p class="coords">${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}</p><p>${g.mile != null ? `Trail mile <b class="num">${num(g.mile)}</b> ${esc(L('dirNote'))} (${num(total() - g.mile)} from the other end)${g.offFt > 1500 ? ', about ' + int(g.offFt) + ' ft off the trail' : ''}.` : ''} Fix within ${int(g.acc * 3.28)} ft at ${esc(fmtT(new Date(g.t)))}.</p>`;
    if (g.mile != null && P()) { const roads = P().points.filter(p => p.k === 'r'), back = roads.filter(p => p.m <= g.mile).pop(), fwd = roads.find(p => p.m > g.mile); h += `<p class="small">Nearest roads on the trail: ${back ? esc(back.n) + ', ' + num(g.mile - back.m) + ' mi back north' : 'none behind'}; ${fwd ? esc(fwd.n) + ', ' + num(fwd.m - g.mile) + ' mi ahead south' : 'none ahead'}.</p>`; } }
  else h += `<p class="muted">${g && g.err ? esc(g.err) : 'Tap to read your position from the GPS. It works with no signal.'}</p>`;
  h += `<div class="btns"><button class="btn danger" data-act="gps">${g && g.wait ? 'Finding you…' : 'Get my position'}</button></div></div>`;
  if (card.name || card.contact || card.medical) h += `<div class="card"><h2>About me</h2>${card.name ? `<p><b>${esc(card.name)}</b></p>` : ''}${card.contact ? `<p>Emergency contact: ${esc(card.contact)}</p>` : ''}${card.medical ? `<p>${esc(card.medical)}</p>` : ''}<p class="small muted">Kept on this phone only.</p></div>`;
  else if (!isHome()) h += `<div class="card"><p class="muted">Add your name, emergency contact and medical notes in <a href="#/settings">Settings</a>. They stay on this phone only.</p></div>`;
  if (em) {
    h += `<div class="card"><h2>Numbers</h2>${(em.numbers || []).map(n => `<a class="tel" href="tel:${esc(String(n.number).replace(/[^\d+]/g, ''))}"><span class="grow">${esc(n.label)}<span class="sub small muted"><br>${esc([n.area, n.note].filter(Boolean).join(' · '))}</span></span><b>${esc(n.number)}</b></a>`).join('')}${em.not_found && em.not_found.length ? `<h3>Not found in the research</h3>${ul(em.not_found, 'small muted')}` : ''}</div>`;
    h += `<div class="card"><h2>If a check-in is missed (for home)</h2>${(em.ladder || []).map(s => `<p><b>Step ${esc(s.step)}${s.after ? ', after ' + esc(s.after) : ''}.</b> ${esc(s.do)}</p>`).join('')}${sect('The check-in schedule', em.check_in)}${sect('The walker\'s side', em.his_side)}${sect('Bear in mind', em.caveats)}</div>`;
    if (em.home_holds) h += `<div class="card"><h2>What home holds</h2>${em.home_holds.map(x => sect(x.group, x.items)).join('')}${sect('What the walker carries', em.hiker_carries)}</div>`;
  } else h += '<div class="card"><p class="muted">The numbers list has not been loaded to this phone yet. Sync once with signal.</p></div>';
  return h + '<a class="btn ghost block" href="#/guide">Survival guide</a>';
};
V.settings = () => {
  const s = S.settings, pend = S.meta.dirty.length + (S.meta.stDirty ? 1 : 0);
  return `<h1>Settings</h1>
  <div class="card"><h2>The private log and plan</h2><p class="small muted">The plan and your log live in a private repository. The key below lets this phone read ${isHome() ? '' : 'and write '}it. The key stays in this browser only.</p>
  <label for="mode">This device is</label><select id="mode" data-set="mode"><option value="hiker" ${s.mode === 'hiker' ? 'selected' : ''}>The walker's phone (reads and writes)</option><option value="home" ${s.mode === 'home' ? 'selected' : ''}>The home contact's (reads only)</option></select>
  <label for="repo">Repository (owner/name)</label><input id="repo" data-set="repo" value="${esc(s.repo)}" placeholder="owner/name" autocapitalize="off" spellcheck="false">
  <label for="tok">Key (GitHub fine-grained token)</label><input id="tok" type="password" data-set="token" value="${esc(s.token)}" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false">
  <p class="small muted" id="keyinfo">${esc(keyInfo(s.token))}</p><div class="btns"><button type="button" class="btn ghost" data-act="showkey">Show or hide the key</button><button type="button" class="btn ghost" data-act="clearkey">Clear the key</button></div>
  <div class="btns"><button class="btn" data-act="sync">Sync now</button><button class="btn ghost" data-act="test">Test the key</button></div>
  <p class="small muted">Last sync: ${S.meta.lastSync ? esc(new Date(S.meta.lastSync).toLocaleString('en-US', { timeZone: TZ })) + ' ' + esc(L('tzName')) : 'never'}${pend ? ` · ${pend} change${pend === 1 ? '' : 's'} waiting for signal` : ''}${S.meta.lastErr ? ' · last problem: ' + esc(S.meta.lastErr) : ''}<br>Plan on this device: ${P() ? 'built ' + esc(P().meta.built) : 'none'} · trail line: ${S.track ? 'yes' : 'none'}</p><p class="small" id="offline"></p></div>
  ${isHome() ? '' : `<div class="card"><h2>About me (this phone only)</h2><p class="small muted">Shown on the Emergency page. Never sent anywhere.</p><label for="cn">Name</label><input id="cn" data-card="name" value="${esc(s.card.name)}"><label for="cc">Emergency contact (name and number)</label><input id="cc" data-card="contact" value="${esc(s.card.contact)}"><label for="cm">Medical notes (conditions, medicines, allergies, physician)</label><textarea id="cm" data-card="medical">${esc(s.card.medical)}</textarea></div>`}
  <div class="card"><h2>Preview a day</h2><p class="small muted">See the app as it will look on a day of the walk. Leave empty for today.</p><input type="date" data-set="preview" aria-label="Preview date" value="${esc(s.preview)}"></div>
  <div class="card"><h2>Backup</h2><p class="small muted">A copy of your log and checklists as a file, in case the phone or the sync fails.</p><div class="btns"><button class="btn ghost" data-act="export">Save a backup file</button><label class="btn ghost">Restore from a file<input type="file" accept="application/json,.json" data-import hidden></label></div>
  <p class="small muted" id="persist"></p><div class="btns"><button class="btn danger" data-act="wipe">Erase everything on this device</button></div></div>
  <p class="small muted">Trail Book ${VERSION}. Position, sun times and pace are aids, not instruments. Carry the paper map.</p>`;
};

/* ---------- router ---------- */
const ICON = { today: '<path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/>', plan: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', stops: '<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>', log: '<path d="M4 20h16M6 16l9-9 3 3-9 9H6z"/>', more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>' };
function tabs(cur) { const t = isHome() ? [['today', 'Home'], ['plan', 'Plan'], ['stops', 'Stops'], ['log', 'Log'], ['more', 'More']] : [['today', 'Today'], ['plan', 'Plan'], ['stops', 'Stops'], ['log', 'Log'], ['more', 'More']];
  $('#tabs').innerHTML = t.map(([k, l]) => `<a href="#/${k}" ${cur === k ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>${l}</a>`).join(''); }
function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent), r = parts[0] || 'today'; let html, tab = r;
  try {
    if (r === 'setup' && REPO_RE.test(parts[1] + '/' + parts[2])) { S.settings.repo = parts[1] + '/' + parts[2]; S.settings.mode = parts[3] === 'home' ? 'home' : 'hiker'; saveSettings(); location.hash = '#/settings'; return; }
    if (r === 'day') { html = V.day(parts[1]); tab = 'plan'; }
    else if (r === 'plan') html = V.plan(parts[1]);
    else if (r === 'doc') { html = V.doc(parts[1]); tab = 'plan'; }
    else if (r === 'stops') html = V.stops(parts[1]);
    else if (r === 'town') { html = V.town(parts[1]); tab = 'stops'; }
    else if (r === 'resupply') { html = V.resupply(parts[1]); tab = 'stops'; }
    else if (r === 'log') html = parts[1] === 'edit' ? (isHome() ? V.log() : V.edit(parts[2])) : V.log(parts[1]);
    else if (['guide', 'rules'].includes(r)) { html = V[r](parts[1]); tab = 'more'; }
    else if (['gear', 'sos', 'settings', 'more'].includes(r)) { html = V[r](); tab = 'more'; }
    else html = V.today(), tab = 'today';
  } catch (e) { html = `<div class="card"><h2>Something went wrong on this page</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/today">Back to the start</a></div>`; }
  $('#main').innerHTML = html; tabs(tab); setNet();
  if (r === 'settings' && window.caches) caches.keys().then(ks => { const el = $('#offline'); if (el) { const ok = ks.some(k => k.startsWith('trailbook-shell')) && navigator.serviceWorker && navigator.serviceWorker.controller; el.textContent = ok ? 'Offline: ready. The app itself is stored on this device.' : 'Offline: not ready yet. Stay in signal, close the app and open it again, then look here once more.'; } });
  if (r === 'settings' && navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { const el = $('#persist'); if (el) el.textContent = p ? 'This browser has promised to keep the data.' : 'This browser may clear the data if the phone runs short of space. Installing the app to the home screen makes that less likely; keep a backup file.'; });
}
let lastHash = '';
window.addEventListener('hashchange', () => { render(); if (location.hash !== lastHash) { window.scrollTo(0, 0); lastHash = location.hash; } });

/* ---------- actions ---------- */
function locate(then) {
  if (!navigator.geolocation) { S.gps = { err: 'This phone or browser offers no location.' }; render(); return; }
  S.gps = Object.assign({}, S.gps, { wait: true, err: '' }); render();
  navigator.geolocation.getCurrentPosition(p => {
    const g = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy || 0, t: Date.now() };
    if (S.track) Object.assign(g, nearest(g.lat, g.lon)); S.gps = g; if (then) then(g); else render();
  }, e => { S.gps = { err: e.code === 1 ? 'Location is switched off for this app. Allow it in the phone\'s settings.' : 'No GPS fix yet. Stand in the open with a clear view of the sky and try again.' }; render(); }, { enableHighAccuracy: true, timeout: 45000, maximumAge: 30000 });
}
const DIRTY_T = {};
function markDirty(date) { const m = monthOf(date); DIRTY_T[m] = Date.now(); if (!S.meta.dirty.includes(m)) S.meta.dirty.push(m); saveMeta(); }
function stChanged() { S.st.updated = Date.now(); S.meta.stDirty = true; saveSt(); saveMeta(); setNet(); clearTimeout(stChanged.t); stChanged.t = setTimeout(() => sync(false), 4000); }
function formHours(f) { const s = f.start.value, e = f.end.value; if (!s || !e) return; const mins = (+e.slice(0, 2) * 60 + +e.slice(3)) - (+s.slice(0, 2) * 60 + +s.slice(3)) - (parseFloat(f.breaks.value) || 0); if (mins > 0) f.hours.value = (mins / 60).toFixed(1); }
document.addEventListener('click', async ev => {
  const go = ev.target.closest('[data-go]'); if (go) { location.hash = go.dataset.go; return; }
  const b = ev.target.closest('[data-act]'); if (!b) return; const act = b.dataset.act;
  if (act === 'gps') locate();
  else if (act === 'gpslog') locate(g => { const f = $('#logform'); if (f && g.mile != null) { const keep = new FormData(f); S.draft = Object.fromEntries(keep.entries()); S.draft.wx = keep.getAll('wx'); S.draft.b = g.mile.toFixed(1); const near = P().points.filter(p => p.k !== 'r' && Math.abs(p.m - g.mile) < 0.25)[0]; if (near && !S.draft.place) S.draft.place = near.n; S.draft.lat = g.lat; S.draft.lon = g.lon; } render(); applyDraft(); toast(g.offFt > 1500 ? 'You appear to be off the trail; mile is the nearest point.' : 'Mile filled from GPS.'); });
  else if (act === 'sync') sync(true);
  else if (act === 'acceptplan' && S.pending) { if (S.pending.plan) { await db.set('plan', S.pending.plan); usePlan(S.pending.plan); } if (S.pending.track) { await db.set('track', S.pending.track); S.track = decodeTrack(S.pending.track); } Object.assign(S.meta.shas, S.pending.shas); S.pending = null; await db.set('pending', null); await saveMeta(); toast('The new plan is in use.'); render(); }
  else if (act === 'keepplan' && S.pending) { Object.assign(S.meta.shas, S.pending.shas); S.pending = null; await db.set('pending', null); await saveMeta(); toast('Kept your plan. The new one will be offered again if it changes.'); render(); }
  else if (act === 'nopreview') { S.settings.preview = ''; saveSettings(); render(); }
  else if (act === 'test') { if (!S.settings.token || !S.settings.repo) return toast('Enter the repository and paste the key first.'); try { const r = await fetch(`https://api.github.com/repos/${S.settings.repo}`, { headers: hdr() }); if (!r.ok) { toast(keyProblem(r.status)); return; } const j = await r.json(); toast(!j.private ? 'Warning: that repository is PUBLIC.' : (j.permissions && j.permissions.push) ? (isHome() ? 'Key works, but it can write. A read-only key is safer here.' : 'Key works: private, can write.') : (isHome() ? 'Key works: private, read only.' : 'Key can read but not write. Set Contents to Read and write.')); } catch (e) { toast('Key test failed: ' + e.message); } }
  else if (act === 'showkey') { const el = $('#tok'); if (el) el.type = el.type === 'password' ? 'text' : 'password'; }
  else if (act === 'clearkey') { S.settings.token = ''; saveSettings(); render(); toast('Key cleared from this device.'); }
  else if (act === 'dellog') { const d = $('#logform').dataset.date; if (confirm('Delete this entry?')) { S.logs[d] = { date: d, deleted: true, wx: [], t: Date.now() }; await saveLogs(); markDirty(d); location.hash = '#/log'; sync(false); } }
  else if (act === 'export') { const blob = new Blob([JSON.stringify({ app: 'trailbook', version: VERSION, saved: new Date().toISOString(), logs: S.logs, st: S.st }, null, 1)], { type: 'application/json' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `trailbook-backup-${realToday()}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  else if (act === 'wipe') { if (confirm('Erase the plan, the log and the key from this device? The private repository is not touched.')) { await db.clear(); localStorage.removeItem('tb.settings'); location.hash = ''; location.reload(); } }
});
function applyDraft() { const f = $('#logform'), d = S.draft; if (!f || !d) return; ['a', 'b', 'place', 'start', 'end', 'breaks', 'hours', 'sleepH', 'food', 'weight', 'notes'].forEach(k => { if (d[k] != null && f[k]) f[k].value = d[k]; }); f.rest.checked = !!d.rest; (d.wx || []).forEach(w => { const el = f.querySelector(`input[name=wx][value="${w}"]`); if (el) el.checked = true; }); ['feet', 'energy', 'sleepQ'].forEach(k => { if (d[k]) { const el = f.querySelector(`input[name=${k}][value="${d[k]}"]`); if (el) el.checked = true; } }); f.dataset.lat = d.lat || ''; f.dataset.lon = d.lon || ''; S.draft = null; }
document.addEventListener('change', async ev => {
  const t = ev.target;
  if (t.dataset.todo) { S.st.todo[t.dataset.todo] = t.checked; stChanged(); t.closest('.check').classList.toggle('done', t.checked); }
  else if (t.dataset.gear) { S.st.gear[t.dataset.gear] = t.checked; stChanged(); t.closest('.check').classList.toggle('done', t.checked); }
  else if (t.dataset.oz) { const v = parseFloat(t.value); S.st.oz[t.dataset.oz] = v > 0 ? v : 0; stChanged(); }
  else if (t.hasAttribute('data-floor')) { S.st.floor = t.value.trim().slice(0, 8); stChanged(); }
  else if (t.dataset.set) { const k = t.dataset.set; let v = t.value.trim(); if (k === 'repo' && !REPO_RE.test(v)) { toast('That does not look like owner/name.'); t.value = S.settings.repo; return; } if (k === 'preview' && v && !DATE_RE.test(v)) v = ''; if (k === 'token') v = v.replace(/\s+/g, ''); S.settings[k] = v; saveSettings(); if (k === 'mode' || k === 'preview') render(); if (k === 'token') { t.value = v; const ki = $('#keyinfo'); if (ki) ki.textContent = keyInfo(v); } }
  else if (t.dataset.card) { S.settings.card[t.dataset.card] = t.value.slice(0, 1500); saveSettings(); }
  else if (t.hasAttribute('data-pick') && t.value) { const [m, ...n] = t.value.split('|'), f = $('#logform'); f.b.value = m; f.place.value = n.join('|'); }
  else if (t.hasAttribute('data-import') && t.files[0]) { try { const j = JSON.parse(await t.files[0].text()); if (j.app !== 'trailbook') throw new Error('not a Trail Book backup'); const before = Object.keys(S.logs).length; Object.values(j.logs || {}).forEach(e => { const c = cleanEntry(e); if (c && (!S.logs[c.date] || (c.t || 0) > (S.logs[c.date].t || 0))) { S.logs[c.date] = c; markDirty(c.date); } }); const st = cleanSt(j.st); if (st.updated > S.st.updated) { S.st = st; S.meta.stDirty = true; } await saveLogs(); await saveSt(); await saveMeta(); toast(`Restored. ${Object.keys(S.logs).length - before} new entries.`); render(); } catch (e) { toast('Could not restore: ' + e.message); } }
  else if (t.form && t.form.id === 'logform' && ['start', 'end', 'breaks'].includes(t.name)) formHours(t.form);
});
document.addEventListener('submit', async ev => {
  if (ev.target.id !== 'logform') return; ev.preventDefault(); const f = ev.target, fd = new FormData(f), date = f.dataset.date, g = k => fd.get(k);
  const e = cleanEntry({ date, rest: f.rest.checked, a: g('a'), b: f.rest.checked ? (g('b') || g('a')) : g('b'), place: g('place'), start: g('start'), end: g('end'), breaks: g('breaks'), hours: f.rest.checked ? null : g('hours'), wx: fd.getAll('wx'), feet: g('feet'), energy: g('energy'), sleepH: g('sleepH'), sleepQ: g('sleepQ'), food: g('food'), weight: g('weight'), notes: g('notes'), lat: f.dataset.lat, lon: f.dataset.lon, t: Date.now() });
  if (!e.rest && e.b == null) return toast('Enter the mile where the day ended, or tick Rest day.');
  if (e.a != null && e.b != null && e.b < e.a) return toast('The end mile is before the start mile. Miles count up from the start.');
  if (e.b != null && (e.b < 0 || e.b > total() + 0.5)) return toast('That mile is not on the trail.');
  S.logs[date] = e; await saveLogs(); markDirty(date); toast('Saved on the phone.'); location.hash = '#/log'; sync(false);
});
window.addEventListener('online', () => { setNet(); sync(false); });
window.addEventListener('offline', () => setNet());

/* ---------- start ---------- */
(async function start() {
  loadSettings();
  try {
    const [plan, track, logs, st, meta, pending] = await Promise.all(['plan', 'track', 'logs', 'st', 'meta', 'pending'].map(k => db.get(k)));
    const cp = cleanPlan(plan); if (cp) usePlan(cp); if (pending && pending.shas) S.pending = pending; if (track && track.n) S.track = decodeTrack(track);
    if (logs) Object.values(logs).forEach(e => { const c = cleanEntry(e); if (c) S.logs[c.date] = c; });
    if (st) S.st = cleanSt(st); if (meta) Object.assign(S.meta, meta, { dirty: Array.isArray(meta.dirty) ? meta.dirty : [], shas: meta.shas || {} });
  } catch (e) { toast('This browser is blocking storage; nothing can be kept.'); }
  render(); lastHash = location.hash;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  sync(false);
})();
