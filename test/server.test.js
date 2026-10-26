import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'foxy-'));
let proc;

const call = async (method, path, body, cookie, extra = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/me'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
after(() => { proc.kill(); rmSync(dataDir, { recursive: true, force: true }); });

test('full session: accounts, permissions, rolls, apply, favor, realtime', async () => {
  // first user is GM; second needs the invite code
  const gm = await call('POST', '/api/register', { name: 'Mistress', password: 'longpassword' });
  assert.equal(gm.body.user.role, 'gm');
  const state = await call('GET', '/api/state', null, gm.cookie);
  assert.equal(state.body.system.stats.length, 7);
  const code = state.body.invite.code;
  assert.equal((await call('POST', '/api/register', { name: 'Pip', password: 'longpassword', invite: 'nope' })).status, 403);
  const pip = await call('POST', '/api/register', { name: 'Pip', password: 'longpassword', invite: code });
  assert.equal(pip.body.user.role, 'player');
  assert.equal((await call('POST', '/api/login', { name: 'Pip', password: 'wrongwrong' })).status, 401);

  // cross-origin writes are refused
  assert.equal((await call('POST', '/api/chat', { text: 'x' }, pip.cookie, { Origin: 'http://evil.example' })).status, 403);

  // GM-only endpoints
  assert.equal((await call('POST', '/api/scenes', { name: 'Hall' }, pip.cookie)).status, 403);
  const scene = await call('POST', '/api/scenes', { name: 'Tavern', width: 1400, height: 1000, grid: 70 }, gm.cookie);
  assert.equal(scene.body.active, true); // first scene auto-activates

  // player makes a character; the GM cannot be fooled about who owns what
  const hero = await call('POST', '/api/actors', { name: 'Hero' }, pip.cookie);
  assert.equal(hero.body.computed.derived.maxhp, 10);
  const mine = (await call('GET', '/api/state', null, pip.cookie)).body;
  assert.equal(mine.actors.length, 1);

  // edit: stats are sanitised and derived values recomputed server-side
  const data = hero.body.data; data.stats.constitution.base = 15; data.bio.level = 3;
  const upd = await call('PATCH', `/api/actors/${hero.body.id}`, { data }, pip.cookie);
  assert.equal(upd.body.computed.derived.maxhp, 60);

  // SSE: the GM hears about a player's roll
  const sse = await fetch(BASE + '/api/events', { headers: { Cookie: gm.cookie } });
  const reader = sse.body.getReader(); const dec = new TextDecoder();
  const heard = (async () => { let buf = ''; for (;;) { const { value } = await reader.read(); buf += dec.decode(value); const m = /data: (.*chat.*)\n/.exec(buf); if (m) return JSON.parse(m[1]); } })();

  const bad = await call('POST', '/api/chat', { text: '/wibble 2' }, pip.cookie);
  assert.equal(bad.status, 400);
  const roll = await call('POST', '/api/chat', { text: '/con +1|test', actorId: hero.body.id }, pip.cookie);
  assert.equal(roll.body.body.results[0].target, 15);
  const evt = await heard; reader.cancel();
  assert.equal(evt.type, 'chat'); assert.equal(evt.data.body.t, 'roll');

  // whispers to the GM are hidden from other players
  await call('POST', '/api/chat', { text: '/gm secret' }, gm.cookie);
  const pipChat = (await call('GET', '/api/state', null, pip.cookie)).body.chat;
  assert.ok(!pipChat.some((m) => m.body.text === 'secret'));

  // damage: GM applies to a token linked to the hero
  const tok = await call('POST', '/api/tokens', { sceneId: scene.body.id, actorId: hero.body.id, x: 100, y: 100 }, gm.cookie);
  const dmg = await call('POST', '/api/chat', { text: '/tdmg 7' }, gm.cookie);
  assert.equal((await call('POST', `/api/chat/${dmg.body.id}/apply`, { tokenIds: [tok.body.id] }, pip.cookie)).status, 403);
  const applied = await call('POST', `/api/chat/${dmg.body.id}/apply`, { tokenIds: [tok.body.id] }, gm.cookie);
  assert.equal(applied.body.body.applied[0].dealt, 7);
  const again = await call('POST', `/api/chat/${dmg.body.id}/apply`, { tokenIds: [tok.body.id] }, gm.cookie);
  assert.equal(again.body.body.applied.at(-1).note, 'already applied');

  // token movement: owner may move it, others may not
  assert.equal((await call('PATCH', `/api/tokens/${tok.body.id}`, { x: 210, y: 140 }, pip.cookie)).body.x, 210);
  const pip2 = await call('POST', '/api/register', { name: 'Quill', password: 'longpassword', invite: code });
  assert.equal((await call('PATCH', `/api/tokens/${tok.body.id}`, { x: 1, y: 1 }, pip2.cookie)).status, 403);
  // hidden tokens disappear for players
  await call('PATCH', `/api/tokens/${tok.body.id}`, { hidden: true }, gm.cookie);
  assert.equal((await call('GET', '/api/state', null, pip2.cookie)).body.tokens.length, 0);

  // favor reroll costs the player a favor (created at level 1 -> 1 favor; leveling does not refill it)
  const r1 = await call('POST', `/api/chat/${roll.body.id}/reroll`, null, pip.cookie);
  assert.equal(r1.body.body.rerolls, 1);
  const heroNow = (await call('GET', '/api/state', null, pip.cookie)).body.actors[0];
  assert.equal(heroNow.data.fav.cur, 0);
  assert.equal((await call('POST', `/api/chat/${roll.body.id}/reroll`, null, pip.cookie)).status, 400); // none left
  assert.equal((await call('POST', `/api/chat/${roll.body.id}/reroll`, null, gm.cookie)).status, 200);  // GM rerolls are free

  // system editor: invalid formulas are rejected, valid ones take effect everywhere
  const sys = state.body.system;
  sys.derived[0].formula = 'con*2';
  assert.equal((await call('PUT', '/api/system', sys, pip.cookie)).status, 403);
  assert.equal((await call('PUT', '/api/system', sys, gm.cookie)).status, 200);
  assert.equal((await call('GET', '/api/state', null, pip.cookie)).body.actors[0].computed.derived.maxhp, 30);
  sys.derived[0].formula = '2d6';
  assert.equal((await call('PUT', '/api/system', sys, gm.cookie)).status, 400);
  const t = await call('POST', '/api/system/test', { formula: 'con*(lvl+1)' }, gm.cookie);
  assert.equal(t.body.total, 60);
});
