// Foxyverse VTT server. Zero dependencies: node:http + node:sqlite + Server-Sent Events.
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { join, dirname, extname, sep, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, UPLOAD_DIR, getSystem, setSystem, loadDefaultSystem } from './db.js';
import { parseCommand, evaluate, evaluateStatic, FormulaError } from './engine.js';
import { validateSystem, defaultActorData, sanitizeActorData, actorContext, pointBudget, executeRoll, applyRoll, castSpell } from './rules.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_UPLOAD = (Number(process.env.UPLOAD_MAX_MB) || 25) * 1024 * 1024;
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const now = () => Date.now();

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Not allowed') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);

// ------------------------------------------------------------------ serializers
const userView = (u) => ({ id: u.id, name: u.name, role: u.role, color: u.color });
const jparse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const sceneView = (s) => ({ id: s.id, name: s.name, image: s.image, width: s.width, height: s.height, grid: s.grid, ox: s.ox, oy: s.oy, active: !!s.active,
  fog: !!s.fog, dark: !!s.dark, walls: jparse(s.walls, []), lights: jparse(s.lights, []), reveal: jparse(s.reveal, []) });
const tokenView = (t) => ({ id: t.id, sceneId: t.scene_id, name: t.name, x: t.x, y: t.y, size: t.size, image: t.image, color: t.color, actorId: t.actor_id, hidden: !!t.hidden, vision: t.vision, light: t.light });
const soundView = (s) => ({ id: s.id, name: s.name, url: s.url, loop: !!s.loop, volume: s.volume });
const journalView = (j) => ({ id: j.id, title: j.title, body: j.body, image: j.image, visibility: jparse(j.visibility, 'gm'), updated: j.updated });
const canSeeJournal = (u, j) => { const v = jparse(j.visibility, 'gm'); return u.role === 'gm' || v === 'all' || (Array.isArray(v) && v.includes(u.id)); };
const compView = (c) => ({ id: c.id, kind: c.kind, name: c.name, data: jparse(c.data, {}) });
const canSeeComp = (u, c) => u.role === 'gm' || c.kind !== 'actor';
const chatView = (m) => ({ id: m.id, userId: m.user_id, userName: m.user_name, actorId: m.actor_id, whisper: m.whisper, body: JSON.parse(m.body), ts: m.ts });
function actorView(row) {
  const sys = getSystem();
  const data = sanitizeActorData(JSON.parse(row.data), sys);
  const c = actorContext(sys, data);
  return { id: row.id, name: row.name, ownerId: row.owner_id, data,
    computed: { stats: c.stats, derived: c.derived, errors: c.errors, pdef: c.pdef, mdef: c.mdef, points: pointBudget(sys, data) } };
}
const canSeeActor = (u, a) => u.role === 'gm' || a.owner_id === u.id;
const canSeeChat = (u, m) => !m.whisper || u.role === 'gm' || m.user_id === u.id;
const getRow = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

// ------------------------------------------------------------------ realtime (SSE)
const clients = new Set();
function broadcast(event, allow = () => true) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) if (allow(c.user)) c.res.write(payload);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25_000).unref();
const pushActor = (row, by) => broadcast({ type: 'actor', op: 'upsert', data: actorView(row), by }, (u) => canSeeActor(u, row));
const sceneActive = (id) => !!getRow('scenes', id)?.active;
const pushToken = (row, by) => {
  const pub = sceneActive(row.scene_id) && !row.hidden;
  broadcast({ type: 'token', op: 'upsert', data: tokenView(row), by }, (u) => u.role === 'gm' || pub);
  if (!pub) broadcast({ type: 'token', op: 'delete', data: { id: row.id }, by }, (u) => u.role !== 'gm');
};
const pushJournal = (row) => { for (const c of clients) c.res.write(`data: ${JSON.stringify(canSeeJournal(c.user, row) ? { type: 'journal', op: 'upsert', data: journalView(row) } : { type: 'journal', op: 'delete', data: { id: row.id } })}\n\n`); };
const pushComp = (row) => broadcast({ type: 'comp', op: 'upsert', data: compView(row) }, (u) => canSeeComp(u, row));
const playing = new Map(); // sound id -> { startedAt }
const pushChat = (row) => broadcast({ type: 'chat', op: 'upsert', data: chatView(row) }, (u) => canSeeChat(u, row));

// ------------------------------------------------------------------ auth
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => scryptSync(pw, salt, 64).toString('hex');
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const ipOf = (req) => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';
const fails = new Map();
const throttled = (ip) => (fails.get(ip)?.until ?? 0) > now();
const noteFail = (ip) => { const f = fails.get(ip) ?? { n: 0 }; f.n++; if (f.n >= 8) { f.until = now() + 5 * 60_000; f.n = 0; } fails.set(ip, f); };

function inviteCode() {
  if (process.env.INVITE_CODE) return process.env.INVITE_CODE;
  let row = db.prepare('SELECT value FROM settings WHERE key = ?').get('invite');
  if (!row) { regenInvite(); row = db.prepare('SELECT value FROM settings WHERE key = ?').get('invite'); }
  return row.value;
}
function regenInvite() {
  const code = randomBytes(5).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('invite', code);
  return code;
}
function startSession(req, res, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run(sha(token), userId, now() + 30 * 864e5);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `fvtt=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
}
function userFromReq(req) {
  const token = parseCookies(req.headers.cookie).fvtt;
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?').get(sha(token), now()) ?? null;
}

// ------------------------------------------------------------------ http helpers
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(new HttpError(413, 'File too large')); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw bad('Expected application/json');
  try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('Invalid JSON'); }
}
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const imgUrl = (v) => (v == null || v === '' ? null : /^\/uploads\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(v) ? v : (() => { throw bad('Invalid image URL'); })());
const color = (v, d = '#eba5ff') => (/^#[0-9a-f]{6}$/i.test(v ?? '') ? v : d);

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, role, handler) => {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, role, handler });
};

// ---- session
route('GET', '/api/me', 'none', ({ user }) => ({ user: user ? userView(user) : null, firstRun: userCount() === 0 }));

route('POST', '/api/register', 'none', async ({ req, res, body }) => {
  const name = String(body.name ?? '').trim(), password = String(body.password ?? '');
  if (!/^[\p{L}\p{N} _.-]{2,24}$/u.test(name)) throw bad('Name: 2-24 letters, digits, spaces, _ . -');
  if (password.length < 8) throw bad('Password needs at least 8 characters');
  const first = userCount() === 0;
  if (!first && String(body.invite ?? '').trim() !== inviteCode()) throw forbidden('Wrong invite code');
  if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) throw bad('That name is taken');
  const salt = randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO users (name, salt, hash, role, created) VALUES (?, ?, ?, ?, ?)').run(name, salt, hashPw(password, salt), first ? 'gm' : 'player', now());
  startSession(req, res, Number(r.lastInsertRowid));
  const u = getRow('users', r.lastInsertRowid);
  broadcast({ type: 'user', op: 'upsert', data: userView(u) });
  return { user: userView(u) };
});

route('POST', '/api/login', 'none', ({ req, res, body }) => {
  const ip = ipOf(req);
  if (throttled(ip)) throw new HttpError(429, 'Too many attempts, wait a few minutes');
  const u = db.prepare('SELECT * FROM users WHERE name = ?').get(String(body.name ?? '').trim());
  const ok = u && timingSafeEqual(Buffer.from(hashPw(String(body.password ?? ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) { noteFail(ip); throw new HttpError(401, 'Wrong name or password'); }
  startSession(req, res, u.id);
  return { user: userView(u) };
});

route('POST', '/api/logout', 'user', ({ req, res }) => {
  const token = parseCookies(req.headers.cookie).fvtt;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(token));
  res.setHeader('Set-Cookie', 'fvtt=; HttpOnly; Path=/; Max-Age=0');
  return { ok: true };
});

// ---- bootstrap state
route('GET', '/api/state', 'user', ({ user }) => {
  const gm = user.role === 'gm';
  const scene = db.prepare('SELECT * FROM scenes WHERE active = 1').get();
  const chat = db.prepare('SELECT * FROM chat ORDER BY id DESC LIMIT 200').all().filter((m) => canSeeChat(user, m)).reverse().slice(-100);
  return {
    me: userView(user),
    users: db.prepare('SELECT * FROM users ORDER BY id').all().map(userView),
    system: getSystem(),
    scene: scene ? sceneView(scene) : null,
    scenes: gm ? db.prepare('SELECT * FROM scenes ORDER BY id').all().map(sceneView) : [],
    tokens: gm ? db.prepare('SELECT * FROM tokens').all().map(tokenView)
      : scene ? db.prepare('SELECT * FROM tokens WHERE scene_id = ?').all(scene.id).filter((t) => !t.hidden).map(tokenView) : [],
    sounds: db.prepare('SELECT * FROM sounds ORDER BY name').all().map(soundView),
    playing: [...playing].map(([id, v]) => ({ id, startedAt: v.startedAt })),
    serverTime: now(),
    journals: db.prepare('SELECT * FROM journals ORDER BY title').all().filter((j) => canSeeJournal(user, j)).map(journalView),
    compendium: db.prepare('SELECT * FROM compendium ORDER BY kind, name').all().filter((c) => canSeeComp(user, c)).map(compView),
    actors: db.prepare('SELECT * FROM actors ORDER BY name').all().filter((a) => canSeeActor(user, a)).map(actorView),
    chat: chat.map(chatView),
    invite: gm ? { code: inviteCode(), fromEnv: !!process.env.INVITE_CODE } : undefined,
  };
});

// ---- users
route('PATCH', '/api/users/:id', 'user', ({ user, params, body }) => {
  const target = getRow('users', params.id);
  if (!target) throw notFound();
  if (target.id !== user.id && user.role !== 'gm') throw forbidden();
  if (body.color) db.prepare('UPDATE users SET color = ? WHERE id = ?').run(color(body.color), target.id);
  if (body.role && user.role === 'gm') {
    if (!['gm', 'player'].includes(body.role)) throw bad('Bad role');
    if (target.role === 'gm' && body.role !== 'gm' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'gm'").get().n < 2) throw bad('There must be at least one GM');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, target.id);
  }
  const u = getRow('users', target.id);
  broadcast({ type: 'user', op: 'upsert', data: userView(u) });
  if (body.role) broadcast({ type: 'refresh' }); // permissions changed
  return userView(u);
});
route('POST', '/api/invite/regenerate', 'gm', () => { if (process.env.INVITE_CODE) throw bad('Invite code is set by INVITE_CODE'); return { code: regenInvite() }; });

// ---- uploads (images for everyone up to 5 MB, larger images and audio for the GM)
const MAX_AUDIO = (Number(process.env.AUDIO_MAX_MB) || 60) * 1024 * 1024;
const MAX_PLAYER_IMG = 5 * 1024 * 1024;
const MEDIA = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/webm': 'webm',
};
const SNIFF = {
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.toString('latin1', 0, 4) === 'GIF8', webp: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  mp3: (b) => b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0), ogg: (b) => b.toString('latin1', 0, 4) === 'OggS',
  wav: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE', m4a: (b) => b.toString('latin1', 4, 8) === 'ftyp',
  flac: (b) => b.toString('latin1', 0, 4) === 'fLaC', webm: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
};
route('POST', '/api/upload', 'user', async ({ req, user }) => {
  const ext = MEDIA[(req.headers['content-type'] || '').split(';')[0]];
  if (!ext) throw bad('Unsupported file type (PNG, JPEG, WebP, GIF, MP3, OGG, WAV, M4A, FLAC, WebM)');
  const audio = !['png', 'jpg', 'webp', 'gif'].includes(ext);
  if (user.role !== 'gm' && audio) throw forbidden('Only the GM uploads audio');
  const buf = await readBody(req, user.role !== 'gm' ? MAX_PLAYER_IMG : audio ? MAX_AUDIO : MAX_UPLOAD);
  if (!SNIFF[ext](buf)) throw bad('File content does not match its type');
  const name = `${createHash('sha256').update(buf).digest('hex')}.${ext}`;
  if (!existsSync(join(UPLOAD_DIR, name))) writeFileSync(join(UPLOAD_DIR, name), buf);
  return { url: `/uploads/${name}`, kind: audio ? 'audio' : 'image' };
});

// ---- scenes
const fin = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
const cleanWalls = (a) => (Array.isArray(a) ? a.slice(0, 4000).filter(Array.isArray).map((w) => [fin(w[0]), fin(w[1]), fin(w[2]), fin(w[3]), w[4] ? 1 : 0, w[5] ? 1 : 0]) : []);
const cleanLights = (a) => (Array.isArray(a) ? a.slice(0, 300).map((l) => ({ id: String(l?.id || randomBytes(3).toString('hex')).slice(0, 12), x: fin(l?.x), y: fin(l?.y), radius: Math.min(100, Math.max(0, fin(l?.radius))) })) : []);
const cleanReveal = (a) => (Array.isArray(a) ? a.slice(0, 500).filter(Array.isArray).map((r) => [fin(r[0]), fin(r[1]), Math.abs(fin(r[2])), Math.abs(fin(r[3]))]) : []);
const sceneFields = (b, cur = {}) => ({
  fog: b.fog !== undefined ? (b.fog ? 1 : 0) : cur.fog ?? 0, dark: b.dark !== undefined ? (b.dark ? 1 : 0) : cur.dark ?? 0,
  walls: b.walls !== undefined ? JSON.stringify(cleanWalls(b.walls)) : cur.walls ?? '[]',
  lights: b.lights !== undefined ? JSON.stringify(cleanLights(b.lights)) : cur.lights ?? '[]',
  reveal: b.reveal !== undefined ? JSON.stringify(cleanReveal(b.reveal)) : cur.reveal ?? '[]',
  name: String(b.name ?? cur.name ?? 'Scene').slice(0, 80) || 'Scene',
  image: b.image !== undefined ? imgUrl(b.image) : cur.image ?? null,
  width: Math.max(0, Math.trunc(num(b.width, cur.width ?? 0))), height: Math.max(0, Math.trunc(num(b.height, cur.height ?? 0))),
  grid: Math.min(500, Math.max(10, Math.trunc(num(b.grid, cur.grid ?? 70)))),
  ox: Math.trunc(num(b.ox, cur.ox ?? 0)), oy: Math.trunc(num(b.oy, cur.oy ?? 0)),
});
route('POST', '/api/scenes', 'gm', ({ body }) => {
  const f = sceneFields(body);
  const first = !db.prepare('SELECT 1 FROM scenes').get();
  const r = db.prepare('INSERT INTO scenes (name, image, width, height, grid, ox, oy, active, created, fog, dark, walls, lights, reveal) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.name, f.image, f.width, f.height, f.grid, f.ox, f.oy, first ? 1 : 0, now(), f.fog, f.dark, f.walls, f.lights, f.reveal);
  if (first) broadcast({ type: 'refresh' });
  return sceneView(getRow('scenes', r.lastInsertRowid));
});
route('PATCH', '/api/scenes/:id', 'gm', ({ params, body }) => {
  const cur = getRow('scenes', params.id); if (!cur) throw notFound();
  const f = sceneFields(body, cur);
  db.prepare('UPDATE scenes SET name=?, image=?, width=?, height=?, grid=?, ox=?, oy=?, fog=?, dark=?, walls=?, lights=?, reveal=? WHERE id=?').run(f.name, f.image, f.width, f.height, f.grid, f.ox, f.oy, f.fog, f.dark, f.walls, f.lights, f.reveal, cur.id);
  const row = getRow('scenes', cur.id);
  broadcast({ type: 'scene', op: 'upsert', data: sceneView(row) }, (u) => u.role === 'gm' || !!row.active);
  return sceneView(row);
});
route('POST', '/api/scenes/:id/activate', 'gm', ({ params }) => {
  if (!getRow('scenes', params.id)) throw notFound();
  db.exec('UPDATE scenes SET active = 0'); db.prepare('UPDATE scenes SET active = 1 WHERE id = ?').run(params.id);
  broadcast({ type: 'refresh' });
  return { ok: true };
});
route('DELETE', '/api/scenes/:id', 'gm', ({ params }) => {
  db.prepare('DELETE FROM scenes WHERE id = ?').run(params.id);
  broadcast({ type: 'refresh' });
  return { ok: true };
});

// ---- tokens
route('POST', '/api/tokens', 'gm', ({ user, body }) => {
  const scene = getRow('scenes', body.sceneId); if (!scene) throw bad('Unknown scene');
  const actor = body.actorId ? getRow('actors', body.actorId) : null;
  const portrait = actor ? jparse(actor.data, {}).portrait || null : null;
  const r = db.prepare('INSERT INTO tokens (scene_id, name, x, y, size, image, color, actor_id, hidden, vision, light) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    scene.id, String(body.name ?? actor?.name ?? 'Token').slice(0, 60), num(body.x, scene.width / 2), num(body.y, scene.height / 2),
    Math.min(10, Math.max(0.25, num(body.size, 1))), imgUrl(body.image) ?? portrait, color(body.color), actor?.id ?? null, body.hidden ? 1 : 0,
    Math.min(100, Math.max(0, num(body.vision, 0))), Math.min(100, Math.max(0, num(body.light, 0))));
  const row = getRow('tokens', r.lastInsertRowid);
  pushToken(row, user.id);
  return tokenView(row);
});
route('PATCH', '/api/tokens/:id', 'user', ({ user, params, body }) => {
  const cur = getRow('tokens', params.id); if (!cur) throw notFound();
  const actor = cur.actor_id ? getRow('actors', cur.actor_id) : null;
  const gm = user.role === 'gm';
  if (!gm && !(actor && actor.owner_id === user.id && !cur.hidden)) throw forbidden();
  const n = { x: num(body.x, cur.x), y: num(body.y, cur.y), image: body.image !== undefined ? imgUrl(body.image) : cur.image };
  if (gm) {
    n.name = body.name !== undefined ? String(body.name).slice(0, 60) : cur.name;
    n.size = body.size !== undefined ? Math.min(10, Math.max(0.25, num(body.size, 1))) : cur.size;
    n.vision = body.vision !== undefined ? Math.min(100, Math.max(0, num(body.vision, 0))) : cur.vision;
    n.light = body.light !== undefined ? Math.min(100, Math.max(0, num(body.light, 0))) : cur.light;
    n.color = body.color !== undefined ? color(body.color) : cur.color;
    n.hidden = body.hidden !== undefined ? (body.hidden ? 1 : 0) : cur.hidden;
    n.actor_id = body.actorId !== undefined ? (body.actorId && getRow('actors', body.actorId) ? Number(body.actorId) : null) : cur.actor_id;
  }
  const m = { ...cur, ...n };
  db.prepare('UPDATE tokens SET name=?, x=?, y=?, size=?, image=?, color=?, actor_id=?, hidden=?, vision=?, light=? WHERE id=?').run(m.name, m.x, m.y, m.size, m.image, m.color, m.actor_id, m.hidden, m.vision, m.light, cur.id);
  const row = getRow('tokens', cur.id);
  pushToken(row, user.id);
  return tokenView(row);
});
route('DELETE', '/api/tokens/:id', 'gm', ({ params, user }) => {
  const row = getRow('tokens', params.id); if (!row) throw notFound();
  const pub = sceneActive(row.scene_id);
  db.prepare('DELETE FROM tokens WHERE id = ?').run(params.id);
  broadcast({ type: 'token', op: 'delete', data: { id: Number(params.id) }, by: user.id }, (u) => u.role === 'gm' || pub);
  return { ok: true };
});

// ---- actors
route('POST', '/api/actors', 'user', ({ user, body }) => {
  const sys = getSystem();
  const owner = user.role === 'gm' && body.ownerId !== undefined ? (getRow('users', body.ownerId)?.id ?? null) : user.id;
  const data = body.data ? sanitizeActorData(body.data, sys) : defaultActorData(sys);
  const t = now();
  const r = db.prepare('INSERT INTO actors (name, owner_id, data, created, updated) VALUES (?,?,?,?,?)').run(String(body.name ?? 'New character').slice(0, 80), owner, JSON.stringify(data), t, t);
  const row = getRow('actors', r.lastInsertRowid);
  pushActor(row, user.id);
  return actorView(row);
});
function editableActor(user, id) {
  const row = getRow('actors', id); if (!row) throw notFound();
  if (user.role !== 'gm' && row.owner_id !== user.id) throw forbidden();
  return row;
}
route('PATCH', '/api/actors/:id', 'user', ({ user, params, body }) => {
  const cur = editableActor(user, params.id), sys = getSystem();
  const name = body.name !== undefined ? String(body.name).slice(0, 80) || cur.name : cur.name;
  const data = body.data ? sanitizeActorData(body.data, sys) : JSON.parse(cur.data);
  const owner = user.role === 'gm' && body.ownerId !== undefined ? (getRow('users', body.ownerId)?.id ?? null) : cur.owner_id;
  db.prepare('UPDATE actors SET name=?, owner_id=?, data=?, updated=? WHERE id=?').run(name, owner, JSON.stringify(data), now(), cur.id);
  const row = getRow('actors', cur.id);
  pushActor(row, user.id);
  const oldPortrait = jparse(cur.data, {}).portrait || null, newPortrait = data.portrait || null;
  if (body.data && oldPortrait !== newPortrait) {
    db.prepare('UPDATE tokens SET image = ? WHERE actor_id = ?').run(newPortrait, cur.id);
    for (const t of db.prepare('SELECT * FROM tokens WHERE actor_id = ?').all(cur.id)) pushToken(t, user.id);
  }
  if (owner !== cur.owner_id) broadcast({ type: 'refresh' });
  return actorView(row);
});
route('DELETE', '/api/actors/:id', 'user', ({ user, params }) => {
  const cur = editableActor(user, params.id);
  db.prepare('DELETE FROM actors WHERE id = ?').run(cur.id);
  broadcast({ type: 'actor', op: 'delete', data: { id: cur.id } });
  return { ok: true };
});
route('POST', '/api/actors/:id/cast', 'user', ({ user, params, body }) => {
  const cur = editableActor(user, params.id), sys = getSystem();
  const { data, spell, mpSpent, hpSpent } = castSpell(sys, sanitizeActorData(JSON.parse(cur.data), sys), body.spellId);
  db.prepare('UPDATE actors SET data=?, updated=? WHERE id=?').run(JSON.stringify(data), now(), cur.id);
  const row = getRow('actors', cur.id);
  pushActor(row, user.id);
  const cost = [mpSpent && `${mpSpent} mana`, hpSpent && `${hpSpent} HP`].filter(Boolean).join(' + ') || 'free';
  postChat(user, cur.id, null, { t: 'info', text: `${cur.name} casts ${spell.name} (${cost})${spell.armed ? ' [armed]' : ''}` });
  return actorView(row);
});

// ---- chat & rolls
function postChat(user, actorId, whisper, body) {
  const r = db.prepare('INSERT INTO chat (user_id, user_name, actor_id, whisper, body, ts) VALUES (?,?,?,?,?,?)').run(user.id, user.name, actorId ?? null, whisper, JSON.stringify(body), now());
  const row = getRow('chat', r.lastInsertRowid);
  pushChat(row);
  return row;
}
function actorForRoll(user, actorId) {
  if (!actorId) return null;
  const row = getRow('actors', actorId); if (!row) throw bad('Unknown character');
  if (user.role !== 'gm' && row.owner_id !== user.id) throw forbidden('That is not your character');
  return row;
}
route('POST', '/api/chat', 'user', ({ user, body }) => {
  let text = String(body.text ?? '').trim().slice(0, 2000);
  if (!text) throw bad('Empty message');
  let whisper = null;
  if (/^\/gm\s/i.test(text)) { whisper = 'gm'; text = text.slice(4).trim(); }
  const sys = getSystem();
  if (text.startsWith('/')) {
    const cmd = parseCommand(text); if (!cmd) throw bad('Bad command');
    const actor = actorForRoll(user, body.actorId);
    let result;
    try { result = executeRoll(sys, cmd, actor ? sanitizeActorData(JSON.parse(actor.data), sys) : null); }
    catch (e) { if (e instanceof FormulaError || e instanceof Error) throw bad(e.message); throw e; }
    const name = actor?.name ?? user.name;
    return chatView(postChat(user, actor?.id, whisper, { t: 'roll', actorName: name, ...result }));
  }
  return chatView(postChat(user, body.actorId ? actorForRoll(user, body.actorId)?.id : null, whisper, { t: 'text', text }));
});

route('POST', '/api/chat/:id/reroll', 'user', ({ user, params }) => {
  const msg = getRow('chat', params.id); if (!msg || !canSeeChat(user, msg)) throw notFound();
  const body = JSON.parse(msg.body);
  if (body.t !== 'roll') throw bad('Only rolls can be rerolled');
  if (user.role !== 'gm' && msg.user_id !== user.id) throw forbidden();
  const sys = getSystem();
  const actorRow = msg.actor_id ? getRow('actors', msg.actor_id) : null;
  let data = actorRow ? sanitizeActorData(JSON.parse(actorRow.data), sys) : null;
  if (user.role !== 'gm') { // players pay a favor; the GM rerolls freely
    if (!actorRow) throw bad('No character on this roll to pay the favor');
    if (data.fav.cur < 1) throw bad('No favor left');
    data.fav.cur -= 1;
  }
  const result = executeRoll(sys, body.cmd, data);
  const next = { ...body, ...result, rerolls: (body.rerolls ?? 0) + 1, history: [...(body.history ?? []), body.sum], applied: [] };
  db.prepare('UPDATE chat SET body = ? WHERE id = ?').run(JSON.stringify(next), msg.id);
  if (user.role !== 'gm') { db.prepare('UPDATE actors SET data=?, updated=? WHERE id=?').run(JSON.stringify(data), now(), actorRow.id); pushActor(getRow('actors', actorRow.id), user.id); }
  const row = getRow('chat', msg.id); pushChat(row);
  return chatView(row);
});

route('POST', '/api/chat/:id/apply', 'user', ({ user, params, body }) => {
  const msg = getRow('chat', params.id); if (!msg || !canSeeChat(user, msg)) throw notFound();
  const roll = JSON.parse(msg.body);
  if (roll.t !== 'roll' || !['damage', 'heal', 'theal', 'mana'].includes(roll.kind)) throw bad('Nothing to apply');
  const sys = getSystem(), gm = user.role === 'gm';
  const targets = [];
  const ids = Array.isArray(body.tokenIds) ? body.tokenIds.slice(0, 50) : [];
  if (ids.length) {
    if (!gm) throw forbidden('Only the GM applies effects to tokens');
    for (const id of ids) {
      const t = getRow('tokens', id); const a = t?.actor_id ? getRow('actors', t.actor_id) : null;
      targets.push({ name: t?.name ?? '?', tokenId: t?.id ?? null, actor: a });
    }
  } else {
    const a = msg.actor_id ? getRow('actors', msg.actor_id) : null;
    if (!a || roll.kind === 'damage' || (!gm && a.owner_id !== user.id)) throw bad('Select a target token first');
    targets.push({ name: a.name, tokenId: null, actor: a });
  }
  roll.applied ??= [];
  for (const tg of targets) {
    if (!tg.actor) { roll.applied.push({ name: tg.name, note: 'no character linked' }); continue; }
    if (roll.applied.some((x) => x.actorId === tg.actor.id)) { roll.applied.push({ name: tg.name, note: 'already applied' }); continue; }
    const { data, report } = applyRoll(sys, sanitizeActorData(JSON.parse(tg.actor.data), sys), roll);
    db.prepare('UPDATE actors SET data=?, updated=? WHERE id=?').run(JSON.stringify(data), now(), tg.actor.id);
    pushActor(getRow('actors', tg.actor.id), user.id);
    roll.applied.push({ name: tg.name, actorId: tg.actor.id, ...report });
  }
  db.prepare('UPDATE chat SET body = ? WHERE id = ?').run(JSON.stringify(roll), msg.id);
  const row = getRow('chat', msg.id); pushChat(row);
  return chatView(row);
});

route('DELETE', '/api/chat/:id', 'gm', ({ params }) => {
  db.prepare('DELETE FROM chat WHERE id = ?').run(params.id);
  broadcast({ type: 'chat', op: 'delete', data: { id: Number(params.id) } });
  return { ok: true };
});

// ---- system editor
route('GET', '/api/system', 'user', () => getSystem());
route('PUT', '/api/system', 'gm', ({ body }) => {
  let sys; try { sys = validateSystem(body); } catch (e) { throw bad(e.message); }
  setSystem(sys); broadcast({ type: 'refresh' });
  return sys;
});
route('POST', '/api/system/reset', 'gm', () => { const sys = loadDefaultSystem(); setSystem(sys); broadcast({ type: 'refresh' }); return sys; });
route('POST', '/api/system/test', 'gm', ({ body }) => {
  const sys = getSystem();
  const row = body.actorId ? getRow('actors', body.actorId) : db.prepare('SELECT * FROM actors LIMIT 1').get();
  const vars = row ? actorContext(sys, sanitizeActorData(JSON.parse(row.data), sys)).vars : {};
  try {
    const r = body.dice ? evaluate(String(body.formula), vars) : { total: evaluateStatic(String(body.formula), vars), dice: [] };
    return { ok: true, total: r.total, dice: r.dice, success: r.success, target: r.target, actor: row?.name ?? null };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- audio
const audioUrl = (v) => (/^\/uploads\/[a-f0-9]{64}\.(mp3|ogg|wav|m4a|flac|webm)$/.test(v ?? '') ? v : (() => { throw bad('Invalid audio URL'); })());
route('POST', '/api/sounds', 'gm', ({ body }) => {
  const r = db.prepare('INSERT INTO sounds (name, url, loop, volume, created) VALUES (?,?,?,?,?)').run(String(body.name ?? 'Sound').slice(0, 80) || 'Sound', audioUrl(body.url), body.loop ? 1 : 0, Math.min(1, Math.max(0, num(body.volume, 1))), now());
  const row = getRow('sounds', r.lastInsertRowid);
  broadcast({ type: 'sound', op: 'upsert', data: soundView(row) });
  return soundView(row);
});
route('PATCH', '/api/sounds/:id', 'gm', ({ params, body }) => {
  const cur = getRow('sounds', params.id); if (!cur) throw notFound();
  db.prepare('UPDATE sounds SET name=?, loop=?, volume=? WHERE id=?').run(body.name !== undefined ? String(body.name).slice(0, 80) : cur.name, body.loop !== undefined ? (body.loop ? 1 : 0) : cur.loop,
    body.volume !== undefined ? Math.min(1, Math.max(0, num(body.volume, 1))) : cur.volume, cur.id);
  const row = getRow('sounds', cur.id);
  broadcast({ type: 'sound', op: 'upsert', data: soundView(row) });
  return soundView(row);
});
route('DELETE', '/api/sounds/:id', 'gm', ({ params }) => {
  const id = Number(params.id);
  db.prepare('DELETE FROM sounds WHERE id = ?').run(id);
  if (playing.delete(id)) broadcast({ type: 'audio', op: 'stop', id });
  broadcast({ type: 'sound', op: 'delete', data: { id } });
  return { ok: true };
});
route('POST', '/api/sounds/:id/play', 'gm', ({ params }) => {
  const s = getRow('sounds', params.id); if (!s) throw notFound();
  const startedAt = now(); playing.set(s.id, { startedAt });
  if (!s.loop) setTimeout(() => { if (playing.get(s.id)?.startedAt === startedAt) playing.delete(s.id); }, 15 * 60_000).unref();
  broadcast({ type: 'audio', op: 'play', id: s.id, startedAt });
  return { ok: true, startedAt };
});
route('POST', '/api/sounds/:id/stop', 'gm', ({ params }) => { const id = Number(params.id); playing.delete(id); broadcast({ type: 'audio', op: 'stop', id }); return { ok: true }; });
route('POST', '/api/audio/stop', 'gm', () => { playing.clear(); broadcast({ type: 'audio', op: 'stopall' }); return { ok: true }; });

// ---- journal & handouts
const cleanVis = (v) => (v === 'all' ? 'all' : Array.isArray(v) ? v.map(Number).filter(Number.isInteger).slice(0, 100) : 'gm');
route('POST', '/api/journals', 'gm', ({ body }) => {
  const t = now();
  const r = db.prepare('INSERT INTO journals (title, body, image, visibility, created, updated) VALUES (?,?,?,?,?,?)').run(String(body.title ?? 'Untitled').slice(0, 120) || 'Untitled', String(body.body ?? '').slice(0, 50000), imgUrl(body.image), JSON.stringify(cleanVis(body.visibility)), t, t);
  const row = getRow('journals', r.lastInsertRowid); pushJournal(row);
  return journalView(row);
});
route('PATCH', '/api/journals/:id', 'gm', ({ params, body }) => {
  const cur = getRow('journals', params.id); if (!cur) throw notFound();
  db.prepare('UPDATE journals SET title=?, body=?, image=?, visibility=?, updated=? WHERE id=?').run(
    body.title !== undefined ? String(body.title).slice(0, 120) || cur.title : cur.title, body.body !== undefined ? String(body.body).slice(0, 50000) : cur.body,
    body.image !== undefined ? imgUrl(body.image) : cur.image, body.visibility !== undefined ? JSON.stringify(cleanVis(body.visibility)) : cur.visibility, now(), cur.id);
  const row = getRow('journals', cur.id); pushJournal(row);
  return journalView(row);
});
route('DELETE', '/api/journals/:id', 'gm', ({ params }) => {
  db.prepare('DELETE FROM journals WHERE id = ?').run(params.id);
  broadcast({ type: 'journal', op: 'delete', data: { id: Number(params.id) } });
  return { ok: true };
});
route('POST', '/api/journals/:id/show', 'gm', ({ params }) => {
  let row = getRow('journals', params.id); if (!row) throw notFound();
  if (jparse(row.visibility, 'gm') === 'gm') { db.prepare('UPDATE journals SET visibility = ? WHERE id = ?').run('"all"', row.id); row = getRow('journals', row.id); }
  pushJournal(row);
  broadcast({ type: 'show', id: row.id }, (u) => canSeeJournal(u, row));
  return journalView(row);
});

// ---- compendium (reusable items, spells, talents and NPC templates)
const COMP_KINDS = ['item', 'spell', 'talent', 'actor'];
function cleanComp(kind, data) {
  const sys = getSystem();
  if (kind === 'actor') return sanitizeActorData(data, sys);
  const key = { item: 'items', spell: 'spells', talent: 'talents' }[kind];
  const e = sanitizeActorData({ [key]: [data] }, sys)[key][0];
  if (!e) throw bad('Bad entry');
  delete e.id;
  return e;
}
route('POST', '/api/compendium', 'gm', ({ body }) => {
  if (!COMP_KINDS.includes(body.kind)) throw bad('Bad kind');
  const r = db.prepare('INSERT INTO compendium (kind, name, data, created) VALUES (?,?,?,?)').run(body.kind, String(body.name ?? 'Entry').slice(0, 80) || 'Entry', JSON.stringify(cleanComp(body.kind, body.data ?? {})), now());
  const row = getRow('compendium', r.lastInsertRowid); pushComp(row);
  return compView(row);
});
route('PATCH', '/api/compendium/:id', 'gm', ({ params, body }) => {
  const cur = getRow('compendium', params.id); if (!cur) throw notFound();
  db.prepare('UPDATE compendium SET name=?, data=? WHERE id=?').run(body.name !== undefined ? String(body.name).slice(0, 80) || cur.name : cur.name, body.data ? JSON.stringify(cleanComp(cur.kind, body.data)) : cur.data, cur.id);
  const row = getRow('compendium', cur.id); pushComp(row);
  return compView(row);
});
route('DELETE', '/api/compendium/:id', 'gm', ({ params }) => {
  db.prepare('DELETE FROM compendium WHERE id = ?').run(params.id);
  broadcast({ type: 'comp', op: 'delete', data: { id: Number(params.id) } });
  return { ok: true };
});
route('POST', '/api/compendium/:id/instantiate', 'gm', ({ user, params, body }) => {
  const c = getRow('compendium', params.id); if (!c || c.kind !== 'actor') throw bad('Only actor templates can be instantiated');
  const t = now();
  const r = db.prepare('INSERT INTO actors (name, owner_id, data, created, updated) VALUES (?,?,?,?,?)').run(String(body.name ?? c.name).slice(0, 80), body.ownerId ? (getRow('users', body.ownerId)?.id ?? null) : null, c.data, t, t);
  const actor = getRow('actors', r.lastInsertRowid); pushActor(actor, user.id);
  const scene = body.sceneId ? getRow('scenes', body.sceneId) : null;
  if (scene) {
    const portrait = jparse(actor.data, {}).portrait || null;
    const tr = db.prepare('INSERT INTO tokens (scene_id, name, x, y, size, image, color, actor_id, hidden, vision, light) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(scene.id, actor.name, num(body.x, scene.width / 2), num(body.y, scene.height / 2), 1, portrait, '#eba5ff', actor.id, 0, 0, 0);
    pushToken(getRow('tokens', tr.lastInsertRowid), user.id);
  }
  return actorView(actor);
});

// ------------------------------------------------------------------ server
const TYPES = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.webm': 'audio/webm', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon' };
function sendFile(req, res, file, extra = {}) {
  let st; try { st = statSync(file); if (!st.isFile()) throw 0; } catch { res.writeHead(404); return res.end('Not found'); }
  const base = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', ...extra };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ''); // audio seeking (and Safari) needs Range support
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2])), end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': st.size });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && path.startsWith('/uploads/')) {
      const name = path.slice(9);
      if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif|mp3|ogg|wav|m4a|flac|webm)$/.test(name)) throw notFound();
      return sendFile(req, res, join(UPLOAD_DIR, name), { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    if (path.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw forbidden('Cross-origin request blocked');
      const user = userFromReq(req);
      if (req.method === 'GET' && path === '/api/events') {
        if (!user) throw new HttpError(401, 'Sign in first');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        const client = { res, user }; clients.add(client);
        req.on('close', () => clients.delete(client));
        return;
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(path); if (!m) continue;
        if (r.role !== 'none' && !user) throw new HttpError(401, 'Sign in first');
        if (r.role === 'gm' && user.role !== 'gm') throw forbidden('GM only');
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = req.method === 'GET' || req.method === 'DELETE' || path === '/api/upload' ? {} : await readJson(req);
        const out = await r.handler({ req, res, user, params, body });
        return json(res, 200, out);
      }
      throw notFound('Unknown endpoint');
    }
    // static client
    if (req.method !== 'GET') throw notFound();
    const rel = normalize(path === '/' ? '/index.html' : path);
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + sep)) throw notFound();
    return sendFile(req, res, file, { 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) {
      if (e.status === 413) { res.setHeader('Connection', 'close'); res.on('finish', () => req.socket.destroy()); } // stop an oversized upload after replying
      return json(res, e.status, { error: e.message });
    }
    console.error(e);
    return json(res, 500, { error: 'Server error' });
  }
});

db.prepare('DELETE FROM sessions WHERE expires < ?').run(now());
getSystem(); inviteCode();
server.listen(PORT, HOST, () => {
  console.log(`Foxyverse VTT listening on http://${HOST}:${PORT}`);
  if (userCount() === 0) console.log('No accounts yet: the first person to register becomes the GM.');
  else console.log(`Invite code for new players: ${inviteCode()}`);
});
const stop = () => { server.close(); db.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
