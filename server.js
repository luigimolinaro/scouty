'use strict';
/*
 * Scout pallavolo - server (Node.js, nessuna dipendenza esterna)
 * - login con ruoli: coach (allenatore) e scout
 * - stato partita e squadre condivisi
 * - blocco "chi sta facendo scout" con heartbeat
 * - storico delle ultime 3 partite
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
const MAX_HIST = parseInt(process.env.HISTORY_SIZE || '3', 10);
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
let DB = readJson(F_DATA, { ver: 0, state: null, squads: null, at: 0, by: '' });
let HIST = readJson(F_HIST, []);
if (!Array.isArray(HIST)) HIST = [];

/* ---------- blocco scout ---------- */
let LOCK = null; // {sid,u,r,since,beat}
const lockAlive = () => !!LOCK && Date.now() - LOCK.beat < LOCK_TTL;
function lockInfo(sess) {
  if (!lockAlive()) return null;
  return { u: LOCK.u, r: LOCK.r, since: LOCK.since, alive: true, mine: !!sess && LOCK.sid === sess.sid };
}
function grant(sess) {
  const keep = lockAlive() && LOCK.sid === sess.sid;
  LOCK = { sid: sess.sid, u: sess.user, r: sess.role, since: keep ? LOCK.since : Date.now(), beat: Date.now() };
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
function dataPayload(sess) {
  const o = { ver: DB.ver, state: DB.state, squads: DB.squads, lock: lockInfo(sess) };
  if (isFull(sess.role)) o.hist = histSummary();
  return o;
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
    if (lockAlive() && LOCK.sid === sess.sid) LOCK = null;
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
  }
  if (p === '/api/me' && m === 'GET') return send(res, 200, { user: sess.user, role: sess.role });

  if (p === '/api/data' && m === 'GET') {
    const v = parseInt(url.searchParams.get('v') || '-1', 10);
    if (v === DB.ver) { const o = { ver: DB.ver, same: true, lock: lockInfo(sess) }; if (isFull(sess.role)) o.hist = histSummary(); return send(res, 200, o); }
    return send(res, 200, dataPayload(sess));
  }

  if (p === '/api/data' && m === 'PUT') {
    const b = await readBody(req, 4 * 1024 * 1024);
    if (lockAlive() && LOCK.sid !== sess.sid) return send(res, 409, { error: 'lock', lock: lockInfo(sess) });
    if (typeof b.base === 'number' && b.base !== DB.ver) { grant(sess); return send(res, 409, Object.assign({ conflict: true }, dataPayload(sess))); }
    if (!validState(b.state) || !validSquads(b.squads)) return send(res, 400, { error: 'dati non validi' });
    grant(sess);
    DB = { ver: DB.ver + 1, state: b.state, squads: b.squads, at: Date.now(), by: sess.user };
    writeJson(F_DATA, DB);
    return send(res, 200, { ver: DB.ver, lock: lockInfo(sess) });
  }

  if (p === '/api/lock' && m === 'POST') {
    const b = await readBody(req, 4096);
    const mine = lockAlive() && LOCK.sid === sess.sid;
    if (b.a === 'get') {
      if (lockAlive() && !mine) return send(res, 200, { ok: false, lock: lockInfo(sess) });
      grant(sess);
      const o = { ok: true, lock: lockInfo(sess) };
      if (typeof b.v === 'number' && b.v !== DB.ver) o.data = dataPayload(sess);
      return send(res, 200, o);
    }
    if (b.a === 'beat') {
      if (!mine) {
        // lock scaduto ma nessun altro lo ha preso: lo riprendiamo
        if (!lockAlive() && LOCK && LOCK.sid === sess.sid) { grant(sess); return send(res, 200, { ok: true, lock: lockInfo(sess) }); }
        return send(res, 200, { ok: false, lost: true, lock: lockInfo(sess) });
      }
      LOCK.beat = Date.now();
      return send(res, 200, { ok: true, lock: lockInfo(sess) });
    }
    if (b.a === 'release') { if (mine) LOCK = null; return send(res, 200, { ok: true, lock: lockInfo(sess) }); }
    if (b.a === 'take') {
      const prev = lockAlive() ? LOCK.u : null;
      grant(sess);
      console.log(new Date().toISOString(), 'take', sess.user, prev ? 'da ' + prev : '');
      return send(res, 200, { ok: true, lock: lockInfo(sess), data: dataPayload(sess) });
    }
    return send(res, 400, { error: 'azione' });
  }

  if (p === '/api/archive' && m === 'POST') {
    const b = await readBody(req, 4 * 1024 * 1024);
    if (lockAlive() && LOCK.sid !== sess.sid) return send(res, 409, { error: 'lock', lock: lockInfo(sess) });
    const s = b.snap;
    if (!s || typeof s !== 'object' || !s.mid || !Array.isArray(s.pl) || !Array.isArray(s.ev) || !Array.isArray(s.sc)) return send(res, 400, { error: 'snapshot' });
    s.mid = String(s.mid).slice(0, 40); s.at = Date.now();
    HIST = [s].concat(HIST.filter(h => h.mid !== s.mid)).slice(0, MAX_HIST);
    writeJson(F_HIST, HIST);
    return send(res, 200, { ok: true, hist: isFull(sess.role) ? histSummary() : [] });
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
    if (lockAlive() && LOCK.sid !== sess.sid) return send(res, 409, { error: 'lock', lock: lockInfo(sess) });
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
