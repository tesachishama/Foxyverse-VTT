import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

test('full session: table, player slot, sheet rights, rolls, apply, undo, favor, realtime', async () => {
  const { gm, slot, join } = await srv.table('main');
  const pipSlot = await slot('Pip');
  const pip = await join(pipSlot.id);
  const state = await gm('GET', '/state');
  assert.equal(state.body.system.stats.length, 7);
  assert.equal(state.body.me.name, 'MJ'); assert.equal(state.body.me.role, 'gm');
  assert.equal((await pip('GET', '/state')).body.me.name, 'Pip');

  // cross-origin writes are refused
  assert.equal((await pip('POST', '/chat', { text: 'x' }, { Origin: 'http://evil.example' })).status, 403);

  // GM actions do not exist on the player door at all; players cannot create sheets
  assert.equal((await pip('POST', '/scenes', { name: 'Hall' })).status, 404);
  assert.equal((await pip('POST', '/actors', { name: 'Mine' })).status, 404);
  assert.equal((await pip('PUT', '/system', state.body.system)).status, 404);
  const scene = await gm('POST', '/scenes', { name: 'Tavern', width: 1400, height: 1000, grid: 70 });
  assert.equal(scene.body.active, true); // first scene auto-activates

  // the GM makes a sheet; it is invisible to the player until the GM gives a right
  const hero = await gm('POST', '/actors', { name: 'Hero' });
  assert.equal(hero.body.computed.derived.maxhp, 10);
  assert.equal((await pip('GET', '/state')).body.actors.length, 0);
  assert.equal((await pip('PATCH', `/actors/${hero.body.id}`, { name: 'Mine now' })).status, 403);
  const perm = await gm('PUT', `/actors/${hero.body.id}/perms`, { perms: { [pipSlot.id]: 'edit', 99999: 'edit' } });
  assert.deepEqual(perm.body.perms, { [pipSlot.id]: 'edit' }); // unknown players are dropped
  const mine = (await pip('GET', '/state')).body;
  assert.equal(mine.actors.length, 1); assert.equal(mine.actors[0].perm, 'edit'); assert.equal(mine.actors[0].perms, undefined);

  // edit: stats are sanitised and derived values recomputed server-side
  const data = hero.body.data; data.stats.constitution.base = 15; data.bio.level = 3;
  const upd = await pip('PATCH', `/actors/${hero.body.id}`, { data });
  assert.equal(upd.body.computed.derived.maxhp, 60);
  assert.equal(upd.body.data.hp.cur, 60); assert.equal(upd.body.data.fav.cur, 2); // full stays full: 10/10 -> 60/60, favors 1 -> 2

  // SSE: the GM hears about a player's roll
  const sse = await srv.events('/admin/api/t/main/events');
  const heard = sse.next((e) => e.type === 'chat');
  assert.equal((await pip('POST', '/chat', { text: '/wibble 2' })).status, 400);
  const roll = await pip('POST', '/chat', { text: '/con +1|test', actorId: hero.body.id });
  assert.equal(roll.body.body.results[0].target, 15);
  assert.equal(roll.body.userName, 'Pip');
  const evt = await heard; sse.close();
  assert.equal(evt.data.body.t, 'roll');

  // whispers to the GM are hidden from other players
  await gm('POST', '/chat', { text: '/gm secret' });
  assert.ok(!(await pip('GET', '/state')).body.chat.some((m) => m.body.text === 'secret'));

  // damage: the GM applies to a token linked to the hero, as often as wanted, and can undo one application
  const tok = await gm('POST', '/tokens', { sceneId: scene.body.id, actorId: hero.body.id, x: 100, y: 100 });
  const dmg = await gm('POST', '/chat', { text: '/tdmg 7' });
  assert.equal(dmg.body.userName, 'MJ');
  assert.equal((await pip('POST', `/chat/${dmg.body.id}/apply`, { tokenIds: [tok.body.id] })).status, 403);
  const applied = await gm('POST', `/chat/${dmg.body.id}/apply`, { tokenIds: [tok.body.id] });
  assert.equal(applied.body.body.applied[0].dealt, 7);
  const again = await gm('POST', `/chat/${dmg.body.id}/apply`, { tokenIds: [tok.body.id] });
  assert.equal(again.body.body.applied.length, 2); assert.equal(again.body.body.applied[1].dealt, 7);
  const hpOf = async () => (await gm('GET', '/state')).body.actors.find((a) => a.id === hero.body.id).data.hp.cur;
  assert.equal(await hpOf(), 46);
  const first = again.body.body.applied[0];
  assert.equal((await pip('POST', `/chat/${dmg.body.id}/undo`, { entryId: first.id })).status, 403); // players cannot undo damage
  const undone = await gm('POST', `/chat/${dmg.body.id}/undo`, { entryId: first.id });
  assert.equal(undone.body.body.applied[0].undone, true); assert.ok(!undone.body.body.applied[1].undone);
  assert.equal(await hpOf(), 53); // only that application is given back
  assert.equal((await gm('POST', `/chat/${dmg.body.id}/undo`, { entryId: first.id })).status, 400); // once
  assert.equal((await gm('POST', `/chat/${dmg.body.id}/undo`, { entryId: 'nope' })).status, 404);

  // token movement: a player with the edit right may move it, others may not (view right included)
  assert.equal((await pip('PATCH', `/tokens/${tok.body.id}`, { x: 210, y: 140 })).body.x, 210);
  const quillSlot = await slot('Quill');
  const quill = await join(quillSlot.id);
  assert.equal((await quill('PATCH', `/tokens/${tok.body.id}`, { x: 1, y: 1 })).status, 403);
  await gm('PUT', `/actors/${hero.body.id}/perms`, { perms: { [pipSlot.id]: 'edit', [quillSlot.id]: 'view' } });
  const qa = (await quill('GET', '/state')).body.actors;
  assert.equal(qa.length, 1); assert.equal(qa[0].perm, 'view');
  assert.equal((await quill('PATCH', `/tokens/${tok.body.id}`, { x: 1, y: 1 })).status, 403);
  assert.equal((await quill('PATCH', `/actors/${hero.body.id}`, { name: 'x' })).status, 403);
  assert.equal((await quill('POST', '/chat', { text: '/con', actorId: hero.body.id })).status, 403); // cannot roll as it
  // hidden tokens disappear for players
  await gm('PATCH', `/tokens/${tok.body.id}`, { hidden: true });
  assert.equal((await quill('GET', '/state')).body.tokens.length, 0);

  // favor reroll costs the player a favor (level 3 -> 2 favors)
  const r1 = await pip('POST', `/chat/${roll.body.id}/reroll`);
  assert.equal(r1.body.body.rerolls, 1);
  assert.equal((await pip('GET', '/state')).body.actors[0].data.fav.cur, 1);
  assert.equal((await pip('POST', `/chat/${roll.body.id}/reroll`)).status, 200);
  assert.equal((await pip('POST', `/chat/${roll.body.id}/reroll`)).status, 400); // none left
  assert.equal((await quill('POST', `/chat/${roll.body.id}/reroll`)).status, 403); // not their roll
  assert.equal((await gm('POST', `/chat/${roll.body.id}/reroll`)).status, 400);  // the GM pays a favor too: none left
  assert.equal((await gm('POST', `/chat/${dmg.body.id}/reroll`)).status, 200);  // a GM roll with no character is free

  // system editor: invalid formulas are rejected, valid ones take effect everywhere
  const sys = state.body.system;
  sys.derived[0].formula = 'con*2';
  assert.equal((await gm('PUT', '/system', sys)).status, 200);
  assert.equal((await pip('GET', '/state')).body.actors[0].computed.derived.maxhp, 30);
  sys.derived[0].formula = '2d6';
  assert.equal((await gm('PUT', '/system', sys)).status, 400);
  const t = await gm('POST', '/system/test', { formula: 'con*(lvl+1)' });
  assert.equal(t.body.total, 60);
});

test('chat: avatars next to names; GM narration with @mentions in one message; players cannot narrate', async () => {
  const { gm, slot, join } = await srv.table('talk');
  const pipSlot = await slot('Pip');
  const pip = await join(pipSlot.id);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);
  const up = await (await fetch(srv.base + '/admin/api/t/talk/upload', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const gwen = (await gm('POST', '/actors', { name: 'Gwen' })).body;
  await gm('PATCH', `/actors/${gwen.id}`, { data: { ...gwen.data, token: up.url } });
  const dawn = (await gm('POST', '/actors', { name: 'Dawn Upper' })).body;
  await gm('PUT', `/actors/${gwen.id}/perms`, { perms: { [pipSlot.id]: 'edit' } });
  const said = await pip('POST', '/chat', { text: 'Hello', actorId: gwen.id });
  assert.equal(said.body.body.avatar, up.url); assert.equal(said.body.actorId, gwen.id);
  const rolled = await pip('POST', '/chat', { text: '/con', actorId: gwen.id });
  assert.equal(rolled.body.body.avatar, up.url);
  assert.equal((await pip('POST', '/chat', { text: '@mj I narrate' })).body.body.t, 'text'); // players: plain text
  const n = await gm('POST', '/chat', { text: 'Listen.\n@Gwen Hi!\n@Dawn Upper Hello back\n@mj Silence falls.', actorId: dawn.id });
  assert.equal(n.body.body.t, 'narration');
  assert.deepEqual(n.body.body.parts, [
    { actorId: dawn.id, name: 'Dawn Upper', avatar: null, text: 'Listen.' }, // before any @: the identity chosen in the selector
    { actorId: gwen.id, name: 'Gwen', avatar: up.url, text: 'Hi!' },
    { actorId: dawn.id, name: 'Dawn Upper', avatar: null, text: 'Hello back' },
    { narration: true, text: 'Silence falls.' },
  ]);
  assert.equal((await gm('POST', '/chat', { text: '@mj   ' })).status, 200); // nothing left to say: still one message
  assert.equal((await gm('POST', '/chat', { text: 'x'.repeat(5000) })).body.body.text.length, 5000); // long scenes fit
});
