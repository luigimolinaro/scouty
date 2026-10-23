'use strict';
/*
 * Scout pallavolo - server (Node.js, nessuna dipendenza esterna)
 * - login con ruoli: coach (allenatore) e scout
 * - stato partita e squadre condivisi
 * - blocco "chi sta facendo scout" con heartbeat
 * - storico delle ultime 6 partite
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- comandi da riga di comando ---------- */
if (process.argv[2] === 'hash') {
  const pw = process.argv[3];
  if (!pw) { console.error('Uso: node server.js hash <password>'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32);
  console.log('scrypt$' + salt.toString('hex') + '$' + h.toString('hex'));
  process.exit(0);
}

/* ---------- configurazione ---------- */
const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const LOCK_TTL = Math.max(20, parseInt(process.env.LOCK_TTL || '90', 10)) * 1000;
const SECURE = process.env.COOKIE_SECURE === '1';
const MAX_HIST = parseInt(process.env.HISTORY_SIZE || '6', 10);
const MAX_LIVE = Math.max(1, parseInt(process.env.MAX_LIVE || '5', 10));
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '30', 10);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

fs.mkdirSync(DATA, { recursive: true });
try { fs.accessSync(DATA, fs.constants.W_OK); } catch (e) {
  console.error('Cartella dati non scrivibile: ' + DATA + ' (in Docker: mkdir -p data && chown 1000:1000 data)');
  process.exit(1);
}

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(DATA, 'secret');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* primo avvio */ }
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}

/* ---------- utenti ---------- */
// USERS="nome:password:coach;nome2:password2:scout"  (password anche nel formato scrypt$salt$hash)
function normRole(r) {
  r = String(r || '').trim().toLowerCase();
  if (['coach', 'allenatore', 'admin'].includes(r)) return 'coach';
  if (r === 'scoutman') return 'scoutman';
  if (r === 'scout') return 'scout';
  return null;
}
// coach e scoutman hanno gli stessi permessi (per ora); scout non vede statistiche e storico
const isFull = role => role === 'coach' || role === 'scoutman';
function hashPw(pw) {
  if (/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(pw)) {
    const [, s, h] = pw.split('$');
    return { salt: Buffer.from(s, 'hex'), hash: Buffer.from(h, 'hex') };
  }
  const salt = crypto.randomBytes(16);
  return { salt, hash: crypto.scryptSync(pw, salt, 32) };
}
const USERS = new Map();
(process.env.USERS || '').split(/[;\n]/).map(s => s.trim()).filter(Boolean).forEach(entry => {
  const a = entry.split(':');
  if (a.length < 3) { console.warn('USERS: voce ignorata (formato nome:password:ruolo)'); return; }
  const role = normRole(a[a.length - 1]);
  const name = a[0].trim();
  const pw = a.slice(1, -1).join(':');
  if (!name || !pw || !role) { console.warn('USERS: voce non valida per', name || '?'); return; }
  USERS.set(name.toLowerCase(), Object.assign({ name, role }, hashPw(pw)));
});
if (!USERS.size) {
  const gen = () => crypto.randomBytes(6).toString('base64url');
  const c = gen(), s = gen();
  USERS.set('allenatore', Object.assign({ name: 'allenatore', role: 'coach' }, hashPw(c)));
  USERS.set('scout', Object.assign({ name: 'scout', role: 'scout' }, hashPw(s)));
  console.warn('*** Nessun utente configurato (variabile USERS). Credenziali TEMPORANEE per questo avvio:');
  console.warn('*** allenatore / ' + c + '   scout / ' + s);
}
function checkUser(name, pw) {
  const u = USERS.get(String(name || '').trim().toLowerCase());
  const salt = u ? u.salt : crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw || ''), salt, 32);
  if (!u) return null;
  return crypto.timingSafeEqual(h, u.hash) ? u : null;
}

/* ---------- sessioni (cookie firmato) ---------- */
const b64 = b => Buffer.from(b).toString('base64url');
function sign(p) { return crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); }
function makeCookie(u) {
  const payload = b64(JSON.stringify({ u: u.name, r: u.role, sid: crypto.randomBytes(12).toString('hex'), exp: Date.now() + SESSION_DAYS * 864e5 }));
  return payload + '.' + sign(payload);
}
function readSession(req) {
  const m = /(?:^|;\s*)sv=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [p, s] = m[1].split('.');
  if (!p || !s) return null;
  const exp = sign(p);
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (!o.exp || o.exp < Date.now()) return null;
    const u = USERS.get(String(o.u).toLowerCase());
    if (!u || u.role !== o.r) return null; // utente rimosso o ruolo cambiato
    return { user: u.name, role: u.role, sid: o.sid };
  } catch (e) { return null; }
}
function cookieHeader(v, maxAge) {
  return `sv=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (SECURE ? '; Secure' : '');
}

/* ---------- dati su disco ---------- */
const F_DATA = path.join(DATA, 'data.json');
const F_HIST = path.join(DATA, 'history.json');
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function writeJson(f, o) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); }
const rid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const isMid = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
// data.json: { sqv, squads, matches: { mid: { ver, state, at, by } }, at, by }
let DB = readJson(F_DATA, null);
if (!DB || typeof DB !== 'object') DB = { sqv: 0, squads: null, matches: {}, at: 0, by: '' };
else if (!DB.matches) { // formato precedente (una sola partita): conversione, con copia di sicurezza
  try { fs.copyFileSync(F_DATA, F_DATA + '.v1'); } catch (e) { /* nessuna copia */ }
  const old = DB, s = old.state;
  DB = { sqv: old.ver || 0, squads: old.squads || null, matches: {}, at: old.at || 0, by: old.by || '' };
  if (s && Array.isArray(s.pl) && Array.isArray(s.ev) && (s.phase === 'match' || s.ev.length)) {
    const mid = isMid(s.mid) ? s.mid : rid(); s.mid = mid;
    DB.matches[mid] = { ver: 1, state: s, at: old.at || 0, by: old.by || '' };
  }
  writeJson(F_DATA, DB);
}
const MATCHES = new Map(Object.entries(DB.matches));
for (const [k, m] of MATCHES) if (m && m.state && m.state.archived && Date.now() - (m.at || 0) > 7 * 864e5) MATCHES.delete(k);
function saveDb() { writeJson(F_DATA, { sqv: DB.sqv, squads: DB.squads, matches: Object.fromEntries(MATCHES), at: DB.at, by: DB.by }); }
let HIST = readJson(F_HIST, []);
if (!Array.isArray(HIST)) HIST = [];

/* ---------- blocco scout (uno per partita) ---------- */
const LOCKS = new Map(); // mid -> {sid,u,r,since,beat}
const lockAlive = mid => { const l = LOCKS.get(mid); return !!l && Date.now() - l.beat < LOCK_TTL; };
function lockInfo(mid, sess) {
  if (!lockAlive(mid)) return null;
  const l = LOCKS.get(mid);
  return { u: l.u, r: l.r, since: l.since, alive: true, mine: !!sess && l.sid === sess.sid };
}
function grant(mid, sess) {
  const l = LOCKS.get(mid), keep = lockAlive(mid) && l.sid === sess.sid;
  for (const [k, x] of LOCKS) if (Date.now() - x.beat > LOCK_TTL * 10) LOCKS.delete(k);
  LOCKS.set(mid, { sid: sess.sid, u: sess.user, r: sess.role, since: keep ? l.since : Date.now(), beat: Date.now() });
}
const heldByOther = (mid, sess) => lockAlive(mid) && LOCKS.get(mid).sid !== sess.sid;
const normTeam = t => String(t || '').trim().toLowerCase();
// una sola partita in corso per squadra (le partite gia' concluse non contano)
function busyTeam(team, exceptMid) {
  const t = normTeam(team);
  for (const [k, m] of MATCHES) if (k !== exceptMid && m.state && !m.state.archived && normTeam(m.state.team) === t) return true;
  return false;
}
function liveList() {
  const out = [];
  for (const [mid, m] of MATCHES) {
    const s = m.state; if (!s || s.archived) continue;
    const l = lockInfo(mid, null);
    out.push({
      mid, team: String(s.team || '').slice(0, 60), opp: String(s.opp || '').slice(0, 60), date: s.date || '',
      set: Number(s.set) || 1,
      sc: Array.isArray(s.sc) ? s.sc.slice(0, 5).map(a => [Number(a && a[0]) || 0, Number(a && a[1]) || 0]) : [],
      lock: l ? { u: l.u, r: l.r } : null
    });
  }
  return out;
}


/* ---------- helper HTTP ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS, extra || {}));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((ok, ko) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { ko(Object.assign(new Error('too big'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return ok({}); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { ko(Object.assign(e, { code: 400 })); } });
    req.on('error', ko);
  });
}
const ipOf = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const TRIES = new Map();
function rateLimited(ip) {
  const now = Date.now(); const t = TRIES.get(ip) || { n: 0, at: now };
  if (now - t.at > 10 * 60e3) { t.n = 0; t.at = now; }
  t.n++; TRIES.set(ip, t);
  return t.n > 10;
}
function histSummary() {
  return HIST.map(h => ({ mid: h.mid, team: h.team, opp: h.opp, date: h.date, won: h.won, sets: (h.sc || []).slice(0, h.maxSet || 0) }));
}
function validState(s) { return s === null || (typeof s === 'object' && !Array.isArray(s) && Array.isArray(s.pl) && s.pl.length <= 60 && Array.isArray(s.ev)); }
function validSquads(s) { return s === null || (typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length <= 50); }

/* ---------- static ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { // SPA: qualsiasi altro percorso mostra l'app
      return fs.readFile(path.join(PUB, 'index.html'), (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, Object.assign({ 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' }, SEC_HEADERS)); res.end(b2);
      });
    }
    res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SEC_HEADERS));
    res.end(buf);
  });
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (m !== 'GET' && !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json richiesto' });

  if (p === '/api/login' && m === 'POST') {
    const ip = ipOf(req);
    if (rateLimited(ip)) return send(res, 429, { error: 'troppi tentativi' });
    const b = await readBody(req, 4096);
    const u = checkUser(b.user, b.pass);
    if (!u) return send(res, 401, { error: 'credenziali' });
    TRIES.delete(ip);
    console.log(new Date().toISOString(), 'login', u.name, u.role, ip);
    return send(res, 200, { user: u.name, role: u.role }, { 'Set-Cookie': cookieHeader(makeCookie(u), SESSION_DAYS * 86400) });
  }

  const sess = readSession(req);
  if (!sess) return send(res, 401, { error: 'login' });

  if (p === '/api/logout' && m === 'POST') {
    for (const [k, l] of LOCKS) if (l.sid === sess.sid) LOCKS.delete(k);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
  }
  if (p === '/api/me' && m === 'GET') return send(res, 200, { user: sess.user, role: sess.role });

  // stato visibile al client: elenco partite live + storico + (se richiesta) una partita
  const payload = (mid, sess2, v, sv) => {
    const mt = mid ? MATCHES.get(mid) : null;
    const o = { sqv: DB.sqv, live: liveList(), mid, lock: mid ? lockInfo(mid, sess2) : null, ver: mt ? mt.ver : 0 };
    if (sv !== DB.sqv) o.squads = DB.squads;
    if (mid && !mt) o.gone = true;
    if (mt && v !== mt.ver) o.state = mt.state;
    if (isFull(sess2.role)) o.hist = histSummary();
    return o;
  };
  const mOf = b => { const x = (b && b.m) || url.searchParams.get('m') || ''; return isMid(x) ? x : ''; };

  if (p === '/api/data' && m === 'GET') {
    const v = parseInt(url.searchParams.get('v') || '-1', 10), sv = parseInt(url.searchParams.get('sv') || '-1', 10);
    return send(res, 200, payload(mOf(null), sess, v, sv));
  }

  if (p === '/api/data' && m === 'PUT') {
    const b = await readBody(req, 4 * 1024 * 1024);
    const mid = mOf(b);
    if (b.squads !== undefined && !validSquads(b.squads)) return send(res, 400, { error: 'dati non validi' });
    if (b.state !== undefined && b.state !== null && !validState(b.state)) return send(res, 400, { error: 'dati non validi' });
    if (b.state) {
      if (!mid) return send(res, 400, { error: 'partita' });
      if (heldByOther(mid, sess)) return send(res, 409, { error: 'lock', lock: lockInfo(mid, sess) });
      const cur = MATCHES.get(mid);
      if (cur) {
        if (typeof b.base === 'number' && b.base !== cur.ver) { grant(mid, sess); return send(res, 409, Object.assign({ conflict: true }, payload(mid, sess, -1, DB.sqv))); }
      } else {
        if (typeof b.base === 'number' && b.base !== 0) return send(res, 409, { gone: true, live: liveList() });
        if (!b.state.archived) {
          if (busyTeam(b.state.team, mid)) return send(res, 409, { error: 'team', live: liveList() });
          if (liveList().length >= MAX_LIVE) return send(res, 409, { error: 'max', live: liveList() });
        }
      }
      grant(mid, sess);
      b.state.mid = mid;
      MATCHES.set(mid, { ver: (cur ? cur.ver : 0) + 1, state: b.state, at: Date.now(), by: sess.user });
    }
    if (b.squads !== undefined) {
      if (!isFull(sess.role) && b.squads) { // le soglie (tgt) le imposta solo l'allenatore
        const old = DB.squads || {};
        for (const k of Object.keys(b.squads)) { const q = b.squads[k]; if (q && typeof q === 'object') { if (old[k] && old[k].tgt) q.tgt = old[k].tgt; else delete q.tgt; } }
      }
      DB.sqv++, DB.squads = b.squads;
    }
    DB.at = Date.now(); DB.by = sess.user;
    saveDb();
    const mt = mid ? MATCHES.get(mid) : null;
    return send(res, 200, { ver: mt ? mt.ver : 0, sqv: DB.sqv, lock: mid ? lockInfo(mid, sess) : null, live: liveList() });
  }

  if (p === '/api/lock' && m === 'POST') {
    const b = await readBody(req, 4096);
    const mid = mOf(b);
    if (!mid) return send(res, 400, { error: 'partita' });
    const mine = lockAlive(mid) && LOCKS.get(mid).sid === sess.sid;
    if (b.a === 'get') {
      if (lockAlive(mid) && !mine) return send(res, 200, { ok: false, lock: lockInfo(mid, sess) });
      grant(mid, sess);
      const o = { ok: true, lock: lockInfo(mid, sess) };
      const mt = MATCHES.get(mid);
      if (mt && typeof b.v === 'number' && b.v !== mt.ver) o.data = payload(mid, sess, -1, DB.sqv);
      return send(res, 200, o);
    }
    if (b.a === 'beat') {
      if (!mine) {
        // lock scaduto ma nessun altro lo ha preso: lo riprendiamo
        const l = LOCKS.get(mid);
        if (!lockAlive(mid) && l && l.sid === sess.sid) { grant(mid, sess); return send(res, 200, { ok: true, lock: lockInfo(mid, sess) }); }
        return send(res, 200, { ok: false, lost: true, lock: lockInfo(mid, sess) });
      }
      LOCKS.get(mid).beat = Date.now();
      return send(res, 200, { ok: true, lock: lockInfo(mid, sess) });
    }
    if (b.a === 'release') { if (mine) LOCKS.delete(mid); return send(res, 200, { ok: true, lock: lockInfo(mid, sess) }); }
    if (b.a === 'take') {
      const prev = lockAlive(mid) ? LOCKS.get(mid).u : null;
      grant(mid, sess);
      console.log(new Date().toISOString(), 'take', mid, sess.user, prev ? 'da ' + prev : '');
      return send(res, 200, { ok: true, lock: lockInfo(mid, sess), data: payload(mid, sess, -1, DB.sqv) });
    }
    return send(res, 400, { error: 'azione' });
  }

  if (p === '/api/match' && m === 'POST') {
    const b = await readBody(req, 4096);
    const mid = mOf(b), mt = MATCHES.get(mid);
    if (b.a === 'reopen' && mid) { // riapre una partita dello storico: solo allenatore e solo se non ci sono partite in corso
      if (!isFull(sess.role)) return send(res, 403, { error: 'solo allenatore' });
      const h = HIST.find(x => x.mid === mid);
      if (!h) return send(res, 404, { error: 'non trovata' });
      if (liveList().length) return send(res, 409, { error: 'live', live: liveList() });
      if (heldByOther(mid, sess)) return send(res, 409, { error: 'lock', lock: lockInfo(mid, sess) });
      const cur = MATCHES.get(mid);
      if (cur && cur.state) { cur.state.archived = false; cur.ver++; cur.at = Date.now(); cur.by = sess.user; }
      else {
        const st = { phase: 'match', team: h.team, opp: h.opp, pl: h.pl, sc: h.sc, ev: h.ev, rally: h.rally || [], subs: h.subs || [], maxSet: h.maxSet || 1, set: h.set || 1, date: h.date || '', mid, archived: false, on: [], pick: [], prole: {}, cr: {}, pair: {}, rp: null, so: null, si: null, col: '' };
        if (!validState(st)) return send(res, 400, { error: 'snapshot' });
        MATCHES.set(mid, { ver: 1, state: st, at: Date.now(), by: sess.user });
      }
      grant(mid, sess);
      HIST = HIST.filter(x => x.mid !== mid); writeJson(F_HIST, HIST); saveDb();
      console.log(new Date().toISOString(), 'reopen match', mid, sess.user);
      return send(res, 200, { ok: true, hist: histSummary(), live: liveList() });
    }
    if (b.a !== 'drop' || !mid) return send(res, 400, { error: 'azione' });
    if (!mt) return send(res, 200, { ok: true, live: liveList() });
    if (heldByOther(mid, sess)) return send(res, 409, { error: 'lock', lock: lockInfo(mid, sess) });
    const empty = !(mt.state && Array.isArray(mt.state.ev) && mt.state.ev.length);
    if (!empty && !isFull(sess.role)) return send(res, 403, { error: 'solo allenatore' });
    MATCHES.delete(mid); LOCKS.delete(mid); saveDb();
    console.log(new Date().toISOString(), 'drop match', mid, sess.user);
    return send(res, 200, { ok: true, live: liveList() });
  }

  if (p === '/api/archive' && m === 'POST') {
    const b = await readBody(req, 4 * 1024 * 1024);
    const s = b.snap;
    if (!s || typeof s !== 'object' || !isMid(s.mid) || !Array.isArray(s.pl) || !Array.isArray(s.ev) || !Array.isArray(s.sc)) return send(res, 400, { error: 'snapshot' });
    if (heldByOther(s.mid, sess)) return send(res, 409, { error: 'lock', lock: lockInfo(s.mid, sess) });
    s.at = Date.now();
    HIST = [s].concat(HIST.filter(h => h.mid !== s.mid)).slice(0, MAX_HIST);
    writeJson(F_HIST, HIST);
    const mt = MATCHES.get(s.mid);
    if (mt && mt.state) { mt.state.archived = true; mt.at = Date.now(); saveDb(); }
    return send(res, 200, { ok: true, hist: isFull(sess.role) ? histSummary() : [], live: liveList() });
  }

  const hm = /^\/api\/history\/([^/]+)$/.exec(p);
  if (hm && m === 'GET') {
    if (!isFull(sess.role)) return send(res, 403, { error: 'solo allenatore' });
    const h = HIST.find(x => x.mid === decodeURIComponent(hm[1]));
    if (!h) return send(res, 404, { error: 'non trovata' });
    return send(res, 200, { snap: h });
  }
  if (hm && m === 'DELETE') {
    if (!isFull(sess.role)) return send(res, 403, { error: 'solo allenatore' });
    const mid = decodeURIComponent(hm[1]);
    if (!HIST.some(x => x.mid === mid)) return send(res, 404, { error: 'non trovata' });
    HIST = HIST.filter(x => x.mid !== mid);
    writeJson(F_HIST, HIST);
    console.log(new Date().toISOString(), 'delete history', mid, sess.user);
    return send(res, 200, { ok: true, hist: histSummary() });
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (e) { if (!res.headersSent) send(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, { error: 'errore' }); if (!e.code) console.error(e); }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url.pathname);
});
server.listen(PORT, () => console.log('Scout pallavolo in ascolto sulla porta ' + PORT + ' (dati in ' + DATA + ', utenti: ' + [...USERS.values()].map(u => u.name + '/' + u.role).join(', ') + ')'));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
