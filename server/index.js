// Foxyverse VTT server. Zero dependencies: node:http + node:sqlite + Server-Sent Events.
//
// Two doors, told apart by URL path (a reverse proxy such as Caddy + Authelia guards the second one):
//   /api/...        players: list of tables, pick a player slot, then play at /api/t/<slug>/... with player rights only
//   /admin/api/...  the GM: every table (/admin/api/t/<slug>/...), the map library, table management.
// The app has no GM accounts: whoever reaches /admin is the GM. ADMIN_SECRET makes sure nobody reaches it around the proxy.
import { createServer } from 'node:http';
import { existsSync, writeFileSync, createReadStream, createWriteStream, statSync, readdirSync, readFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, extname, sep, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { db, UPLOAD_DIR, DATA_DIR, getSystem, setSystem, forgetSystem, loadDefaultSystem } from './db.js';
import { parseCommand, evaluate, evaluateStatic, FormulaError } from './engine.js';
import { validateSystem, defaultActorData, sanitizeActorData, actorContext, pointBudget, executeRoll, applyRoll, castSpell, undoApply, tokenImage, resourceMaxes, followMax, fillResources } from './rules.js';
import { logServerError } from './log.js';
import { diffSystems } from './sysdiff.js';
import { parseNarration, uniqueAlias, aliasFrom, NARRATOR } from './narration.js';
import { normWall, moveBlocked, radiusStep, W } from '../public/walls.js';
import { exploreDims } from '../public/vision.js';
import { ghostStart } from '../public/tp.js';
import { youtubeId, youtubeUrl } from '../public/media.js';
import { cleanGroup, cleanTags } from '../public/sounds.js';
import { zipWriter, openZip, ZipError } from './zip.js';

const PORT = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 3000; // 0: any free port (tests)
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = (Number(process.env.UPLOAD_MAX_MB) || 25) * 1024 * 1024;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const GRACE = Number(process.env.SLOT_GRACE_MS) || 60_000; // a player slot stays taken this long after its page closed (reload, network blip)
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const now = () => Date.now();
const GM = Object.freeze({ id: 0, name: 'MJ', role: 'gm', color: '#ff9a4d' });

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Not allowed') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const STREAM = Symbol('stream'); // a handler that took over the response (Server-Sent Events)

// ------------------------------------------------------------------ helpers & serializers
const jparse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const idOf = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : -1);
const getRow = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(idOf(id));
const inTable = (table, id, tableId) => { const r = getRow(table, id); return r && r.table_id === tableId ? r : null; };
const tokenInTable = (id, tableId) => db.prepare('SELECT t.* FROM tokens t JOIN scenes s ON s.id = t.scene_id WHERE t.id = ? AND s.table_id = ?').get(idOf(id), tableId);
const tableBySlug = (slug) => db.prepare('SELECT * FROM game_tables WHERE slug = ?').get(String(slug ?? ''));
const tableView = (t) => ({ slug: t.slug, name: t.name, listed: !!t.listed });
const sceneView = (s) => ({ id: s.id, name: s.name, image: s.image, width: s.width, height: s.height, grid: s.grid, ox: s.ox, oy: s.oy, active: !!s.active,
  fog: !!s.fog, dark: !!s.dark, sharedVision: !!s.shared, explore: !!s.explore, tps: jparse(s.tps, []), walls: jparse(s.walls, []).map(normWall), lights: jparse(s.lights, []).map((l) => ({ kind: 'light', playersWin: false, ...l })), reveal: jparse(s.reveal, []) });
/** Shown dead (black and white, 50 %, no vision) for everyone: forced by the GM, or automatically when the linked sheet is at 0 HP or less. */
function tokenDead(t) {
  if (t.life === 'dead') return true;
  if (t.life === 'alive' || !t.actor_id) return false;
  const a = getRow('actors', t.actor_id);
  return !!a && Number(jparse(a.data, {}).hp?.cur ?? 1) <= 0;
}
/** Darkvision comes from the linked sheet (a toggle on the sheet). */
const tokenDarkvision = (t) => !!t.actor_id && jparse(getRow('actors', t.actor_id)?.data, {}).darkvision === true;
const tokenView = (t) => ({ id: t.id, sceneId: t.scene_id, name: t.name, x: t.x, y: t.y, size: t.size, image: t.image, color: t.color, actorId: t.actor_id, hidden: !!t.hidden, vision: t.vision, light: t.light, sight: !!t.sight,
  life: t.life ?? 'auto', dead: tokenDead(t), pc: isPlayerCharacter(t), darkvision: tokenDarkvision(t) });
/** A player's token: some player has the edit right on its sheet (its light can beat an anti-light, see public/walls.js). */
const isPlayerCharacter = (t) => !!t.actor_id && !!db.prepare("SELECT 1 FROM actor_perms WHERE actor_id = ? AND level = 'edit'").get(t.actor_id);
const soundView = (s) => { const yt = youtubeId(s.url); return { id: s.id, name: s.name, url: s.url, loop: !!s.loop, volume: s.volume, kind: yt ? 'youtube' : 'file', ...(yt ? { videoId: yt } : {}),
  group: s.grp ?? '', subgroup: s.subgrp ?? '', tags: jparse(s.tags, []), created: s.created }; };
const journalView = (j, u = GM) => ({ id: j.id, title: j.title, body: j.body, image: j.image, visibility: jparse(j.visibility, 'gm'), updated: j.updated, ...(u.role === 'gm' ? { campaignId: j.campaign_id ?? null } : {}) });
const canSeeJournal = (u, j) => { const v = jparse(j.visibility, 'gm'); return u.role === 'gm' || v === 'all' || (Array.isArray(v) && v.includes(u.id)); };
// ---- compendium entries (items and spells). They link to sheets by kind + name, case-insensitive.
const compKey = (name) => String(name ?? '').trim().toLowerCase();
function compView(c, u = GM) {
  const data = jparse(c.data, {});
  const v = { id: c.id, kind: c.kind, name: c.name, category: c.kind === 'item' ? data.type ?? 'other' : 'spell', data };
  if (u.role !== 'gm') return v;
  const src = c.source_id ? getRow('compendium', c.source_id) : null;
  return { ...v, visible: !!c.visible, auto: !!c.auto, campaignId: c.campaign_id ?? null, updated: c.updated,
    // a copy of an entry from outside any table that changed since: the GM may want to update the copy
    source: c.source_id ? { id: c.source_id, exists: !!src, stale: !!src && src.table_id == null && src.updated > (c.source_updated ?? 0) } : null };
}
/** "kind:name" of every item and spell on the sheets this user can see. */
function namesSeenBy(u, tableId) {
  const names = new Set();
  for (const a of db.prepare('SELECT id, data FROM actors WHERE table_id = ?').all(tableId)) {
    if (!canSeeActor(u, a)) continue;
    const d = jparse(a.data, {});
    for (const x of Array.isArray(d.items) ? d.items : []) names.add('item:' + compKey(x?.name));
    for (const x of Array.isArray(d.spells) ? d.spells : []) names.add('spell:' + compKey(x?.name));
  }
  return names;
}
/** Players see an entry when the GM ticked "visible", or when it is on a sheet they can edit or view. */
const canSeeComp = (u, c, names) => u.role === 'gm' || !!c.visible || (names ?? namesSeenBy(u, c.table_id)).has(`${c.kind}:${compKey(c.name)}`);
const npcsOf = (tableId) => db.prepare('SELECT id, name, data FROM actors WHERE table_id = ? AND shown = 1 ORDER BY name COLLATE NOCASE').all(tableId)
  .map((a) => ({ id: a.id, name: a.name, portrait: tokenImage(jparse(a.data, {})) }));
const chatView = (m) => ({ id: m.id, userId: m.user_id, userName: m.user_name, actorId: m.actor_id, whisper: m.whisper, body: JSON.parse(m.body), ts: m.ts });
const canSeeChat = (u, m) => !m.whisper || u.role === 'gm' || m.user_id === u.id;

// ---- per-sheet rights: for each player slot of the table, "edit", "view" or nothing (invisible). The GM can do everything.
const PERM_LEVELS = ['edit', 'view'];
const permsOf = (actorId) => Object.fromEntries(db.prepare('SELECT slot_id, level FROM actor_perms WHERE actor_id = ?').all(actorId).map((p) => [p.slot_id, p.level]));
const permOf = (u, actorId) => (u.role === 'gm' ? 'edit' : db.prepare('SELECT level FROM actor_perms WHERE actor_id = ? AND slot_id = ?').get(actorId, u.id)?.level ?? 'none');
const canSeeActor = (u, row) => permOf(u, row.id) !== 'none';
const canEditActor = (u, row) => permOf(u, row.id) === 'edit';
function actorView(row, u) {
  const sys = getSystem(row.table_id);
  const data = sanitizeActorData(JSON.parse(row.data), sys);
  const c = actorContext(sys, data);
  const gm = u.role === 'gm';
  return { id: row.id, name: row.name, perm: permOf(u, row.id), perms: gm ? permsOf(row.id) : undefined, alias: gm ? row.alias ?? '' : undefined, shown: gm ? !!row.shown : undefined, campaignId: gm ? row.campaign_id ?? null : undefined, data,
    computed: { stats: c.stats, derived: c.derived, errors: c.errors, pdef: c.pdef, mdef: c.mdef, points: pointBudget(sys, data) } };
}

// ------------------------------------------------------------------ player slots & presence
const live = new Map(); // slot id -> number of open event streams
const isOnline = (s) => !!s.session && ((live.get(s.id) ?? 0) > 0 || now() - s.seen < GRACE);
const slotView = (s) => ({ id: s.id, name: s.name, color: s.color, role: 'player', online: isOnline(s) });
const slotsOf = (tableId) => db.prepare('SELECT * FROM slots WHERE table_id = ? ORDER BY id').all(tableId);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const playerToken = (req) => parseCookies(req.headers.cookie).fvp;
// The player cookie is scoped to one table's API path, so the same browser can sit at two tables in two tabs.
function setPlayerCookie(req, res, slug, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', token ? `fvp=${token}; HttpOnly; SameSite=Lax; Path=/api/t/${slug}; Max-Age=${30 * 86400}${secure}`
    : `fvp=; HttpOnly; SameSite=Lax; Path=/api/t/${slug}; Max-Age=0`);
}
function playerFor(req, table) {
  const token = playerToken(req); if (!token) return null;
  const s = db.prepare('SELECT * FROM slots WHERE table_id = ? AND session = ?').get(table.id, sha(token));
  if (!s) return null;
  db.prepare('UPDATE slots SET seen = ? WHERE id = ?').run(now(), s.id);
  return { id: s.id, name: s.name, color: s.color, role: 'player' };
}

// ------------------------------------------------------------------ realtime (SSE), one channel per table
const clients = new Set(); // { res, tableId, user, cid }
const send = (c, ev) => c.res.write(`data: ${JSON.stringify(ev)}\n\n`);
/** event may be a function of the receiving user (per-user views); return null to skip that user. */
function broadcast(tableId, event, allow = () => true) {
  for (const c of clients) {
    if (c.tableId !== tableId || !allow(c.user)) continue;
    const ev = typeof event === 'function' ? event(c.user) : event;
    if (ev) send(c, ev);
  }
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25_000).unref();
const pushSlot = (id) => { const s = getRow('slots', id); if (s) broadcast(s.table_id, { type: 'user', op: 'upsert', data: slotView(s) }); };
/** Last message, then hang up. Removed from the list first so that nothing writes to the closed stream. */
const hangUp = (c, ev) => { clients.delete(c); send(c, ev); c.res.end(); };
/** Close a player's open pages (kick, slot deleted, table deleted). */
function dropPlayer(slotId, reason = 'kicked') {
  for (const c of [...clients]) if (c.user.role === 'player' && c.user.id === slotId) hangUp(c, { type: reason });
}
const lookShown = new Map(); // token id -> last look sent (dead, darkvision), so a sheet change only re-sends the tokens whose look changed
const pushActor = (row, by) => {
  broadcast(row.table_id, (u) => (canSeeActor(u, row) ? { type: 'actor', op: 'upsert', data: actorView(row, u), by } : null));
  for (const t of db.prepare('SELECT * FROM tokens WHERE actor_id = ?').all(row.id)) {
    const look = `${tokenDead(t)}|${tokenDarkvision(t)}`;
    if (lookShown.get(t.id) !== look) { lookShown.set(t.id, look); pushToken(t, null); } // no echo id: every page, the sender's included, updates the look
  }
};
const sceneOf = (id) => getRow('scenes', id);
const pushToken = (row, by) => {
  const sc = sceneOf(row.scene_id); if (!sc?.table_id) return;
  const pub = !!sc.active && !row.hidden;
  broadcast(sc.table_id, { type: 'token', op: 'upsert', data: tokenView(row), by }, (u) => u.role === 'gm' || pub);
  if (!pub) broadcast(sc.table_id, { type: 'token', op: 'delete', data: { id: row.id }, by }, (u) => u.role !== 'gm');
};
const pushJournal = (row) => { if (row.table_id != null) broadcast(row.table_id, (u) => (canSeeJournal(u, row) ? { type: 'journal', op: 'upsert', data: journalView(row, u) } : { type: 'journal', op: 'delete', data: { id: row.id } })); };
const pushComp = (row) => broadcast(row.table_id, (u) => (canSeeComp(u, row) ? { type: 'comp', op: 'upsert', data: compView(row, u) } : { type: 'comp', op: 'delete', data: { id: row.id } }));
const pushNpcs = (tableId) => broadcast(tableId, { type: 'npcs', data: npcsOf(tableId) });
const pushChat = (row) => broadcast(row.table_id, { type: 'chat', op: 'upsert', data: chatView(row) }, (u) => canSeeChat(u, row));
const playingByTable = new Map(); // table id -> Map(sound id -> { startedAt })
const playingOf = (tableId) => { if (!playingByTable.has(tableId)) playingByTable.set(tableId, new Map()); return playingByTable.get(tableId); };

// ------------------------------------------------------------------ http helpers
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
/**
 * The body, up to `limit` bytes. A body over the limit is read to its end and thrown away, then refused with a clean 413:
 * answering (and closing) while the browser is still sending made it see a network error instead of "File too large".
 * Far over the limit (a broken or hostile client), the connection is cut without reading the rest.
 */
function readBody(req, limit) {
  const hardCap = Math.max(limit * 4, limit + 50 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else if (chunks.length) chunks.length = 0; // over the limit: keep reading, keep nothing
      if (size > hardCap) { reject(Object.assign(new HttpError(413, 'File too large'), { cut: true })); req.destroy(); }
    });
    req.on('end', () => (size > limit ? reject(new HttpError(413, 'File too large')) : resolve(Buffer.concat(chunks))));
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
const digest = (s) => createHash('sha256').update(String(s)).digest();
const secretOk = (req) => !ADMIN_SECRET || timingSafeEqual(digest(req.headers['x-admin-secret'] ?? ''), digest(ADMIN_SECRET));
const isAdminPath = (p) => p === '/admin' || p.startsWith('/admin/');

// ------------------------------------------------------------------ routes
// Scopes: "public" (no identity), "player" (/api/t/<slug>/..., a player who picked a slot), "gm" (/admin/api/t/<slug>/...), "admin" (/admin/api/...).
const routes = [];
function addRoute(method, pattern, scope, handler) {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, scope, handler, raw: pattern.endsWith('/upload') || pattern.endsWith('/archive') }); // raw: the body is a file, read by the handler
}
const pub = (m, p, fn) => addRoute(m, '/api' + p, 'public', fn);
const admin = (m, p, fn) => addRoute(m, '/admin/api' + p, 'admin', fn);
/** A table route. "player" routes exist on both doors (the handler checks the finer rights); "gm" routes only behind /admin. */
const tbl = (m, p, access, fn) => {
  if (access === 'player') addRoute(m, '/api/t/:slug' + p, 'player', fn);
  addRoute(m, '/admin/api/t/:slug' + p, 'gm', fn);
};

// ---- player door: tables, lobby, picking a slot
pub('GET', '/tables', () => ({ tables: db.prepare('SELECT * FROM game_tables WHERE listed = 1 ORDER BY name').all().map(tableView) }));
pub('GET', '/t/:slug/lobby', ({ req, params }) => {
  const table = tableBySlug(params.slug); if (!table) throw notFound('No table at this address');
  const token = playerToken(req);
  const me = token ? db.prepare('SELECT id FROM slots WHERE table_id = ? AND session = ?').get(table.id, sha(token))?.id ?? null : null;
  return { table: tableView(table), slots: slotsOf(table.id).map(slotView), me };
});
pub('POST', '/t/:slug/join', ({ req, res, params, body }) => {
  const table = tableBySlug(params.slug); if (!table) throw notFound('No table at this address');
  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND table_id = ?').get(idOf(body.slotId), table.id);
  if (!slot) throw notFound('Unknown player');
  const old = playerToken(req), token = old || randomBytes(32).toString('hex');
  const mine = !!old && slot.session === sha(old);
  if (!mine && isOnline(slot)) throw new HttpError(409, 'Someone is already playing as this player');
  if (old) for (const s of db.prepare('SELECT id FROM slots WHERE table_id = ? AND session = ? AND id != ?').all(table.id, sha(old), slot.id)) {
    db.prepare('UPDATE slots SET session = NULL, seen = 0 WHERE id = ?').run(s.id); pushSlot(s.id); // switching player frees the previous one
  }
  db.prepare('UPDATE slots SET session = ?, seen = ? WHERE id = ?').run(sha(token), now(), slot.id);
  setPlayerCookie(req, res, table.slug, token);
  pushSlot(slot.id);
  return { me: slotView(getRow('slots', slot.id)) };
});
pub('POST', '/t/:slug/leave', ({ req, res, params }) => {
  const table = tableBySlug(params.slug); if (!table) throw notFound();
  const token = playerToken(req);
  if (token) for (const s of db.prepare('SELECT id FROM slots WHERE table_id = ? AND session = ?').all(table.id, sha(token))) {
    db.prepare('UPDATE slots SET session = NULL, seen = 0 WHERE id = ?').run(s.id); dropPlayer(s.id, 'left'); pushSlot(s.id);
  }
  setPlayerCookie(req, res, table.slug, null);
  return { ok: true };
});

// ---- GM: tables
const RESERVED = new Set(['admin', 'api', 'assets', 'icons', 'uploads', 'index', 'static', ...readdirSync(PUBLIC).filter((n) => !n.includes('.'))]);
function cleanSlug(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s)) throw bad('Address: 1-40 lowercase letters, digits or -, not starting or ending with -');
  if (RESERVED.has(s)) throw bad(`"${s}" is reserved, pick another address`);
  return s;
}
const tableName = (v, d) => String(v ?? d ?? '').trim().slice(0, 60) || d || 'Table';
const adminTableView = (t) => {
  const slots = slotsOf(t.id);
  return { ...tableView(t), campaignId: t.campaign_id ?? null, players: slots.length, online: slots.filter(isOnline).length };
};
admin('GET', '/tables', () => ({ tables: db.prepare('SELECT * FROM game_tables ORDER BY name').all().map(adminTableView), devMode: !ADMIN_SECRET }));
admin('POST', '/tables', ({ body }) => {
  const slug = cleanSlug(body.slug);
  if (tableBySlug(slug)) throw bad('That address is taken');
  // a table of a campaign starts with the campaign's system, otherwise with the default rules
  const camp = campaignId(body.campaignId), linked = camp ? getRow('systems', getRow('campaigns', camp).system_id) : null;
  db.prepare('INSERT INTO game_tables (slug, name, listed, system, created, campaign_id) VALUES (?,?,?,?,?,?)').run(slug, tableName(body.name, slug), body.listed === false ? 0 : 1, linked ? linked.data : JSON.stringify(loadDefaultSystem()), now(), camp);
  return adminTableView(tableBySlug(slug));
});
admin('PATCH', '/tables/:slug', ({ params, body }) => {
  const cur = tableBySlug(params.slug); if (!cur) throw notFound();
  const slug = body.slug !== undefined ? cleanSlug(body.slug) : cur.slug;
  if (slug !== cur.slug && tableBySlug(slug)) throw bad('That address is taken');
  db.prepare('UPDATE game_tables SET slug = ?, name = ?, listed = ?, campaign_id = ? WHERE id = ?').run(slug, body.name !== undefined ? tableName(body.name, cur.name) : cur.name,
    body.listed !== undefined ? (body.listed ? 1 : 0) : cur.listed, body.campaignId !== undefined ? campaignId(body.campaignId) : cur.campaign_id, cur.id);
  const row = getRow('game_tables', cur.id);
  broadcast(cur.id, { type: 'table', data: tableView(row) }); // a new address sends everyone to it
  return adminTableView(row);
});
admin('DELETE', '/tables/:slug', ({ params }) => {
  const cur = tableBySlug(params.slug); if (!cur) throw notFound();
  for (const s of slotsOf(cur.id)) dropPlayer(s.id, 'gone');
  db.prepare('DELETE FROM game_tables WHERE id = ?').run(cur.id); // everything in it goes too (ON DELETE CASCADE)
  forgetSystem(cur.id); playingByTable.delete(cur.id);
  for (const c of [...clients]) if (c.tableId === cur.id) hangUp(c, { type: 'gone' });
  return { ok: true };
});

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
async function handleUpload({ req, user }) {
  const ext = MEDIA[(req.headers['content-type'] || '').split(';')[0]];
  if (!ext) throw bad('Unsupported file type (PNG, JPEG, WebP, GIF, MP3, OGG, WAV, M4A, FLAC, WebM)');
  const audio = !['png', 'jpg', 'webp', 'gif'].includes(ext);
  if (user.role !== 'gm' && audio) throw forbidden('Only the GM uploads audio');
  const buf = await readBody(req, user.role !== 'gm' ? MAX_PLAYER_IMG : audio ? MAX_AUDIO : MAX_UPLOAD);
  if (!SNIFF[ext](buf)) throw bad('File content does not match its type');
  const name = `${createHash('sha256').update(buf).digest('hex')}.${ext}`;
  if (!existsSync(join(UPLOAD_DIR, name))) writeFileSync(join(UPLOAD_DIR, name), buf);
  return { url: `/uploads/${name}`, kind: audio ? 'audio' : 'image' };
}
tbl('POST', '/upload', 'player', handleUpload);
admin('POST', '/upload', handleUpload);

// ---- table state & realtime
tbl('GET', '/state', 'player', ({ user, table }) => {
  const gm = user.role === 'gm';
  const scene = db.prepare('SELECT * FROM scenes WHERE active = 1 AND table_id = ?').get(table.id);
  const chat = db.prepare('SELECT * FROM chat WHERE table_id = ? ORDER BY id DESC LIMIT 200').all(table.id).filter((m) => canSeeChat(user, m)).reverse().slice(-100);
  return {
    me: user, table: tableView(table),
    users: slotsOf(table.id).map(slotView),
    system: getSystem(table.id),
    scene: scene ? sceneView(scene) : null,
    scenes: gm ? db.prepare('SELECT * FROM scenes WHERE table_id = ? ORDER BY id').all(table.id).map(sceneView) : [],
    tokens: gm ? db.prepare('SELECT t.* FROM tokens t JOIN scenes s ON s.id = t.scene_id WHERE s.table_id = ?').all(table.id).map(tokenView)
      : scene ? db.prepare('SELECT * FROM tokens WHERE scene_id = ?').all(scene.id).filter((t) => !t.hidden).map(tokenView) : [],
    sounds: db.prepare('SELECT * FROM sounds WHERE table_id = ? ORDER BY name').all(table.id).map(soundView),
    playing: [...playingOf(table.id)].map(([id, v]) => ({ id, startedAt: v.startedAt })),
    serverTime: now(),
    journals: db.prepare('SELECT * FROM journals WHERE table_id = ? ORDER BY title').all(table.id).filter((j) => canSeeJournal(user, j)).map((j) => journalView(j, user)),
    compendium: (() => { const names = gm ? null : namesSeenBy(user, table.id); return db.prepare('SELECT * FROM compendium WHERE table_id = ? ORDER BY kind, name COLLATE NOCASE').all(table.id).filter((c) => canSeeComp(user, c, names)).map((c) => compView(c, user)); })(),
    npcs: npcsOf(table.id),
    actors: db.prepare('SELECT * FROM actors WHERE table_id = ? ORDER BY name').all(table.id).filter((a) => canSeeActor(user, a)).map((a) => actorView(a, user)),
    chat: chat.map(chatView),
  };
});
tbl('GET', '/events', 'player', ({ res, user, table, by }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const client = { res, user, tableId: table.id, cid: by };
  clients.add(client);
  res.on('error', () => clients.delete(client)); // a page that vanished mid-write must never take the server down
  if (user.role === 'player') { live.set(user.id, (live.get(user.id) ?? 0) + 1); pushSlot(user.id); }
  let closed = false;
  res.on('close', () => {
    if (closed) return; closed = true;
    clients.delete(client);
    if (user.role !== 'player') return;
    const n = (live.get(user.id) ?? 1) - 1;
    if (n > 0) { live.set(user.id, n); return; }
    live.delete(user.id);
    db.prepare('UPDATE slots SET seen = ? WHERE id = ?').run(now(), user.id); // the grace period starts now
    setTimeout(() => pushSlot(user.id), GRACE + 50).unref();
  });
  return STREAM;
});

// ---- player slots (GM)
const slotName = (v, d) => String(v ?? d ?? '').trim().slice(0, 40) || d || 'Player';
const slotIn = (table, id) => { const s = db.prepare('SELECT * FROM slots WHERE id = ? AND table_id = ?').get(idOf(id), table.id); if (!s) throw notFound('Unknown player'); return s; };
tbl('POST', '/slots', 'gm', ({ table, body }) => {
  const r = db.prepare('INSERT INTO slots (table_id, name, color, created) VALUES (?,?,?,?)').run(table.id, slotName(body.name, 'Player'), color(body.color), now());
  pushSlot(Number(r.lastInsertRowid));
  return slotView(getRow('slots', r.lastInsertRowid));
});
tbl('PATCH', '/slots/:id', 'gm', ({ table, params, body }) => {
  const s = slotIn(table, params.id);
  db.prepare('UPDATE slots SET name = ?, color = ? WHERE id = ?').run(body.name !== undefined ? slotName(body.name, s.name) : s.name, body.color !== undefined ? color(body.color, s.color) : s.color, s.id);
  pushSlot(s.id);
  return slotView(getRow('slots', s.id));
});
tbl('POST', '/slots/:id/kick', 'gm', ({ table, params }) => {
  const s = slotIn(table, params.id);
  db.prepare('UPDATE slots SET session = NULL, seen = 0 WHERE id = ?').run(s.id);
  dropPlayer(s.id, 'kicked');
  pushSlot(s.id);
  return slotView(getRow('slots', s.id));
});
tbl('DELETE', '/slots/:id', 'gm', ({ table, params }) => {
  const s = slotIn(table, params.id);
  dropPlayer(s.id, 'kicked');
  db.prepare('DELETE FROM slots WHERE id = ?').run(s.id); // its sheet rights go with it
  broadcast(table.id, { type: 'refresh' });
  return { ok: true };
});

// ---- scenes (in a table, or in the GM's map library when table_id is NULL)
const fin = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
// walls: [x1, y1, x2, y2, door, open, locked, move, sight] (see public/walls.js); older 6-value walls keep blocking sight only
const cleanWalls = (a) => (Array.isArray(a) ? a.slice(0, 4000).filter(Array.isArray).map((w) => normWall([fin(w[0]), fin(w[1]), fin(w[2]), fin(w[3]), w[4], w[5], w[6], w[7], w[8]])) : []);
// lights are small GM tokens: a light, or an anti-light (removes light; "playersWin": the lights of players' tokens still win)
const cleanLights = (a) => (Array.isArray(a) ? a.slice(0, 300).map((l) => {
  const anti = l?.kind === 'anti';
  return { id: String(l?.id || randomBytes(3).toString('hex')).slice(0, 12), x: fin(l?.x), y: fin(l?.y), radius: radiusStep(l?.radius), kind: anti ? 'anti' : 'light', playersWin: anti && !!l?.playersWin };
}) : []);
// teleport cells: the centre of a grid cell and a group (cells of a group are linked); see public/tp.js
const cleanTps = (a) => (Array.isArray(a) ? a.slice(0, 200).map((c) => ({ id: String(c?.id || randomBytes(3).toString('hex')).slice(0, 12), x: fin(c?.x), y: fin(c?.y), group: String(c?.group ?? '').trim().slice(0, 12) || '1' })) : []);
// revealed areas: a rectangle [x, y, w, h], or a polygon { poly: [[x, y], ...] } (3 to 500 points) drawn with the lasso / polygon tools
const cleanReveal = (a) => (Array.isArray(a) ? a.slice(0, 500).map((r) => {
  if (Array.isArray(r)) return [fin(r[0]), fin(r[1]), Math.abs(fin(r[2])), Math.abs(fin(r[3]))];
  const pts = Array.isArray(r?.poly) ? r.poly.slice(0, 500).filter((p) => Array.isArray(p)).map((p) => [fin(p[0]), fin(p[1])]) : [];
  return pts.length >= 3 ? { poly: pts } : null;
}).filter(Boolean) : []);
const sceneFields = (b, cur = {}) => ({
  fog: b.fog !== undefined ? (b.fog ? 1 : 0) : cur.fog ?? 0, dark: b.dark !== undefined ? (b.dark ? 1 : 0) : cur.dark ?? 0,
  shared: b.sharedVision !== undefined ? (b.sharedVision ? 1 : 0) : cur.shared ?? 0, explore: b.explore !== undefined ? (b.explore ? 1 : 0) : cur.explore ?? 1,
  walls: b.walls !== undefined ? JSON.stringify(cleanWalls(b.walls)) : cur.walls ?? '[]',
  lights: b.lights !== undefined ? JSON.stringify(cleanLights(b.lights)) : cur.lights ?? '[]',
  reveal: b.reveal !== undefined ? JSON.stringify(cleanReveal(b.reveal)) : cur.reveal ?? '[]',
  tps: b.tps !== undefined ? JSON.stringify(cleanTps(b.tps)) : cur.tps ?? '[]',
  name: String(b.name ?? cur.name ?? 'Scene').slice(0, 80) || 'Scene',
  image: b.image !== undefined ? imgUrl(b.image) : cur.image ?? null,
  width: Math.max(0, Math.trunc(num(b.width, cur.width ?? 0))), height: Math.max(0, Math.trunc(num(b.height, cur.height ?? 0))),
  grid: Math.min(500, Math.max(10, Math.trunc(num(b.grid, cur.grid ?? 70)))),
  ox: Math.trunc(num(b.ox, cur.ox ?? 0)), oy: Math.trunc(num(b.oy, cur.oy ?? 0)),
});
function insertScene(tableId, f) {
  const first = tableId != null && !db.prepare('SELECT 1 FROM scenes WHERE table_id = ?').get(tableId);
  const r = db.prepare('INSERT INTO scenes (table_id, name, image, width, height, grid, ox, oy, active, created, fog, dark, walls, lights, reveal, shared, explore, tps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(tableId, f.name, f.image, f.width, f.height, f.grid, f.ox, f.oy, first ? 1 : 0, now(), f.fog, f.dark, f.walls, f.lights, f.reveal, f.shared, f.explore, f.tps);
  if (first) broadcast(tableId, { type: 'refresh' });
  return getRow('scenes', r.lastInsertRowid);
}
function updateScene(cur, body) {
  const f = sceneFields(body, cur);
  db.prepare('UPDATE scenes SET name=?, image=?, width=?, height=?, grid=?, ox=?, oy=?, fog=?, dark=?, walls=?, lights=?, reveal=?, shared=?, explore=?, tps=? WHERE id=?').run(f.name, f.image, f.width, f.height, f.grid, f.ox, f.oy, f.fog, f.dark, f.walls, f.lights, f.reveal, f.shared, f.explore, f.tps, cur.id);
  const row = getRow('scenes', cur.id);
  if (row.table_id != null) broadcast(row.table_id, { type: 'scene', op: 'upsert', data: sceneView(row) }, (u) => u.role === 'gm' || !!row.active);
  return sceneView(row);
}
tbl('POST', '/scenes', 'gm', ({ table, body }) => sceneView(insertScene(table.id, sceneFields(body))));
tbl('PATCH', '/scenes/:id', 'gm', ({ table, params, body }) => { const cur = inTable('scenes', params.id, table.id); if (!cur) throw notFound(); return updateScene(cur, body); });
tbl('POST', '/scenes/:id/activate', 'gm', ({ table, params }) => {
  const sc = inTable('scenes', params.id, table.id); if (!sc) throw notFound();
  db.prepare('UPDATE scenes SET active = 0 WHERE table_id = ?').run(table.id); db.prepare('UPDATE scenes SET active = 1 WHERE id = ?').run(sc.id);
  broadcast(table.id, { type: 'refresh' });
  return { ok: true };
});
// Doors: anyone at the table opens or closes them (on the active scene); a locked door only by the GM.
// The door is found by its ends (x1, y1, x2, y2), so a stale list on the page cannot toggle the wrong wall.
tbl('POST', '/scenes/:id/door', 'player', ({ user, table, params, body }) => {
  const sc = inTable('scenes', params.id, table.id); if (!sc) throw notFound();
  const gm = user.role === 'gm';
  if (!gm && !sc.active) throw notFound();
  const walls = jparse(sc.walls, []).map(normWall);
  const at = Array.isArray(body.at) ? body.at.map(fin) : [];
  const i = walls.findIndex((w) => w[W.door] && at.length === 4 && w.slice(0, 4).every((v, k) => Math.abs(v - at[k]) < 0.05));
  if (i < 0) throw bad('No door there');
  if (walls[i][W.locked] && !gm) throw forbidden('This door is locked');
  walls[i][W.open] = body.open === undefined ? (walls[i][W.open] ? 0 : 1) : body.open ? 1 : 0;
  return updateScene(sc, { walls });
});
/// ---- exploration memory ("dynamic fog"): what each player slot has seen of a scene, as half-cell bitmaps (public/vision.js):
// "bits" = seen at all, "color" = seen in colour (a half cell seen only through darkvision stays black and white in the memory).
// Pages OR what they see into it; the server ORs again, so nothing seen is ever lost. The GM resets it, per player or for all.
const exploreRow = (sceneId, slotId) => db.prepare('SELECT * FROM explored WHERE scene_id = ? AND slot_id = ?').get(sceneId, slotId);
function exploredOf(sc, slotId) {
  const d = exploreDims(sc), row = exploreRow(sc.id, slotId);
  const fits = row && row.cols === d.cols && row.rows === d.rows; // the map changed size or grid since: start over
  const b64 = (v) => Buffer.from(v).toString('base64');
  return { ...d, bits: fits ? b64(row.bits) : '', color: fits ? b64(row.color ?? row.bits) : '' }; // memories from before colour: all in colour
}
tbl('GET', '/scenes/:id/explored', 'player', ({ user, table, params, url }) => {
  const sc = inTable('scenes', params.id, table.id); if (!sc) throw notFound();
  if (user.role === 'gm') return exploredOf(sc, slotIn(table, url.searchParams.get('slot')).id); // the GM looking as a player
  if (!sc.active) throw notFound();
  return exploredOf(sc, user.id);
});
tbl('POST', '/scenes/:id/explored', 'player', ({ user, table, params, body }) => {
  if (user.role === 'gm') throw bad('Only players explore');
  const sc = inTable('scenes', params.id, table.id); if (!sc || !sc.active) throw notFound();
  if (!sc.explore) return exploredOf(sc, user.id); // memory off on this scene: nothing is kept
  const d = exploreDims(sc), size = Math.ceil((d.cols * d.rows) / 8);
  if (d.cols * d.rows > 4_000_000) throw bad('Map too large for the exploration memory');
  if (body.cols !== d.cols || body.rows !== d.rows) throw new HttpError(409, 'The map changed, reload');
  const incoming = Buffer.from(String(body.bits ?? ''), 'base64');
  const inColor = body.color === undefined ? incoming : Buffer.from(String(body.color), 'base64');
  if (incoming.length !== size || inColor.length !== size) throw bad('Bad exploration bitmap');
  const row = exploreRow(sc.id, user.id), bits = Buffer.alloc(size), color = Buffer.alloc(size);
  if (row && row.cols === d.cols && row.rows === d.rows) { Buffer.from(row.bits).copy(bits); Buffer.from(row.color ?? row.bits).copy(color); }
  for (let i = 0; i < size; i++) { bits[i] |= incoming[i] | inColor[i]; color[i] |= inColor[i]; }
  db.prepare('INSERT INTO explored (scene_id, slot_id, cols, rows, bits, color, updated) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scene_id, slot_id) DO UPDATE SET cols = excluded.cols, rows = excluded.rows, bits = excluded.bits, color = excluded.color, updated = excluded.updated')
    .run(sc.id, user.id, d.cols, d.rows, bits, color, now());
  return { ...d, bits: bits.toString('base64'), color: color.toString('base64') };
});
tbl('DELETE', '/scenes/:id/explored', 'gm', ({ table, params, url }) => {
  const sc = inTable('scenes', params.id, table.id); if (!sc) throw notFound();
  const slot = url.searchParams.get('slot') ? slotIn(table, url.searchParams.get('slot')) : null;
  if (slot) db.prepare('DELETE FROM explored WHERE scene_id = ? AND slot_id = ?').run(sc.id, slot.id);
  else db.prepare('DELETE FROM explored WHERE scene_id = ?').run(sc.id);
  broadcast(table.id, { type: 'explored', sceneId: sc.id }, (u) => u.role === 'player' && (!slot || u.id === slot.id)); // their pages forget too
  return { ok: true };
});
tbl('DELETE', '/scenes/:id', 'gm', ({ table, params }) => {
  const sc = inTable('scenes', params.id, table.id); if (!sc) throw notFound();
  db.prepare('DELETE FROM scenes WHERE id = ?').run(sc.id);
  broadcast(table.id, { type: 'refresh' });
  return { ok: true };
});
// The map library: maps prepared outside any table (walls, lights...), copied into tables.
const libScene = (id) => { const s = getRow('scenes', id); if (!s || s.table_id != null) throw notFound(); return s; };
admin('GET', '/library', () => ({ scenes: db.prepare('SELECT * FROM scenes WHERE table_id IS NULL ORDER BY name').all().map(sceneView) }));
admin('POST', '/library/scenes', ({ body }) => sceneView(insertScene(null, sceneFields(body))));
admin('PATCH', '/library/scenes/:id', ({ params, body }) => updateScene(libScene(params.id), body));
admin('DELETE', '/library/scenes/:id', ({ params }) => { db.prepare('DELETE FROM scenes WHERE id = ?').run(libScene(params.id).id); return { ok: true }; });
/** Copy any map (library or table) into a table, or into the library when "table" is empty. Tokens are not copied. */
admin('POST', '/scenes/:id/copy', ({ params, body }) => {
  const src = getRow('scenes', params.id); if (!src) throw notFound();
  const target = body.table ? tableBySlug(body.table) : null;
  if (body.table && !target) throw bad('Unknown table');
  return sceneView(insertScene(target?.id ?? null, sceneFields({ name: body.name }, src)));
});

// ---- tokens
tbl('POST', '/tokens', 'gm', ({ table, by, body }) => {
  const scene = inTable('scenes', body.sceneId, table.id); if (!scene) throw bad('Unknown scene');
  const actor = body.actorId ? inTable('actors', body.actorId, table.id) : null;
  const portrait = actor ? tokenImage(jparse(actor.data, {})) : null;
  const r = db.prepare('INSERT INTO tokens (scene_id, name, x, y, size, image, color, actor_id, hidden, vision, light, sight, life) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    scene.id, String(body.name ?? actor?.name ?? 'Token').slice(0, 60), num(body.x, scene.width / 2), num(body.y, scene.height / 2),
    Math.min(10, Math.max(0.25, num(body.size, 1))), imgUrl(body.image) ?? portrait, color(body.color), actor?.id ?? null, body.hidden ? 1 : 0,
    Math.min(100, Math.max(0, num(body.vision, 100))), Math.min(100, Math.max(0, num(body.light, 0))), body.sight ? 1 : 0, ['dead', 'alive'].includes(body.life) ? body.life : 'auto'); // vision in cells: 0 = none, 100 by default
  const row = getRow('tokens', r.lastInsertRowid);
  pushToken(row, by);
  return tokenView(row);
});
tbl('PATCH', '/tokens/:id', 'player', ({ user, table, by, params, body }) => {
  const cur = tokenInTable(params.id, table.id); if (!cur) throw notFound();
  const actor = cur.actor_id ? getRow('actors', cur.actor_id) : null;
  const gm = user.role === 'gm';
  if (!gm && !(actor && canEditActor(user, actor) && !cur.hidden)) throw forbidden(); // players move the tokens of sheets they can edit
  const n = { x: num(body.x, cur.x), y: num(body.y, cur.y), image: body.image !== undefined ? imgUrl(body.image) : cur.image };
  // A move may start from a ghost ("via" a TP cell linked to the one the token stands on): the token teleports there first.
  const sc = sceneOf(cur.scene_id), from = { x: cur.x, y: cur.y };
  if (body.via !== undefined && body.via !== null) {
    const start = ghostStart(jparse(sc?.tps, []), sc?.grid || 70, cur, String(body.via));
    if (!start) throw Object.assign(new HttpError(409, 'This token is not on a linked teleport cell'), { data: { token: tokenView(cur) } });
    Object.assign(from, start);
  }
  // players cannot walk through tangible walls or closed doors (the GM always can); checked on the straight line from where the token is
  if (!gm && moveBlocked(jparse(sc?.walls, []).map(normWall), from.x, from.y, n.x, n.y)) {
    throw Object.assign(new HttpError(409, 'A wall is in the way'), { data: { token: tokenView(cur) } }); // the page snaps back to it
  }
  if (gm) {
    n.name = body.name !== undefined ? String(body.name).slice(0, 60) : cur.name;
    n.size = body.size !== undefined ? Math.min(10, Math.max(0.25, num(body.size, 1))) : cur.size;
    n.vision = body.vision !== undefined ? Math.min(100, Math.max(0, num(body.vision, 0))) : cur.vision;
    n.light = body.light !== undefined ? Math.min(100, Math.max(0, num(body.light, 0))) : cur.light;
    n.sight = body.sight !== undefined ? (body.sight ? 1 : 0) : cur.sight;
    n.color = body.color !== undefined ? color(body.color) : cur.color;
    n.hidden = body.hidden !== undefined ? (body.hidden ? 1 : 0) : cur.hidden;
    n.life = body.life !== undefined ? (['auto', 'dead', 'alive'].includes(body.life) ? body.life : 'auto') : cur.life;
    n.actor_id = body.actorId !== undefined ? (body.actorId ? inTable('actors', body.actorId, table.id)?.id ?? null : null) : cur.actor_id;
  }
  const m = { ...cur, ...n };
  db.prepare('UPDATE tokens SET name=?, x=?, y=?, size=?, image=?, color=?, actor_id=?, hidden=?, vision=?, light=?, sight=?, life=? WHERE id=?').run(m.name, m.x, m.y, m.size, m.image, m.color, m.actor_id, m.hidden, m.vision, m.light, m.sight, m.life ?? 'auto', cur.id);
  const row = getRow('tokens', cur.id);
  pushToken(row, by);
  return tokenView(row);
});
tbl('DELETE', '/tokens/:id', 'gm', ({ table, by, params }) => {
  const row = tokenInTable(params.id, table.id); if (!row) throw notFound();
  const pub = !!sceneOf(row.scene_id)?.active;
  db.prepare('DELETE FROM tokens WHERE id = ?').run(row.id);
  broadcast(table.id, { type: 'token', op: 'delete', data: { id: row.id }, by }, (u) => u.role === 'gm' || pub);
  return { ok: true };
});

// ---- actors (sheets). Only the GM creates and deletes them; players edit the ones they have the "edit" right on.
/** Aliases already used in a table, but the one of the sheet "except". */
const aliasesOf = (tableId, except = -1) => db.prepare('SELECT alias FROM actors WHERE table_id = ? AND id != ? AND alias IS NOT NULL').all(tableId, except).map((r) => r.alias);
function insertActor(table, name, data) {
  const t = now(), clean = String(name ?? 'New character').slice(0, 80) || 'New character';
  const r = db.prepare('INSERT INTO actors (table_id, name, owner_id, data, created, updated, campaign_id, alias, alias_auto) VALUES (?,?,?,?,?,?,?,?,1)')
    .run(table.id, clean, null, JSON.stringify(data), t, t, table.campaign_id ?? null, uniqueAlias(clean, aliasesOf(table.id)));
  syncCompendium(table);
  return getRow('actors', r.lastInsertRowid);
}
tbl('POST', '/actors', 'gm', ({ table, by, body }) => {
  const sys = getSystem(table.id);
  const data = body.data ? fillResources(sys, sanitizeActorData(body.data, sys)) : defaultActorData(sys); // new characters start full
  const row = insertActor(table, body.name, data);
  pushActor(row, by);
  return actorView(row, GM);
});
function editableActor(user, table, id) {
  const row = inTable('actors', id, table.id); if (!row) throw notFound();
  if (!canEditActor(user, row)) throw forbidden();
  return row;
}
tbl('PATCH', '/actors/:id', 'player', ({ user, table, by, params, body }) => {
  const cur = editableActor(user, table, params.id), sys = getSystem(table.id);
  const name = body.name !== undefined ? String(body.name).slice(0, 80) || cur.name : cur.name;
  let data = JSON.parse(cur.data);
  if (body.data) { // a higher max (level, stats, gear) raises current HP/mana/favors by the same amount
    const next = sanitizeActorData(body.data, sys);
    if (user.role !== 'gm') next.manual = sanitizeActorData(data, sys).manual; // the manual mode is the GM's alone
    data = followMax(resourceMaxes(sys, sanitizeActorData(data, sys)), resourceMaxes(sys, next), next);
  }
  if (body.shown !== undefined) { // list it to players in the compendium (name + picture only)
    if (user.role !== 'gm') throw forbidden();
    db.prepare('UPDATE actors SET shown = ? WHERE id = ?').run(body.shown ? 1 : 0, cur.id);
  }
  // "@" alias: the GM's alone. Empty = follow the name again. A taken alias gets a number; "mj" / "gm" are reserved.
  if (body.alias !== undefined) {
    if (user.role !== 'gm') throw forbidden();
    const want = aliasFrom(body.alias);
    if (NARRATOR.includes(want.toLowerCase())) throw bad('"@mj" and "@gm" are reserved for narration');
    db.prepare('UPDATE actors SET alias = ?, alias_auto = ? WHERE id = ?').run(uniqueAlias(want || name, aliasesOf(table.id, cur.id)), want ? 0 : 1, cur.id);
  } else if (name !== cur.name && cur.alias_auto) db.prepare('UPDATE actors SET alias = ? WHERE id = ?').run(uniqueAlias(name, aliasesOf(table.id, cur.id)), cur.id);
  db.prepare('UPDATE actors SET name=?, data=?, updated=? WHERE id=?').run(name, JSON.stringify(data), now(), cur.id);
  const row = getRow('actors', cur.id);
  pushActor(row, by);
  if (body.data) syncCompendium(table);
  if (row.shown || cur.shown) pushNpcs(table.id);
  const oldPortrait = tokenImage(jparse(cur.data, {})), newPortrait = tokenImage(data); // the map tokens follow the sheet's picture
  if (body.data && oldPortrait !== newPortrait) {
    db.prepare('UPDATE tokens SET image = ? WHERE actor_id = ?').run(newPortrait, cur.id);
    for (const t of db.prepare('SELECT * FROM tokens WHERE actor_id = ?').all(cur.id)) pushToken(t, by);
  }
  return actorView(row, user);
});
tbl('PUT', '/actors/:id/perms', 'gm', ({ table, by, params, body }) => {
  const row = inTable('actors', params.id, table.id); if (!row) throw notFound();
  const slots = new Set(slotsOf(table.id).map((s) => s.id));
  const wanted = Object.entries(body.perms && typeof body.perms === 'object' ? body.perms : {}).map(([k, v]) => [idOf(k), v]).filter(([sid, lvl]) => slots.has(sid) && PERM_LEVELS.includes(lvl));
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM actor_perms WHERE actor_id = ?').run(row.id);
    for (const [sid, lvl] of wanted) db.prepare('INSERT INTO actor_perms (actor_id, slot_id, level) VALUES (?,?,?)').run(row.id, sid, lvl);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  broadcast(table.id, { type: 'refresh' }, (u) => u.role !== 'gm'); // what each player can see changed
  pushActor(row, by);
  for (const t of db.prepare('SELECT * FROM tokens WHERE actor_id = ?').all(row.id)) pushToken(t, null); // "player's token" may have changed
  return actorView(row, GM);
});
tbl('DELETE', '/actors/:id', 'gm', ({ table, params }) => {
  const cur = inTable('actors', params.id, table.id); if (!cur) throw notFound();
  db.prepare('DELETE FROM actors WHERE id = ?').run(cur.id);
  broadcast(table.id, { type: 'actor', op: 'delete', data: { id: cur.id } });
  syncCompendium(table);
  if (cur.shown) pushNpcs(table.id);
  return { ok: true };
});
tbl('POST', '/actors/:id/cast', 'player', ({ user, table, by, params, body }) => {
  const cur = editableActor(user, table, params.id), sys = getSystem(table.id);
  const { data, spell, mpSpent, hpSpent } = castSpell(sys, sanitizeActorData(JSON.parse(cur.data), sys), body.spellId);
  db.prepare('UPDATE actors SET data=?, updated=? WHERE id=?').run(JSON.stringify(data), now(), cur.id);
  const row = getRow('actors', cur.id);
  pushActor(row, by);
  const cost = [mpSpent && `${mpSpent} mana`, hpSpent && `${hpSpent} HP`].filter(Boolean).join(' + ') || 'free';
  postChat(table, user, cur.id, null, { t: 'info', text: `${cur.name} casts ${spell.name} (${cost})${spell.armed ? ' [armed]' : ''}` });
  return actorView(row, user);
});

// ---- chat & rolls
function postChat(table, user, actorId, whisper, body) {
  const r = db.prepare('INSERT INTO chat (table_id, user_id, user_name, actor_id, whisper, body, ts) VALUES (?,?,?,?,?,?,?)').run(table.id, user.id, user.name, actorId ?? null, whisper, JSON.stringify(body), now());
  const row = getRow('chat', r.lastInsertRowid);
  pushChat(row);
  return row;
}
function actorForRoll(user, table, actorId) {
  if (!actorId) return null;
  const row = inTable('actors', actorId, table.id); if (!row) throw bad('Unknown character');
  if (!canEditActor(user, row)) throw forbidden('You cannot act as this character');
  return row;
}
const avatarOf = (row) => (row ? tokenImage(jparse(row.data, {})) : null); // shown left of the name in the chat
tbl('POST', '/chat', 'player', ({ user, table, body }) => {
  let text = String(body.text ?? '').trim().slice(0, 6000);
  if (!text) throw bad('Empty message');
  let whisper = null;
  if (/^\/gm\s/i.test(text)) { whisper = 'gm'; text = text.slice(4).trim(); }
  const sys = getSystem(table.id);
  if (text.startsWith('/')) {
    const cmd = parseCommand(text); if (!cmd) throw bad('Bad command');
    const actor = actorForRoll(user, table, body.actorId);
    let result;
    try { result = executeRoll(sys, cmd, actor ? sanitizeActorData(JSON.parse(actor.data), sys) : null); }
    catch (e) { if (e instanceof FormulaError || e instanceof Error) throw bad(e.message); throw e; }
    const name = actor?.name ?? user.name;
    return chatView(postChat(table, user, actor?.id, whisper, { t: 'roll', actorName: name, avatar: avatarOf(actor), ...result }));
  }
  const speaker = actorForRoll(user, table, body.actorId);
  if (user.role === 'gm') { // narration: "@Sheet text" lines and "@mj" narration, all in one message
    const actors = db.prepare('SELECT id, name, alias, data FROM actors WHERE table_id = ?').all(table.id);
    const parts = parseNarration(text, actors);
    if (parts) {
      const byId = new Map(actors.map((a) => [a.id, a]));
      return chatView(postChat(table, user, speaker?.id, whisper, { t: 'narration', parts: parts.map((p) =>
        p.kind === 'narration' ? { narration: true, text: p.text }
          : p.kind === 'actor' ? { actorId: p.actorId, name: byId.get(p.actorId).name, avatar: avatarOf(byId.get(p.actorId)), text: p.text }
            : { actorId: speaker?.id ?? null, name: speaker?.name ?? user.name, avatar: avatarOf(speaker), text: p.text }) }));
    }
  }
  return chatView(postChat(table, user, speaker?.id, whisper, { t: 'text', text, avatar: avatarOf(speaker), name: speaker?.name }));
});
const chatIn = (user, table, id) => { const m = inTable('chat', id, table.id); if (!m || !canSeeChat(user, m)) throw notFound(); return m; };
tbl('POST', '/chat/:id/reroll', 'player', ({ user, table, by, params, body: req }) => {
  const msg = chatIn(user, table, params.id);
  const body = JSON.parse(msg.body);
  if (body.t !== 'roll') throw bad('Only rolls can be rerolled');
  if (user.role !== 'gm' && msg.user_id !== user.id) throw forbidden();
  const sys = getSystem(table.id);
  const actorRow = msg.actor_id ? inTable('actors', msg.actor_id, table.id) : null;
  const data = actorRow ? sanitizeActorData(JSON.parse(actorRow.data), sys) : null;
  // A reroll always costs the rolling character a favor, GM included. Only a GM roll with no character is free,
  // and the GM's "free reroll" button (ROADMAP 3 §1.7), which players cannot use.
  const free = req.free === true;
  if (free && user.role !== 'gm') throw forbidden('Only the GM rerolls without a favor');
  if (free) { /* nothing to pay */ } else if (actorRow) {
    if (data.fav.cur < 1) throw bad('No favor left');
    data.fav.cur -= 1;
  } else if (user.role !== 'gm') throw bad('No character on this roll to pay the favor');
  const result = executeRoll(sys, body.cmd, data);
  const next = { ...body, ...result, rerolls: (body.rerolls ?? 0) + 1, freeRerolls: (body.freeRerolls ?? 0) + (free ? 1 : 0), history: [...(body.history ?? []), body.sum], applied: [] };
  db.prepare('UPDATE chat SET body = ? WHERE id = ?').run(JSON.stringify(next), msg.id);
  if (actorRow && !free) { db.prepare('UPDATE actors SET data=?, updated=? WHERE id=?').run(JSON.stringify(data), now(), actorRow.id); pushActor(getRow('actors', actorRow.id), by); }
  const row = getRow('chat', msg.id); pushChat(row);
  return chatView(row);
});
tbl('POST', '/chat/:id/apply', 'player', ({ user, table, by, params, body }) => {
  const msg = chatIn(user, table, params.id);
  const roll = JSON.parse(msg.body);
  if (roll.t !== 'roll' || !['damage', 'heal', 'theal', 'mana'].includes(roll.kind)) throw bad('Nothing to apply');
  const sys = getSystem(table.id), gm = user.role === 'gm';
  const targets = [];
  const ids = Array.isArray(body.tokenIds) ? body.tokenIds.slice(0, 50) : [];
  if (ids.length) {
    for (const id of ids) {
      const t = tokenInTable(id, table.id); const a = t?.actor_id ? getRow('actors', t.actor_id) : null;
      // a player only applies to the tokens of sheets they can edit (every target is checked before anything changes)
      if (!gm && (!t || t.hidden || !a || !canEditActor(user, a))) throw forbidden('You can only apply effects to your own tokens');
      targets.push({ name: t?.name ?? '?', tokenId: t?.id ?? null, actor: a });
    }
  } else {
    const a = msg.actor_id ? inTable('actors', msg.actor_id, table.id) : null;
    if (!a || roll.kind === 'damage' || !canEditActor(user, a)) throw bad('Select a target token first');
    targets.push({ name: a.name, tokenId: null, actor: a });
  }
  roll.applied ??= [];
  for (const tg of targets) {
    if (!tg.actor) { roll.applied.push({ name: tg.name, note: 'no character linked' }); continue; }
    const { data, report } = applyRoll(sys, sanitizeActorData(JSON.parse(tg.actor.data), sys), roll);
    db.prepare('UPDATE actors SET data=?, updated=? WHERE id=?').run(JSON.stringify(data), now(), tg.actor.id);
    pushActor(getRow('actors', tg.actor.id), by);
    roll.applied.push({ id: randomBytes(4).toString('hex'), name: tg.name, actorId: tg.actor.id, ...report });
  }
  db.prepare('UPDATE chat SET body = ? WHERE id = ?').run(JSON.stringify(roll), msg.id);
  const row = getRow('chat', msg.id); pushChat(row);
  return chatView(row);
});
// Undo one application: gives back exactly what it took (or takes back what it gave); the same roll can be applied again.
tbl('POST', '/chat/:id/undo', 'player', ({ user, table, by, params, body }) => {
  const msg = chatIn(user, table, params.id);
  const roll = JSON.parse(msg.body);
  const entry = (roll.applied ?? []).find((x) => x.id && x.id === body.entryId);
  if (!entry || !entry.actorId) throw notFound('Unknown application');
  if (entry.undone) throw bad('Already undone');
  const actor = inTable('actors', entry.actorId, table.id); if (!actor) throw bad('That character no longer exists');
  if (!canEditActor(user, actor)) throw forbidden('You can only undo on your own characters'); // the GM can edit every sheet
  const sys = getSystem(table.id);
  const data = undoApply(sys, sanitizeActorData(JSON.parse(actor.data), sys), entry.delta);
  db.prepare('UPDATE actors SET data=?, updated=? WHERE id=?').run(JSON.stringify(data), now(), actor.id);
  pushActor(getRow('actors', actor.id), by);
  entry.undone = true;
  db.prepare('UPDATE chat SET body = ? WHERE id = ?').run(JSON.stringify(roll), msg.id);
  const row = getRow('chat', msg.id); pushChat(row);
  return chatView(row);
});
tbl('DELETE', '/chat/:id', 'gm', ({ table, params }) => {
  const m = inTable('chat', params.id, table.id); if (!m) throw notFound();
  db.prepare('DELETE FROM chat WHERE id = ?').run(m.id);
  broadcast(table.id, { type: 'chat', op: 'delete', data: { id: m.id } });
  return { ok: true };
});

// ---- rules (each table has its own copy of a system)
/** Swap a table's rules; every character's current HP/mana/favors follow the change of their maximum. */
function changeSystem(table, next) {
  const prev = getSystem(table.id);
  db.exec('BEGIN');
  try {
    for (const row of db.prepare('SELECT id, data FROM actors WHERE table_id = ?').all(table.id)) {
      const raw = jparse(row.data, {});
      const before = JSON.stringify(raw);
      followMax(resourceMaxes(prev, sanitizeActorData(raw, prev)), resourceMaxes(next, sanitizeActorData(raw, next)), raw);
      if (JSON.stringify(raw) !== before) db.prepare('UPDATE actors SET data=?, updated=? WHERE id=?').run(JSON.stringify(raw), now(), row.id);
    }
    setSystem(table.id, next);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); forgetSystem(table.id); throw e; }
  broadcast(table.id, { type: 'refresh' });
  return next;
}
tbl('GET', '/system', 'player', ({ table }) => getSystem(table.id));
tbl('PUT', '/system', 'gm', ({ table, body }) => {
  let sys; try { sys = validateSystem(body); } catch (e) { throw bad(e.message); }
  return changeSystem(table, sys);
});
tbl('POST', '/system/reset', 'gm', ({ table }) => changeSystem(table, loadDefaultSystem()));
tbl('POST', '/system/test', 'gm', ({ table, body }) => {
  const sys = getSystem(table.id);
  const row = body.actorId ? inTable('actors', body.actorId, table.id) : db.prepare('SELECT * FROM actors WHERE table_id = ? LIMIT 1').get(table.id);
  const vars = row ? actorContext(sys, sanitizeActorData(JSON.parse(row.data), sys)).vars : {};
  try {
    const r = body.dice ? evaluate(String(body.formula), vars) : { total: evaluateStatic(String(body.formula), vars), dice: [] };
    return { ok: true, total: r.total, dice: r.dice, success: r.success, target: r.target, actor: row?.name ?? null };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- audio
const audioUrl = (v) => (/^\/uploads\/[a-f0-9]{64}\.(mp3|ogg|wav|m4a|flac|webm)$/.test(v ?? '') ? v : (() => { throw bad('Invalid audio URL'); })());
const soundIn = (table, id) => { const s = inTable('sounds', id, table.id); if (!s) throw notFound(); return s; };
/** An uploaded file, or a YouTube link (stored in one canonical form; played by YouTube's player, never downloaded). */
function soundUrl(body) {
  if (body.youtube !== undefined) { const id = youtubeId(body.youtube); if (!id) throw bad('Not a YouTube video link'); return youtubeUrl(id); }
  return audioUrl(body.url);
}
tbl('POST', '/sounds', 'gm', ({ table, body }) => {
  const grp = cleanGroup(body.group);
  const r = db.prepare('INSERT INTO sounds (table_id, name, url, loop, volume, created, grp, subgrp, tags) VALUES (?,?,?,?,?,?,?,?,?)').run(table.id, String(body.name ?? 'Sound').slice(0, 80) || 'Sound', soundUrl(body), body.loop ? 1 : 0, Math.min(1, Math.max(0, num(body.volume, 1))), now(),
    grp, grp ? cleanGroup(body.subgroup) : '', JSON.stringify(cleanTags(body.tags)));
  const row = getRow('sounds', r.lastInsertRowid);
  broadcast(table.id, { type: 'sound', op: 'upsert', data: soundView(row) });
  return soundView(row);
});
tbl('PATCH', '/sounds/:id', 'gm', ({ table, params, body }) => {
  const cur = soundIn(table, params.id);
  const grp = body.group !== undefined ? cleanGroup(body.group) : cur.grp ?? '';
  const sub = !grp ? '' : body.subgroup !== undefined ? cleanGroup(body.subgroup) : cur.subgrp ?? ''; // a sub-group lives in a group
  db.prepare('UPDATE sounds SET name=?, loop=?, volume=?, grp=?, subgrp=?, tags=? WHERE id=?').run(body.name !== undefined ? String(body.name).slice(0, 80) : cur.name, body.loop !== undefined ? (body.loop ? 1 : 0) : cur.loop,
    body.volume !== undefined ? Math.min(1, Math.max(0, num(body.volume, 1))) : cur.volume, grp, sub, body.tags !== undefined ? JSON.stringify(cleanTags(body.tags)) : cur.tags ?? '[]', cur.id);
  const row = getRow('sounds', cur.id);
  broadcast(table.id, { type: 'sound', op: 'upsert', data: soundView(row) });
  return soundView(row);
});
tbl('DELETE', '/sounds/:id', 'gm', ({ table, params }) => {
  const { id } = soundIn(table, params.id);
  db.prepare('DELETE FROM sounds WHERE id = ?').run(id);
  if (playingOf(table.id).delete(id)) broadcast(table.id, { type: 'audio', op: 'stop', id });
  broadcast(table.id, { type: 'sound', op: 'delete', data: { id } });
  return { ok: true };
});
tbl('POST', '/sounds/:id/play', 'gm', ({ table, params }) => {
  const s = soundIn(table, params.id), playing = playingOf(table.id);
  const startedAt = now(); playing.set(s.id, { startedAt });
  if (!s.loop) setTimeout(() => { if (playing.get(s.id)?.startedAt === startedAt) playing.delete(s.id); }, 15 * 60_000).unref();
  broadcast(table.id, { type: 'audio', op: 'play', id: s.id, startedAt });
  return { ok: true, startedAt };
});
tbl('POST', '/sounds/:id/stop', 'gm', ({ table, params }) => { const id = idOf(params.id); playingOf(table.id).delete(id); broadcast(table.id, { type: 'audio', op: 'stop', id }); return { ok: true }; });
tbl('POST', '/audio/stop', 'gm', ({ table }) => { playingOf(table.id).clear(); broadcast(table.id, { type: 'audio', op: 'stopall' }); return { ok: true }; });

// ---- journal & handouts
const cleanVis = (v) => (v === 'all' ? 'all' : Array.isArray(v) ? v.map(Number).filter(Number.isInteger).slice(0, 100) : 'gm');
const journalIn = (table, id) => { const j = inTable('journals', id, table.id); if (!j) throw notFound(); return j; };
tbl('POST', '/journals', 'gm', ({ table, body }) => {
  const t = now();
  const r = db.prepare('INSERT INTO journals (table_id, title, body, image, visibility, created, updated, campaign_id) VALUES (?,?,?,?,?,?,?,?)').run(table.id, String(body.title ?? 'Untitled').slice(0, 120) || 'Untitled', String(body.body ?? '').slice(0, 50000), imgUrl(body.image), JSON.stringify(cleanVis(body.visibility)), t, t,
    body.campaignId !== undefined ? campaignId(body.campaignId) : table.campaign_id ?? null); // tagged with the table's campaign unless told otherwise
  const row = getRow('journals', r.lastInsertRowid); pushJournal(row);
  return journalView(row);
});
function patchJournal(cur, body) {
  db.prepare('UPDATE journals SET title=?, body=?, image=?, visibility=?, campaign_id=?, updated=? WHERE id=?').run(
    body.title !== undefined ? String(body.title).slice(0, 120) || cur.title : cur.title, body.body !== undefined ? String(body.body).slice(0, 50000) : cur.body,
    body.image !== undefined ? imgUrl(body.image) : cur.image, body.visibility !== undefined ? JSON.stringify(cleanVis(body.visibility)) : cur.visibility,
    body.campaignId !== undefined ? campaignId(body.campaignId) : cur.campaign_id, now(), cur.id);
  const row = getRow('journals', cur.id); pushJournal(row);
  return row;
}
tbl('PATCH', '/journals/:id', 'gm', ({ table, params, body }) => journalView(patchJournal(journalIn(table, params.id), body)));
/** Copy a journal entry (of another table, or outside tables) into this table: a copy, GM only until shown. */
tbl('POST', '/journals/import', 'gm', ({ table, body }) => {
  const src = getRow('journals', body.id); if (!src) throw notFound();
  if (src.table_id === table.id) throw bad('Already in this table');
  const t = now();
  const r = db.prepare('INSERT INTO journals (table_id, title, body, image, visibility, created, updated, campaign_id) VALUES (?,?,?,?,?,?,?,?)').run(table.id, src.title, src.body, src.image, '"gm"', t, t, src.campaign_id ?? table.campaign_id ?? null);
  const row = getRow('journals', r.lastInsertRowid); pushJournal(row);
  return journalView(row);
});
// The GM's journal entries outside any table (like the compendium's): list them with every table's, create, edit, delete.
const globalJournal = (id) => { const j = getRow('journals', id); if (!j) throw notFound(); return j; };
admin('POST', '/journals', ({ body }) => {
  const t = now();
  const r = db.prepare('INSERT INTO journals (table_id, title, body, image, visibility, created, updated, campaign_id) VALUES (NULL,?,?,?,?,?,?,?)').run(String(body.title ?? 'Untitled').slice(0, 120) || 'Untitled', String(body.body ?? '').slice(0, 50000), imgUrl(body.image), '"gm"', t, t, campaignId(body.campaignId));
  return journalView(getRow('journals', r.lastInsertRowid));
});
admin('PATCH', '/journals/:id', ({ params, body }) => journalView(patchJournal(globalJournal(params.id), body)));
admin('DELETE', '/journals/:id', ({ params }) => {
  const j = globalJournal(params.id);
  db.prepare('DELETE FROM journals WHERE id = ?').run(j.id);
  if (j.table_id != null) broadcast(j.table_id, { type: 'journal', op: 'delete', data: { id: j.id } });
  return { ok: true };
});
tbl('DELETE', '/journals/:id', 'gm', ({ table, params }) => {
  const { id } = journalIn(table, params.id);
  db.prepare('DELETE FROM journals WHERE id = ?').run(id);
  broadcast(table.id, { type: 'journal', op: 'delete', data: { id } });
  return { ok: true };
});
// ---- the GM's "eye" (ROADMAP 3 §3.4): show a journal entry or an NPC to chosen players, as a pop-up they close themselves.
// The event goes to the chosen players' pages ONLY (never broadcast and filtered on the page); nothing is kept, so a reload forgets it.
// "reveal" also makes it visible in the players' compendium for good.
/** The player slots of this table a "show" goes to: "all", or a list of slot ids (unknown ones are dropped). */
function showTargets(table, slots) {
  const ids = slotsOf(table.id).map((s) => s.id);
  if (slots === 'all') return new Set(ids);
  return new Set((Array.isArray(slots) ? slots : []).map(idOf).filter((id) => ids.includes(id)));
}
const showTo = (table, targets, ev) => broadcast(table.id, ev, (u) => u.role === 'player' && targets.has(u.id));
tbl('POST', '/journals/:id/show', 'gm', ({ table, params, body }) => {
  let row = journalIn(table, params.id);
  const targets = showTargets(table, body.slots ?? 'all');
  if (body.reveal === true && jparse(row.visibility, 'gm') !== 'all') {
    db.prepare('UPDATE journals SET visibility = ? WHERE id = ?').run('"all"', row.id); row = getRow('journals', row.id); pushJournal(row);
  }
  showTo(table, targets, { type: 'show', kind: 'journal', data: journalView(row, { role: 'player' }) });
  return { ...journalView(row), shownTo: [...targets] };
});
tbl('POST', '/actors/:id/show', 'gm', ({ table, params, body }) => { // an NPC: its portrait and its name, nothing else
  let row = inTable('actors', params.id, table.id); if (!row) throw notFound();
  const targets = showTargets(table, body.slots ?? 'all');
  if (body.reveal === true && !row.shown) { db.prepare('UPDATE actors SET shown = 1 WHERE id = ?').run(row.id); row = getRow('actors', row.id); pushNpcs(table.id); }
  const d = jparse(row.data, {});
  showTo(table, targets, { type: 'show', kind: 'npc', data: { id: row.id, name: row.name, portrait: d.portrait || d.token || null } });
  return { ok: true, shown: !!row.shown, shownTo: [...targets] };
});

// ---- compendium: the items and spells of a table, plus the GM's global view across tables and outside them.
// Everything named on a sheet gets an entry by itself ("auto"); it follows the last saved sheet until the GM edits it,
// and goes away when no sheet carries it any more (unless the GM made it visible).
const COMP_KINDS = ['item', 'spell'];
function cleanComp(sys, kind, data) {
  if (!COMP_KINDS.includes(kind)) throw bad('Bad kind');
  const key = { item: 'items', spell: 'spells' }[kind];
  const e = sanitizeActorData({ [key]: [data && typeof data === 'object' ? data : {}] }, sys)[key][0];
  delete e.id;
  if (kind === 'item') { e.usedSlots = []; delete e.locked; } // a template is never "equipped"; locking is the sheet's business
  return e;
}
const compName = (v, d) => String(v ?? d ?? '').trim().slice(0, 80) || d || 'Entry';
const compInTableByName = (tableId, kind, name) => db.prepare('SELECT * FROM compendium WHERE table_id IS ? AND kind = ? AND lower(trim(name)) = ?').get(tableId, kind, compKey(name));
function insertComp(tableId, kind, name, data, { visible = 0, auto = 0, campaignId = null, sourceId = null, sourceUpdated = null } = {}) {
  const t = now();
  const r = db.prepare('INSERT INTO compendium (table_id, kind, name, data, created, updated, visible, auto, campaign_id, source_id, source_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(tableId, kind, name, JSON.stringify(data), t, t, visible ? 1 : 0, auto ? 1 : 0, campaignId, sourceId, sourceUpdated);
  return getRow('compendium', r.lastInsertRowid);
}
function syncCompendium(table) {
  const sys = getSystem(table.id);
  const onSheets = new Map(); // "kind:name" -> the item / spell on the most recently saved sheet
  for (const a of db.prepare('SELECT data FROM actors WHERE table_id = ? ORDER BY updated, id').all(table.id)) {
    const d = jparse(a.data, {});
    for (const [kind, list] of [['item', d.items], ['spell', d.spells]]) for (const x of Array.isArray(list) ? list : []) {
      const k = compKey(x?.name); if (k) onSheets.set(`${kind}:${k}`, { kind, name: compName(x.name), data: x });
    }
  }
  const rows = db.prepare('SELECT * FROM compendium WHERE table_id = ?').all(table.id);
  const byKey = new Map(rows.map((r) => [`${r.kind}:${compKey(r.name)}`, r]));
  for (const [key, v] of onSheets) {
    const r = byKey.get(key), data = JSON.stringify(cleanComp(sys, v.kind, v.data));
    if (!r) pushComp(insertComp(table.id, v.kind, v.name, JSON.parse(data), { auto: 1, campaignId: table.campaign_id ?? null }));
    else if (r.auto && (r.data !== data || r.name !== v.name)) {
      db.prepare('UPDATE compendium SET name = ?, data = ?, updated = ? WHERE id = ?').run(v.name, data, now(), r.id);
      pushComp(getRow('compendium', r.id));
    }
  }
  for (const r of rows) if (r.auto && !r.visible && !onSheets.has(`${r.kind}:${compKey(r.name)}`)) {
    db.prepare('DELETE FROM compendium WHERE id = ?').run(r.id);
    broadcast(table.id, { type: 'comp', op: 'delete', data: { id: r.id } });
  }
}
const compIn = (table, id) => { const c = inTable('compendium', id, table.id); if (!c) throw notFound(); return c; };
function patchComp(cur, body, sys) {
  const name = body.name !== undefined ? compName(body.name, cur.name) : cur.name;
  if (compKey(name) !== compKey(cur.name) && compInTableByName(cur.table_id, cur.kind, name)) throw bad('An entry of that name already exists');
  const edited = body.name !== undefined || body.data !== undefined; // the GM's own version from now on
  db.prepare('UPDATE compendium SET name = ?, data = ?, visible = ?, campaign_id = ?, auto = ?, updated = ? WHERE id = ?').run(
    name, body.data !== undefined ? JSON.stringify(cleanComp(sys, cur.kind, body.data)) : cur.data,
    body.visible !== undefined ? (body.visible ? 1 : 0) : cur.visible, body.campaignId !== undefined ? campaignId(body.campaignId) : cur.campaign_id,
    edited ? 0 : cur.auto, edited ? now() : cur.updated, cur.id);
  const row = getRow('compendium', cur.id);
  if (row.table_id != null) pushComp(row);
  return row;
}
tbl('GET', '/compendium', 'player', ({ user, table }) => { // a player's fresh view (what their sheets carry changes all the time)
  const names = user.role === 'gm' ? null : namesSeenBy(user, table.id);
  return { entries: db.prepare('SELECT * FROM compendium WHERE table_id = ? ORDER BY kind, name COLLATE NOCASE').all(table.id).filter((c) => canSeeComp(user, c, names)).map((c) => compView(c, user)), npcs: npcsOf(table.id) };
});
tbl('POST', '/compendium', 'gm', ({ table, body }) => {
  const kind = body.kind, name = compName(body.name, body.data?.name);
  const data = cleanComp(getSystem(table.id), kind, { ...(body.data ?? {}), name });
  if (compInTableByName(table.id, kind, name)) throw bad('An entry of that name already exists');
  const row = insertComp(table.id, kind, name, data, { visible: body.visible, campaignId: table.campaign_id ?? null }); pushComp(row);
  return compView(row);
});
tbl('PATCH', '/compendium/:id', 'gm', ({ table, params, body }) => compView(patchComp(compIn(table, params.id), body, getSystem(table.id))));
tbl('DELETE', '/compendium/:id', 'gm', ({ table, params }) => {
  const { id } = compIn(table, params.id);
  db.prepare('DELETE FROM compendium WHERE id = ?').run(id);
  broadcast(table.id, { type: 'comp', op: 'delete', data: { id } });
  return { ok: true };
});
/** "Add to the current table": a copy (not a live link) that remembers its original. Replaces an entry of the same name. */
tbl('POST', '/compendium/import', 'gm', ({ table, body }) => {
  const src = getRow('compendium', body.id); if (!src) throw notFound();
  if (src.table_id === table.id) throw bad('Already in this table');
  const data = cleanComp(getSystem(table.id), src.kind, jparse(src.data, {}));
  const same = compInTableByName(table.id, src.kind, src.name);
  let row;
  if (same) {
    db.prepare('UPDATE compendium SET name = ?, data = ?, auto = 0, source_id = ?, source_updated = ?, updated = ? WHERE id = ?').run(src.name, JSON.stringify(data), src.id, src.updated, now(), same.id);
    row = getRow('compendium', same.id);
  } else row = insertComp(table.id, src.kind, src.name, data, { campaignId: table.campaign_id ?? null, sourceId: src.id, sourceUpdated: src.updated });
  pushComp(row);
  return compView(row);
});
tbl('POST', '/compendium/:id/refresh', 'gm', ({ table, params }) => { // take the original's current version
  const cur = compIn(table, params.id);
  const src = cur.source_id ? getRow('compendium', cur.source_id) : null; if (!src) throw bad('The original no longer exists');
  db.prepare('UPDATE compendium SET name = ?, data = ?, auto = 0, source_updated = ?, updated = ? WHERE id = ?').run(src.name, JSON.stringify(cleanComp(getSystem(table.id), cur.kind, jparse(src.data, {}))), src.updated, now(), cur.id);
  const row = getRow('compendium', cur.id); pushComp(row);
  return compView(row);
});
tbl('POST', '/actors/import', 'gm', ({ table, by, body }) => { // copy an NPC (any table's sheet) into this table
  const src = getRow('actors', body.id); if (!src || src.table_id == null) throw notFound();
  const sys = getSystem(table.id);
  const row = insertActor(table, src.name, sanitizeActorData(jparse(src.data, {}), sys));
  pushActor(row, by);
  return actorView(row, GM);
});

// The GM's global compendium: every entry of every table and outside tables, and every sheet (NPCs), with filters on the client.
const slugOf = (tableId) => (tableId == null ? null : getRow('game_tables', tableId)?.slug ?? null);
admin('GET', '/compendium', () => ({
  entries: db.prepare('SELECT * FROM compendium ORDER BY kind, name COLLATE NOCASE').all().map((c) => ({ ...compView(c), table: slugOf(c.table_id) })),
  journals: db.prepare('SELECT * FROM journals ORDER BY title COLLATE NOCASE').all().map((j) => ({ ...journalView(j), table: slugOf(j.table_id) })),
  npcs: db.prepare('SELECT id, name, data, table_id, campaign_id FROM actors WHERE table_id IS NOT NULL ORDER BY name COLLATE NOCASE').all()
    .map((a) => { const d = jparse(a.data, {}); return { id: a.id, name: a.name, portrait: tokenImage(d), level: d.bio?.level ?? 1, table: slugOf(a.table_id), campaignId: a.campaign_id ?? null }; }),
  tables: db.prepare('SELECT slug, name FROM game_tables ORDER BY name COLLATE NOCASE').all(),
  campaigns: campaignList(),
}));
/** Entries outside any table. Bonuses are checked against the rules of the table the GM is looking from ("table"), or the default rules. */
const contextSystem = (slug) => { const t = slug ? tableBySlug(slug) : null; return t ? getSystem(t.id) : loadDefaultSystem(); };
const globalComp = (id) => { const c = getRow('compendium', id); if (!c) throw notFound(); return c; };
admin('POST', '/compendium', ({ body }) => {
  const name = compName(body.name, body.data?.name);
  const data = cleanComp(contextSystem(body.table), body.kind, { ...(body.data ?? {}), name });
  if (compInTableByName(null, body.kind, name)) throw bad('An entry of that name already exists');
  return compView(insertComp(null, body.kind, name, data, { campaignId: campaignId(body.campaignId) }));
});
admin('PATCH', '/compendium/:id', ({ body, params }) => { const c = globalComp(params.id); return compView(patchComp(c, body, c.table_id != null ? getSystem(c.table_id) : contextSystem(body.table))); });
admin('DELETE', '/compendium/:id', ({ params }) => {
  const c = globalComp(params.id);
  db.prepare('DELETE FROM compendium WHERE id = ?').run(c.id);
  if (c.table_id != null) broadcast(c.table_id, { type: 'comp', op: 'delete', data: { id: c.id } });
  return { ok: true };
});

// ---- campaigns: a tag for a story / world, outside tables. A table may have one; what it creates is tagged with it.
const campaignView = (c) => ({ id: c.id, name: c.name, systemId: c.system_id ?? null });
const campaignList = () => db.prepare('SELECT * FROM campaigns ORDER BY name COLLATE NOCASE').all().map(campaignView);
function campaignId(v) { if (v == null || v === '') return null; const c = getRow('campaigns', v); if (!c) throw bad('Unknown campaign'); return c.id; }
function systemId(v) { if (v == null || v === '') return null; const s = getRow('systems', v); if (!s) throw bad('Unknown system'); return s.id; }
const campaignName = (v, d) => String(v ?? d ?? '').trim().slice(0, 60) || d || 'Campaign';
admin('GET', '/campaigns', () => ({ campaigns: campaignList() }));
admin('POST', '/campaigns', ({ body }) => {
  const r = db.prepare('INSERT INTO campaigns (name, system_id, created) VALUES (?,?,?)').run(campaignName(body.name, 'Campaign'), systemId(body.systemId), now());
  return campaignView(getRow('campaigns', r.lastInsertRowid));
});
admin('PATCH', '/campaigns/:id', ({ params, body }) => {
  const c = getRow('campaigns', params.id); if (!c) throw notFound();
  db.prepare('UPDATE campaigns SET name = ?, system_id = ? WHERE id = ?').run(body.name !== undefined ? campaignName(body.name, c.name) : c.name, body.systemId !== undefined ? systemId(body.systemId) : c.system_id, c.id);
  return campaignView(getRow('campaigns', c.id));
});
admin('DELETE', '/campaigns/:id', ({ params }) => { db.prepare('DELETE FROM campaigns WHERE id = ?').run(idOf(params.id)); return { ok: true }; });

// ---- system library: a table's rules saved under a name, to apply (after a preview of the differences) to other tables.
const systemView = (s) => ({ id: s.id, name: s.name, updated: s.updated, systemName: jparse(s.data, {}).name ?? '',
  campaigns: db.prepare('SELECT id FROM campaigns WHERE system_id = ?').all(s.id).map((c) => c.id) });
const savedSystem = (id) => { const s = getRow('systems', id); if (!s) throw notFound('Unknown system'); return s; };
const systemName = (v, d) => String(v ?? d ?? '').trim().slice(0, 60) || d || 'System';
const systemFromTable = (slug) => { const t = tableBySlug(slug); if (!t) throw bad('Unknown table'); return JSON.stringify(getSystem(t.id)); };
admin('GET', '/systems', () => ({ systems: db.prepare('SELECT * FROM systems ORDER BY name COLLATE NOCASE').all().map(systemView) }));
admin('POST', '/systems', ({ body }) => {
  const t = now();
  const r = db.prepare('INSERT INTO systems (name, data, created, updated) VALUES (?,?,?,?)').run(systemName(body.name), systemFromTable(body.table), t, t);
  return systemView(getRow('systems', r.lastInsertRowid));
});
admin('PATCH', '/systems/:id', ({ params, body }) => { // rename, and/or overwrite with a table's current rules
  const s = savedSystem(params.id);
  db.prepare('UPDATE systems SET name = ?, data = ?, updated = ? WHERE id = ?').run(body.name !== undefined ? systemName(body.name, s.name) : s.name, body.table ? systemFromTable(body.table) : s.data, body.table ? now() : s.updated, s.id);
  return systemView(getRow('systems', s.id));
});
admin('DELETE', '/systems/:id', ({ params }) => { db.prepare('DELETE FROM systems WHERE id = ?').run(savedSystem(params.id).id); return { ok: true }; });
tbl('GET', '/system/diff/:id', 'gm', ({ table, params }) => {
  const s = savedSystem(params.id);
  return { name: s.name, diff: diffSystems(getSystem(table.id), jparse(s.data, {})) };
});
tbl('POST', '/system/apply/:id', 'gm', ({ table, params }) => {
  let sys; try { sys = validateSystem(jparse(savedSystem(params.id).data, {})); } catch (e) { throw bad(e.message); }
  return changeSystem(table, sys);
});

// ------------------------------------------------------------------ ROADMAP 3 §5: table backups and campaign packs
// One ZIP file (server/zip.js), read and written in streams:
//   manifest.json  { format: "foxyverse-vtt", formatVersion, kind: "table" | "pack", name, created, appVersion }
//   data.json      everything else (see tableData / packData)
//   files/<sha256>.<ext>  every uploaded file the data points to (maps, portraits, tokens, handouts, sounds)
// formatVersion goes up when the content changes in a way an older server cannot read: a newer file is refused with a clear message.
const FORMAT = 'foxyverse-vtt', FORMAT_VERSION = 1;
const APP_VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
const TMP_DIR = join(DATA_DIR, 'tmp');
const MAX_IMPORT = (Number(process.env.IMPORT_MAX_MB) || 4096) * 1024 * 1024;
const UPLOAD_FILE = /^[a-f0-9]{64}\.(png|jpg|webp|gif|mp3|ogg|wav|m4a|flac|webm)$/;
/** The uploaded files a piece of data points to. */
const filesIn = (obj) => [...new Set([...JSON.stringify(obj).matchAll(/\/uploads\/([a-f0-9]{64}\.(?:png|jpg|webp|gif|mp3|ogg|wav|m4a|flac|webm))/g)].map((m) => m[1]))];
/** fn(), or fallback when it throws (one bad field never stops an import). */
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const campaignRefs = (ids) => [...new Set(ids.filter((x) => x != null))].map((id) => getRow('campaigns', id)).filter(Boolean).map((c) => ({ id: c.id, name: c.name }));

async function sendArchive(res, filename, kind, name, data) {
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`, 'Cache-Control': 'no-store' });
  const z = zipWriter(res);
  await z.add('manifest.json', Buffer.from(JSON.stringify({ format: FORMAT, formatVersion: FORMAT_VERSION, kind, name, created: new Date().toISOString(), appVersion: APP_VERSION }, null, 2)));
  await z.add('data.json', Buffer.from(JSON.stringify(data)));
  for (const f of filesIn(data)) if (existsSync(join(UPLOAD_DIR, f))) await z.addFile('files/' + f, join(UPLOAD_DIR, f), { level: 1 });
  await z.finish();
  res.end();
  return STREAM;
}
/** The request body, streamed into a temporary file (an archive can hold big maps and sounds). */
function receiveArchive(req) {
  mkdirSync(TMP_DIR, { recursive: true });
  const path = join(TMP_DIR, randomBytes(8).toString('hex') + '.zip');
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path); let size = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); rmSync(path, { force: true }); reject(e); };
    req.on('data', (c) => { size += c.length; if (size > MAX_IMPORT) { fail(Object.assign(new HttpError(413, 'File too large'), { cut: true })); req.destroy(); } });
    req.on('error', fail); out.on('error', fail);
    req.pipe(out);
    out.on('finish', () => { if (!failed) resolve(path); });
  });
}
/** Open, check and unpack an archive: the files go to the uploads (each checked against its name's hash and type). Returns data.json. */
async function readArchive(path, kind) {
  let zip;
  try { zip = await openZip(path); } catch (e) { throw bad(e instanceof ZipError ? 'This file is not a Foxyverse VTT archive (or it is damaged)' : e.message); }
  try {
    if (!zip.has('manifest.json')) throw bad('This file is not a Foxyverse VTT archive (no manifest)');
    let m; try { m = JSON.parse((await zip.buffer('manifest.json', 64 * 1024)).toString('utf8')); } catch { throw bad('Damaged archive: unreadable manifest'); }
    if (m?.format !== FORMAT) throw bad('This file is not a Foxyverse VTT archive');
    if (!Number.isInteger(m.formatVersion) || m.formatVersion < 1) throw bad('Damaged archive: unknown format version');
    if (m.formatVersion > FORMAT_VERSION) throw bad(`This file was made by a newer Foxyverse VTT (format ${m.formatVersion}; this server reads up to ${FORMAT_VERSION}). Update the server first.`);
    if (m.kind !== kind) throw bad(kind === 'table' ? 'This is a campaign pack, not a table backup: import it from a table (Table tab)' : 'This is a table backup, not a campaign pack: import it from the GM home');
    let data; try { data = JSON.parse((await zip.buffer('data.json')).toString('utf8')); } catch (e) { throw e instanceof ZipError ? e : bad('Damaged archive: unreadable data'); }
    if (!data || typeof data !== 'object') throw bad('Damaged archive: no data');
    for (const name of zip.names) {
      const f = name.startsWith('files/') ? name.slice(6) : null; if (!f || !UPLOAD_FILE.test(f)) continue;
      const dest = join(UPLOAD_DIR, f); if (existsSync(dest)) continue; // the same content is already here
      const tmp = `${dest}.part-${randomBytes(4).toString('hex')}`, hash = createHash('sha256'); let head = null;
      try {
        await zip.extract(name, tmp, { max: Math.max(MAX_UPLOAD, MAX_AUDIO), onChunk: (c) => { hash.update(c); head ??= c; } });
        const ext = f.split('.')[1];
        if (hash.digest('hex') !== f.slice(0, 64) || !head || !SNIFF[ext](head)) throw new ZipError(`${f} does not match its name or type`);
        renameSync(tmp, dest);
      } finally { rmSync(tmp, { force: true }); }
    }
    return { manifest: m, data };
  } catch (e) {
    if (e instanceof ZipError) throw bad('Damaged archive: ' + e.message);
    throw e;
  } finally { await zip.close(); }
}
/** Campaigns of an archive, matched by name with this server's (created when missing). Returns old id -> local id. */
function mapCampaigns(refs) {
  const map = new Map();
  for (const c of Array.isArray(refs) ? refs : []) {
    const name = campaignName(c?.name, ''); if (!name) continue;
    const found = db.prepare('SELECT id FROM campaigns WHERE lower(name) = lower(?)').get(name);
    map.set(c.id, found?.id ?? Number(db.prepare('INSERT INTO campaigns (name, created) VALUES (?,?)').run(name, now()).lastInsertRowid));
  }
  return map;
}
/** A free address and name for an imported table: "-2", "(2)"... when taken. */
function freeSlug(want) {
  let base = String(want ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'table';
  if (RESERVED.has(base)) base += '-t';
  if (!tableBySlug(base)) return base;
  for (let n = 2; ; n++) if (!tableBySlug(`${base}-${n}`)) return `${base}-${n}`;
}
function freeTableName(want) {
  const base = tableName(want, 'Table'), taken = (n) => !!db.prepare('SELECT 1 FROM game_tables WHERE lower(name) = lower(?)').get(n);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) { const x = `${base.slice(0, 54)} (${n})`; if (!taken(x)) return x; }
}
const soundSource = (url) => { const yt = youtubeId(url); return yt ? youtubeUrl(yt) : audioUrl(url); };

/** Everything of a table (a full backup). Exploration memories and who is connected are not part of it. */
function tableData(table) {
  const all = (sql) => db.prepare(sql).all(table.id);
  const actors = all('SELECT * FROM actors WHERE table_id = ? ORDER BY id'), journals = all('SELECT * FROM journals WHERE table_id = ? ORDER BY id');
  const comp = all('SELECT * FROM compendium WHERE table_id = ? ORDER BY id');
  return {
    table: { name: table.name, slug: table.slug, listed: !!table.listed, campaignId: table.campaign_id ?? null },
    campaigns: campaignRefs([table.campaign_id, ...actors.map((a) => a.campaign_id), ...journals.map((j) => j.campaign_id), ...comp.map((c) => c.campaign_id)]),
    system: getSystem(table.id),
    slots: slotsOf(table.id).map((s) => ({ id: s.id, name: s.name, color: s.color })),
    scenes: all('SELECT * FROM scenes WHERE table_id = ? ORDER BY id').map(sceneView),
    tokens: all('SELECT t.* FROM tokens t JOIN scenes s ON s.id = t.scene_id WHERE s.table_id = ? ORDER BY t.id').map((t) => ({ id: t.id, sceneId: t.scene_id, actorId: t.actor_id, name: t.name, x: t.x, y: t.y, size: t.size,
      image: t.image, color: t.color, hidden: !!t.hidden, vision: t.vision, light: t.light, sight: !!t.sight, life: t.life ?? 'auto' })),
    actors: actors.map((a) => ({ id: a.id, name: a.name, data: jparse(a.data, {}), alias: a.alias, aliasAuto: !!a.alias_auto, shown: !!a.shown, campaignId: a.campaign_id ?? null, perms: permsOf(a.id) })),
    chat: all('SELECT * FROM chat WHERE table_id = ? ORDER BY id').map((m) => ({ userId: m.user_id, userName: m.user_name, actorId: m.actor_id, whisper: m.whisper, body: jparse(m.body, {}), ts: m.ts })),
    journals: journals.map((j) => ({ id: j.id, title: j.title, body: j.body, image: j.image, visibility: jparse(j.visibility, 'gm'), campaignId: j.campaign_id ?? null, created: j.created, updated: j.updated })),
    compendium: comp.map((c) => ({ id: c.id, kind: c.kind, name: c.name, data: jparse(c.data, {}), visible: !!c.visible, auto: !!c.auto, campaignId: c.campaign_id ?? null, sourceId: c.source_id, sourceUpdated: c.source_updated, created: c.created, updated: c.updated })),
    sounds: all('SELECT * FROM sounds WHERE table_id = ? ORDER BY id').map((s) => ({ name: s.name, url: s.url, loop: !!s.loop, volume: s.volume, group: s.grp ?? '', subgroup: s.subgrp ?? '', tags: jparse(s.tags, []), created: s.created })),
  };
}
const list = (v) => (Array.isArray(v) ? v : []);
/** Sheets of an archive into a table: sanitised, with fresh unique aliases. Returns old id -> new id. */
function insertActors(tableId, sys, actors, campOf, { keepShown = true } = {}) {
  const map = new Map(), t = now();
  for (const a of list(actors)) {
    const name = String(a?.name ?? 'Character').slice(0, 80) || 'Character', data = sanitizeActorData(a?.data, sys);
    const r = db.prepare('INSERT INTO actors (table_id, name, owner_id, data, created, updated, campaign_id, alias, alias_auto, shown) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(tableId, name, null, JSON.stringify(data), t, t, campOf(a?.campaignId), uniqueAlias(aliasFrom(a?.alias ?? '') || name, aliasesOf(tableId)), a?.aliasAuto === false ? 0 : 1, keepShown && a?.shown ? 1 : 0);
    map.set(a?.id, Number(r.lastInsertRowid));
  }
  return map;
}
function insertJournal(tableId, j, visibility, campaign) {
  const t = now();
  db.prepare('INSERT INTO journals (table_id, title, body, image, visibility, created, updated, campaign_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(tableId, String(j?.title ?? 'Untitled').slice(0, 120) || 'Untitled', String(j?.body ?? '').slice(0, 50000), safe(() => imgUrl(j?.image)), JSON.stringify(visibility), Number(j?.created) || t, Number(j?.updated) || t, campaign);
}
function insertSound(tableId, s) {
  const url = safe(() => soundSource(s?.url)); if (!url) return;
  const grp = cleanGroup(s?.group);
  db.prepare('INSERT INTO sounds (table_id, name, url, loop, volume, created, grp, subgrp, tags) VALUES (?,?,?,?,?,?,?,?,?)').run(tableId, String(s?.name ?? 'Sound').slice(0, 80) || 'Sound', url, s?.loop ? 1 : 0,
    Math.min(1, Math.max(0, num(s?.volume, 1))), Number(s?.created) || now(), grp, grp ? cleanGroup(s?.subgroup) : '', JSON.stringify(cleanTags(s?.tags)));
}
/** A compendium entry's original, when it exists on this server (same kind and name): the copy remembers it. */
const localSource = (id, kind, name) => { const src = id != null ? getRow('compendium', id) : null; return src && src.kind === kind && compKey(src.name) === compKey(name) ? src : null; };

/** A table backup into a new table; every id is remapped (slots, scenes, sheets, tokens, chat, journal visibility). */
function importTable(d, { name, slug }) {
  let sys; try { sys = validateSystem(d.system); } catch (e) { throw bad('Damaged archive: invalid rules (' + e.message + ')'); }
  db.exec('BEGIN');
  try {
    const campMap = mapCampaigns(d.campaigns), campOf = (id) => campMap.get(id) ?? null;
    const tSlug = freeSlug(slug || d.table?.slug), tName = freeTableName(name || d.table?.name || tSlug);
    const tableId = Number(db.prepare('INSERT INTO game_tables (slug, name, listed, system, created, campaign_id) VALUES (?,?,?,?,?,?)').run(tSlug, tName, d.table?.listed === false ? 0 : 1, JSON.stringify(sys), now(), campOf(d.table?.campaignId)).lastInsertRowid);
    const slotMap = new Map();
    for (const s of list(d.slots)) slotMap.set(s?.id, Number(db.prepare('INSERT INTO slots (table_id, name, color, created) VALUES (?,?,?,?)').run(tableId, slotName(s?.name, 'Player'), color(s?.color), now()).lastInsertRowid));
    const sceneMap = new Map();
    for (const s of list(d.scenes)) {
      const f = sceneFields({ ...s, image: safe(() => imgUrl(s?.image)) });
      const r = db.prepare('INSERT INTO scenes (table_id, name, image, width, height, grid, ox, oy, active, created, fog, dark, walls, lights, reveal, shared, explore, tps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(tableId, f.name, f.image, f.width, f.height, f.grid, f.ox, f.oy, s?.active ? 1 : 0, now(), f.fog, f.dark, f.walls, f.lights, f.reveal, f.shared, f.explore, f.tps);
      sceneMap.set(s?.id, Number(r.lastInsertRowid));
    }
    if (sceneMap.size && !db.prepare('SELECT 1 FROM scenes WHERE table_id = ? AND active = 1').get(tableId)) db.prepare('UPDATE scenes SET active = 1 WHERE id = ?').run([...sceneMap.values()][0]);
    const actorMap = insertActors(tableId, sys, d.actors, campOf);
    for (const a of list(d.actors)) for (const [sid, lvl] of Object.entries(a?.perms ?? {})) {
      const slot = slotMap.get(Number(sid)), actor = actorMap.get(a?.id);
      if (slot && actor && PERM_LEVELS.includes(lvl)) db.prepare('INSERT OR IGNORE INTO actor_perms (actor_id, slot_id, level) VALUES (?,?,?)').run(actor, slot, lvl);
    }
    for (const t of list(d.tokens)) {
      const scene = sceneMap.get(t?.sceneId); if (!scene) continue;
      db.prepare('INSERT INTO tokens (scene_id, name, x, y, size, image, color, actor_id, hidden, vision, light, sight, life) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(scene, String(t?.name ?? 'Token').slice(0, 60), num(t?.x), num(t?.y),
        Math.min(10, Math.max(0.25, num(t?.size, 1))), safe(() => imgUrl(t?.image)), color(t?.color), actorMap.get(t?.actorId) ?? null, t?.hidden ? 1 : 0,
        Math.min(100, Math.max(0, num(t?.vision, 100))), Math.min(100, Math.max(0, num(t?.light, 0))), t?.sight ? 1 : 0, ['dead', 'alive'].includes(t?.life) ? t.life : 'auto');
    }
    const remapActor = (id) => (id == null ? null : actorMap.get(id) ?? null);
    for (const m of list(d.chat).slice(-5000)) {
      const body = m?.body && typeof m.body === 'object' ? structuredClone(m.body) : { t: 'info', text: '' };
      for (const p of list(body.parts)) if (p && 'actorId' in p) p.actorId = remapActor(p.actorId);
      for (const a of list(body.applied)) if (a && 'actorId' in a) a.actorId = remapActor(a.actorId);
      const text = JSON.stringify(body); if (text.length > 200_000) continue;
      const user = m?.userId === 0 ? 0 : slotMap.get(m?.userId) ?? null;
      db.prepare('INSERT INTO chat (table_id, user_id, user_name, actor_id, whisper, body, ts) VALUES (?,?,?,?,?,?,?)').run(tableId, user, String(m?.userName ?? '?').slice(0, 60), remapActor(m?.actorId), m?.whisper === 'gm' ? 'gm' : null, text, Number(m?.ts) || now());
    }
    for (const j of list(d.journals)) {
      const v = cleanVis(j?.visibility);
      insertJournal(tableId, j, Array.isArray(v) ? v.map((id) => slotMap.get(id)).filter(Boolean) : v, campOf(j?.campaignId));
    }
    const seen = new Set();
    for (const c of list(d.compendium)) {
      const data = safe(() => cleanComp(sys, c?.kind, c?.data)); if (!data) continue;
      const cname = compName(c?.name, 'Entry'), key = `${c.kind}:${compKey(cname)}`; if (seen.has(key)) continue; seen.add(key);
      const src = c?.sourceId != null ? localSource(c.sourceId, c.kind, cname) : null;
      insertComp(tableId, c.kind, cname, data, { visible: c?.visible, auto: c?.auto, campaignId: campOf(c?.campaignId), sourceId: src?.id ?? null, sourceUpdated: src ? Number(c?.sourceUpdated) || null : null });
    }
    for (const s of list(d.sounds)) insertSound(tableId, s);
    db.exec('COMMIT');
    return adminTableView(getRow('game_tables', tableId));
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
admin('GET', '/tables/:slug/archive', ({ res, params }) => {
  const t = tableBySlug(params.slug); if (!t) throw notFound();
  return sendArchive(res, `${t.slug}-${new Date().toISOString().slice(0, 10)}.zip`, 'table', t.name, tableData(t));
});
admin('POST', '/tables/archive', async ({ req, url }) => {
  const path = await receiveArchive(req);
  try {
    const { data } = await readArchive(path, 'table');
    const made = importTable(data, { name: url.searchParams.get('name'), slug: url.searchParams.get('slug') });
    syncCompendium(tableBySlug(made.slug));
    return made;
  } finally { rmSync(path, { force: true }); }
});

// ---- campaign packs: the GM picks what goes in among what the campaign holds; imported into a table, everything is copied there
const ids = (v) => new Set(list(v).map(idOf));
function campaignContents(c) {
  const tables = db.prepare('SELECT id, slug, name FROM game_tables WHERE campaign_id = ?').all(c.id), tIds = tables.map((t) => t.id);
  const inT = (sql) => (tIds.length ? db.prepare(sql.replace('(?)', `(${tIds.map(() => '?').join(',')})`)).all(...tIds) : []);
  const sys = c.system_id ? getRow('systems', c.system_id) : null;
  const comp = db.prepare('SELECT * FROM compendium WHERE campaign_id = ? ORDER BY kind, name COLLATE NOCASE').all(c.id);
  return {
    campaign: campaignView(c), system: sys ? { id: sys.id, name: sys.name } : null,
    items: comp.filter((x) => x.kind === 'item'), spells: comp.filter((x) => x.kind === 'spell'),
    actors: db.prepare('SELECT * FROM actors WHERE campaign_id = ? ORDER BY name COLLATE NOCASE').all(c.id),
    scenes: inT('SELECT * FROM scenes WHERE table_id IN (?) ORDER BY name COLLATE NOCASE'),
    journals: db.prepare('SELECT * FROM journals WHERE campaign_id = ? ORDER BY title COLLATE NOCASE').all(c.id),
    sounds: inT('SELECT * FROM sounds WHERE table_id IN (?) ORDER BY name COLLATE NOCASE'),
  };
}
const brief = (rows, label = (r) => r.name) => rows.map((r) => ({ id: r.id, name: label(r), table: slugOf(r.table_id) }));
admin('GET', '/campaigns/:id/contents', ({ params }) => {
  const c = getRow('campaigns', params.id); if (!c) throw notFound();
  const x = campaignContents(c);
  return { campaign: x.campaign, system: x.system, items: brief(x.items), spells: brief(x.spells), actors: brief(x.actors), scenes: brief(x.scenes), journals: brief(x.journals, (j) => j.title), sounds: brief(x.sounds) };
});
admin('POST', '/packs', ({ res, body }) => {
  const c = getRow('campaigns', body.campaignId); if (!c) throw bad('Unknown campaign');
  const x = campaignContents(c), pick = (rows, key) => { const want = ids(body[key]); return rows.filter((r) => want.has(r.id)); };
  const sys = body.system && x.system ? safe(() => validateSystem(jparse(getRow('systems', x.system.id).data, {}))) : null;
  const scenes = pick(x.scenes, 'scenes'), comp = [...pick(x.items, 'items'), ...pick(x.spells, 'spells')];
  const data = {
    name: String(body.name ?? c.name).slice(0, 60) || c.name, campaign: { name: c.name }, system: sys, // a pack never holds chat or player slots
    compendium: comp.map((e) => ({ id: e.id, kind: e.kind, name: e.name, data: jparse(e.data, {}), updated: e.updated })),
    actors: pick(x.actors, 'actors').map((a) => ({ id: a.id, name: a.name, data: jparse(a.data, {}), alias: a.alias, aliasAuto: !!a.alias_auto })),
    scenes: scenes.map((s) => { const { id, active, ...v } = sceneView(s); return v; }), // eslint-disable-line no-unused-vars
    journals: pick(x.journals, 'journals').map((j) => ({ title: j.title, body: j.body, image: j.image })),
    sounds: pick(x.sounds, 'sounds').map((s) => ({ name: s.name, url: s.url, loop: !!s.loop, volume: s.volume, group: s.grp ?? '', subgroup: s.subgrp ?? '', tags: jparse(s.tags, []) })),
  };
  return sendArchive(res, `${data.name}.pack.zip`, 'pack', data.name, data);
});
/** A pack into a table: copies, tagged with the pack's campaign; compendium copies remember their original (when it is on this server). */
function importPack(table, d, { applySystem = false } = {}) {
  const sys = getSystem(table.id), counts = { items: 0, spells: 0, actors: 0, scenes: 0, journals: 0, sounds: 0, system: false };
  let packSys = null;
  if (d.system) { try { packSys = validateSystem(d.system); } catch (e) { throw bad('Damaged pack: invalid rules (' + e.message + ')'); } }
  db.exec('BEGIN');
  try {
    const camp = d.campaign?.name ? mapCampaigns([{ id: 'pack', name: d.campaign.name }]).get('pack') : table.campaign_id ?? null;
    for (const c of list(d.compendium)) {
      const data = safe(() => cleanComp(sys, c?.kind, c?.data)); if (!data) continue;
      const cname = compName(c?.name, 'Entry'), src = localSource(c?.id, c.kind, cname), same = compInTableByName(table.id, c.kind, cname);
      if (same) db.prepare('UPDATE compendium SET name = ?, data = ?, auto = 0, campaign_id = ?, source_id = ?, source_updated = ?, updated = ? WHERE id = ?').run(cname, JSON.stringify(data), camp, src?.id ?? null, src ? src.updated : null, now(), same.id);
      else insertComp(table.id, c.kind, cname, data, { campaignId: camp, sourceId: src?.id ?? null, sourceUpdated: src ? src.updated : null });
      counts[c.kind === 'spell' ? 'spells' : 'items']++;
    }
    counts.actors = insertActors(table.id, sys, d.actors, () => camp, { keepShown: false }).size;
    for (const s of list(d.scenes)) { insertScene(table.id, sceneFields({ ...s, image: safe(() => imgUrl(s?.image)) })); counts.scenes++; }
    for (const j of list(d.journals)) { insertJournal(table.id, j, 'gm', camp); counts.journals++; }
    for (const s of list(d.sounds)) { insertSound(table.id, s); counts.sounds++; }
    if (packSys) { // kept in the system library; linked to the campaign if it has none; applied to this table only when asked
      const t = now(), sid = Number(db.prepare('INSERT INTO systems (name, data, created, updated) VALUES (?,?,?,?)').run(systemName(`${d.name || d.campaign?.name || 'Pack'} (pack)`), JSON.stringify(packSys), t, t).lastInsertRowid);
      if (camp) db.prepare('UPDATE campaigns SET system_id = ? WHERE id = ? AND system_id IS NULL').run(sid, camp);
      counts.system = true;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (packSys && applySystem) changeSystem(table, packSys); else broadcast(table.id, { type: 'refresh' });
  syncCompendium(table);
  return counts;
}
tbl('POST', '/packs/archive', 'gm', async ({ req, url, table }) => {
  const path = await receiveArchive(req);
  try {
    const { data } = await readArchive(path, 'pack');
    return importPack(table, data, { applySystem: url.searchParams.get('applySystem') === '1' });
  } finally { rmSync(path, { force: true }); }
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
// Pages of the single-page client: "/", "/<table>", "/admin", "/admin/<table>".
const isPage = (p) => p === '/' || /^\/[a-z0-9-]+\/?$/.test(p) || /^\/admin(\/[a-z0-9-]*)?\/?$/.test(p);

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // YouTube's embedded player (ROADMAP 3 §4.1): its script and its frame, nothing else from outside
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https://i.ytimg.com; style-src 'self' 'unsafe-inline'; script-src 'self' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; media-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://x');
  let path = url.pathname, user = null;
  try {
    try { path = decodeURIComponent(url.pathname); } catch { throw bad('Malformed URL'); } // e.g. /%E0 used to crash the whole server
    if (isAdminPath(path) && !secretOk(req)) throw forbidden('GM area: missing or wrong X-Admin-Secret (requests must come through the reverse proxy)');
    if (req.method === 'GET' && path.startsWith('/uploads/')) {
      const name = path.slice(9);
      if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif|mp3|ogg|wav|m4a|flac|webm)$/.test(name)) throw notFound();
      return sendFile(req, res, join(UPLOAD_DIR, name), { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    if (path.startsWith('/api/') || path.startsWith('/admin/api/')) {
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw forbidden('Cross-origin request blocked');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(path); if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        let table = null;
        if (r.scope === 'gm' || r.scope === 'player') { table = tableBySlug(params.slug); if (!table) throw notFound('No table at this address'); }
        if (r.scope === 'gm' || r.scope === 'admin') user = GM;
        if (r.scope === 'player') { user = playerFor(req, table); if (!user) throw new HttpError(401, 'Choose your player first'); }
        const body = req.method === 'GET' || req.method === 'DELETE' || r.raw ? {} : await readJson(req);
        const by = String(req.headers['x-client'] ?? url.searchParams.get('c') ?? '').slice(0, 40) || null; // echo id of the sending page
        const out = await r.handler({ req, res, url, user, table, params, body, by });
        if (out === STREAM) return;
        return json(res, 200, out);
      }
      throw notFound('Unknown endpoint');
    }
    // static client
    if (req.method !== 'GET') throw notFound();
    if (isPage(path)) return sendFile(req, res, join(PUBLIC, 'index.html'), { 'Cache-Control': 'no-cache' });
    const file = join(PUBLIC, normalize(path));
    if (!file.startsWith(PUBLIC + sep)) throw notFound();
    return sendFile(req, res, file, { 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) {
      if (e.cut) return; // the oversized upload was cut off: nobody is listening for an answer
      return json(res, e.status, { ...(e.data ?? {}), error: e.message });
    }
    logServerError(e, { method: req.method, path, user });
    return json(res, 500, { error: 'Server error' });
  }
});

for (const t of db.prepare('SELECT * FROM game_tables').all()) syncCompendium(t); // sheets saved before automatic entries existed

server.listen(PORT, HOST, () => {
  console.log(`Foxyverse VTT listening on http://${HOST}:${server.address().port} (players: /, GM: /admin)`);
  if (!ADMIN_SECRET) console.warn('WARNING: ADMIN_SECRET is empty, so /admin is open to anyone who can reach this port (development mode). See README, "GM access".');
});
const stop = () => { server.close(); db.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('unhandledRejection', (e) => logServerError(e, { method: 'async', path: '(unhandled rejection)' }));
