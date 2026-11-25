// ROADMAP 2 behaviours through the HTTP API (rights are checked by the server, not only hidden in the page).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, T, gm, pip, quill, pipSlot, quillSlot, scene;
before(async () => {
  srv = await startServer();
  T = await srv.table('r2');
  gm = T.gm;
  pipSlot = await T.slot('Pip'); quillSlot = await T.slot('Quill');
  pip = await T.join(pipSlot.id); quill = await T.join(quillSlot.id);
  scene = (await gm('POST', '/scenes', { name: 'Hall', width: 1400, height: 1000, grid: 70 })).body;
});
after(() => srv.stop());

const sheet = async (name, perms = {}) => {
  const a = (await gm('POST', '/actors', { name })).body;
  if (Object.keys(perms).length) await gm('PUT', `/actors/${a.id}/perms`, { perms });
  return a;
};
const hpOf = async (id) => (await gm('GET', '/state')).body.actors.find((a) => a.id === id).data.hp.cur;

test('1.1 armor per roll through the API: the applied entry lists every roll and its reduction', async () => {
  const a = await sheet('Armored');
  const d = a.data; d.stats.constitution.base = 20; d.items = [{ name: 'Plate', type: 'armor', usedSlots: ['torso'], pdef: 4 }];
  await gm('PATCH', `/actors/${a.id}`, { data: d });
  const tok = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: a.id })).body;
  const before = await hpOf(a.id);
  const r = await gm('POST', '/chat', { text: '/pdmg 3 6' }); // three rolls of 6
  const ap = (await gm('POST', `/chat/${r.body.id}/apply`, { tokenIds: [tok.id] })).body.body.applied[0];
  assert.deepEqual(ap.rolls, [{ raw: 6, armor: 4, dealt: 2 }, { raw: 6, armor: 4, dealt: 2 }, { raw: 6, armor: 4, dealt: 2 }]);
  assert.equal(ap.dealt, 6); assert.equal(await hpOf(a.id), before - 6);
  await gm('POST', `/chat/${r.body.id}/undo`, { entryId: ap.id });
  assert.equal(await hpOf(a.id), before);
});

test('1.3 players apply and undo only on tokens of sheets they can edit (403 otherwise, checked server-side)', async () => {
  const mine = await sheet('Mine', { [pipSlot.id]: 'edit', [quillSlot.id]: 'view' });
  const other = await sheet('Other');
  const t1 = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: mine.id })).body;
  const t2 = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: other.id })).body;
  const loose = (await gm('POST', '/tokens', { sceneId: scene.id, name: 'Barrel' })).body;
  const dmg = await pip('POST', '/chat', { text: '/tdmg 3' });
  const apply = (who, ids) => who('POST', `/chat/${dmg.body.id}/apply`, { tokenIds: ids });
  assert.equal((await apply(quill, [t1.id])).status, 403); // view right only
  assert.equal((await apply(pip, [t2.id])).status, 403);   // no right at all
  assert.equal((await apply(pip, [loose.id])).status, 403); // no sheet behind it
  const hp = await hpOf(mine.id);
  assert.equal((await apply(pip, [t1.id, t2.id])).status, 403); // one forbidden target: nothing is applied
  assert.equal(await hpOf(mine.id), hp);
  const ok = await apply(pip, [t1.id]);
  assert.equal(ok.status, 200); assert.equal(await hpOf(mine.id), hp - 3);
  const entry = ok.body.body.applied.at(-1);
  assert.equal((await quill('POST', `/chat/${dmg.body.id}/undo`, { entryId: entry.id })).status, 403);
  assert.equal((await pip('POST', `/chat/${dmg.body.id}/undo`, { entryId: entry.id })).status, 200);
  assert.equal(await hpOf(mine.id), hp);
  // the GM's application on someone else's sheet cannot be undone by the player either
  const g = (await gm('POST', `/chat/${dmg.body.id}/apply`, { tokenIds: [t2.id] })).body.body.applied.at(-1);
  assert.equal((await pip('POST', `/chat/${dmg.body.id}/undo`, { entryId: g.id })).status, 403);
  // a hidden token is not the player's to target, even with the edit right
  await gm('PATCH', `/tokens/${t1.id}`, { hidden: true });
  assert.equal((await apply(pip, [t1.id])).status, 403);
});

test('1.4 aliases: made from the name, unique in the table, GM-only, follow renames until set by hand, mj/gm refused', async () => {
  const a = await sheet('Gwen Doline', { [pipSlot.id]: 'edit' });
  const b = await sheet('Gwen  Doline');
  assert.equal(a.alias, 'GwenDoline'); assert.equal(b.alias, 'GwenDoline2');
  assert.equal((await pip('GET', '/state')).body.actors.find((x) => x.id === a.id).alias, undefined); // players never see it
  assert.equal((await pip('PATCH', `/actors/${a.id}`, { alias: 'Hack' })).status, 403);
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { name: 'Gwen the Second' })).body.alias, 'GwentheSecond'); // follows the name
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { alias: 'Gwen 2' })).body.alias, 'Gwen2');
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { name: 'Renamed' })).body.alias, 'Gwen2'); // set by hand: kept
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { alias: 'gwendoline' })).body.alias, 'gwendoline2'); // taken: a number
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { alias: 'MJ' })).status, 400);
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { alias: '' })).body.alias, 'Renamed'); // empty: back to the name
  const n = await gm('POST', '/chat', { text: '@GwenDoline Hello\n@Renamed Hi' });
  assert.deepEqual(n.body.body.parts.map((p) => [p.actorId, p.name, p.text]), [[a.id, 'Gwen Doline', 'Hello'], [b.id, 'Renamed', 'Hi']]);
});
