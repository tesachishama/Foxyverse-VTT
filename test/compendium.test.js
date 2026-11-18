// Phase B: table compendium (automatic entries, player visibility, NPC list), the GM's global compendium, campaigns, system library.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());
const names = (entries) => entries.map((e) => `${e.kind}:${e.name}`).sort();
const sheetWith = async (gm, name, items = [], spells = []) => {
  const a = (await gm('POST', '/actors', { name })).body;
  return (await gm('PATCH', `/actors/${a.id}`, { data: { ...a.data, items, spells } })).body;
};

test('items and spells named on a sheet enter the table compendium by themselves, and follow the sheet', async () => {
  const { gm } = await srv.table('auto');
  const hero = await sheetWith(gm, 'Hero', [{ name: 'Épée', type: 'weapon', pdef: 1 }, { name: '', type: 'other' }], [{ name: 'Spark', cost: 2 }]);
  let comp = (await gm('GET', '/state')).body.compendium;
  assert.deepEqual(names(comp), ['item:Épée', 'spell:Spark']); // unnamed items are ignored
  const sword = comp.find((c) => c.name === 'Épée'); // unaccented / accented names are different names
  assert.equal(sword.auto, true); assert.equal(sword.category, 'weapon'); assert.deepEqual(sword.data.usedSlots, []);
  // typing a name letter by letter does not leave half-names behind; edits on the sheet flow into the automatic entry
  const d = hero.data; d.items[0].name = 'Ép'; await gm('PATCH', `/actors/${hero.id}`, { data: d });
  d.items[0].name = 'épée'; d.items[0].pdef = 3; await gm('PATCH', `/actors/${hero.id}`, { data: d });
  comp = (await gm('GET', '/state')).body.compendium;
  assert.deepEqual(names(comp), ['item:épée', 'spell:Spark']); // the half-typed "Ép" and the old name went away
  const blade = comp.find((c) => c.kind === 'item');
  assert.equal(blade.data.pdef, 3); assert.equal(blade.auto, true);
  // once the GM edits an entry it is theirs: the sheet no longer overwrites it, and it stays without sheets
  await gm('PATCH', `/compendium/${blade.id}`, { data: { ...blade.data, notes: 'Forged by dwarves' } });
  d.items[0].pdef = 9; await gm('PATCH', `/actors/${hero.id}`, { data: d });
  const mine = (await gm('GET', '/state')).body.compendium.find((c) => c.id === blade.id);
  assert.equal(mine.auto, false); assert.equal(mine.data.notes, 'Forged by dwarves'); assert.equal(mine.data.pdef, 3);
  d.items = []; d.spells = []; await gm('PATCH', `/actors/${hero.id}`, { data: d });
  assert.deepEqual(names((await gm('GET', '/state')).body.compendium), ['item:épée']); // the automatic spell went with its last sheet
  // the GM creates entries in place; names are unique per kind; talents are not compendium entries
  assert.equal((await gm('POST', '/compendium', { kind: 'spell', name: 'Ward', data: { cost: 4 } })).status, 200);
  assert.equal((await gm('POST', '/compendium', { kind: 'spell', name: 'ward' })).status, 400);
  assert.equal((await gm('POST', '/compendium', { kind: 'talent', name: 'Brave' })).status, 400);
  assert.equal((await gm('PATCH', `/compendium/${blade.id}`, { name: 'Ward' })).status, 200); // another kind: fine
});

test('players see the entries on sheets they can see, plus the ones the GM shows; NPCs show name and picture only', async () => {
  const T = await srv.table('vis');
  const slot = await T.slot('Pip');
  const pip = await T.join(slot.id);
  const mineSheet = await sheetWith(T.gm, 'Pip hero', [{ name: 'Rope' }], [{ name: 'Light' }]);
  const secret = await sheetWith(T.gm, 'Villain', [{ name: 'Cursed blade' }]);
  await T.gm('POST', '/compendium', { kind: 'item', name: 'Treasure map' });
  assert.deepEqual(names((await pip('GET', '/compendium')).body.entries), []);
  await T.gm('PUT', `/actors/${mineSheet.id}/perms`, { perms: { [slot.id]: 'view' } }); // view is enough
  assert.deepEqual(names((await pip('GET', '/compendium')).body.entries), ['item:Rope', 'spell:Light']);
  const map = (await T.gm('GET', '/state')).body.compendium.find((c) => c.name === 'Treasure map');
  const sse = await srv.events('/api/t/vis/events', pip.cookie);
  const shown = sse.next((e) => e.type === 'comp' && e.op === 'upsert');
  await T.gm('PATCH', `/compendium/${map.id}`, { visible: true });
  assert.equal((await shown).data.name, 'Treasure map'); sse.close();
  const view = (await pip('GET', '/state')).body.compendium;
  assert.deepEqual(names(view), ['item:Rope', 'item:Treasure map', 'spell:Light']);
  assert.equal(view[0].visible, undefined); assert.equal(view[0].auto, undefined); // GM details stay with the GM
  assert.equal((await pip('PATCH', `/compendium/${map.id}`, { visible: false })).status, 404);
  // NPC list: the GM picks which sheets players see listed; never the sheet itself
  assert.deepEqual((await pip('GET', '/state')).body.npcs, []);
  assert.equal((await pip('PATCH', `/actors/${secret.id}`, { shown: true })).status, 403);
  await T.gm('PATCH', `/actors/${secret.id}`, { shown: true });
  const npcs = (await pip('GET', '/state')).body.npcs;
  assert.deepEqual(npcs, [{ id: secret.id, name: 'Villain', portrait: null }]);
  assert.ok(!(await pip('GET', '/state')).body.actors.some((a) => a.id === secret.id));
  assert.ok(!names((await pip('GET', '/compendium')).body.entries).includes('item:Cursed blade'));
});

test('global compendium: every table and outside tables; "add to table" copies, remembers the original and warns when it changed', async () => {
  const { call } = srv;
  const A = await srv.table('glob-a'), B = await srv.table('glob-b');
  await sheetWith(A.gm, 'A hero', [{ name: 'Lantern', type: 'other' }]);
  const npcA = await sheetWith(A.gm, 'Goblin');
  const outside = await call('POST', '/admin/api/compendium', { kind: 'spell', name: 'Meteor', data: { cost: 9, effect: 'Boom' }, table: 'glob-a' });
  assert.equal(outside.status, 200);
  const all = (await call('GET', '/admin/api/compendium')).body;
  const lantern = all.entries.find((e) => e.name === 'Lantern'), meteor = all.entries.find((e) => e.name === 'Meteor');
  assert.equal(lantern.table, 'glob-a'); assert.equal(meteor.table, null);
  assert.ok(all.npcs.some((n) => n.id === npcA.id && n.table === 'glob-a'));
  assert.ok(all.tables.some((t) => t.slug === 'glob-b'));
  // copy into B
  const copy = (await B.gm('POST', '/compendium/import', { id: meteor.id })).body;
  assert.notEqual(copy.id, meteor.id); assert.equal(copy.data.effect, 'Boom');
  assert.deepEqual(copy.source, { id: meteor.id, exists: true, stale: false });
  const lanternCopy = (await B.gm('POST', '/compendium/import', { id: lantern.id })).body;
  assert.equal((await B.gm('POST', '/compendium/import', { id: copy.id })).status, 400); // already in this table
  // the original outside tables changes: the copy says so, and can be updated
  await new Promise((r) => setTimeout(r, 5));
  await call('PATCH', `/admin/api/compendium/${meteor.id}`, { data: { cost: 12, effect: 'Bigger boom' } });
  const stale = (await B.gm('GET', '/state')).body.compendium.find((c) => c.id === copy.id);
  assert.equal(stale.source.stale, true); assert.equal(stale.data.effect, 'Boom'); // a copy, not a live link
  const fresh = (await B.gm('POST', `/compendium/${copy.id}/refresh`)).body;
  assert.equal(fresh.source.stale, false); assert.equal(fresh.data.effect, 'Bigger boom');
  // an original inside another table changing does not warn (only originals outside tables do)
  await A.gm('PATCH', `/compendium/${lantern.id}`, { data: { notes: 'brighter' } });
  assert.equal((await B.gm('GET', '/state')).body.compendium.find((c) => c.id === lanternCopy.id).source.stale, false);
  // importing a name that already exists replaces that entry instead of duplicating it
  await call('PATCH', `/admin/api/compendium/${meteor.id}`, { data: { cost: 1 } });
  const again = (await B.gm('POST', '/compendium/import', { id: meteor.id })).body;
  assert.equal(again.id, copy.id); assert.equal(again.data.cost, 1);
  // NPCs copy from table to table
  const gob = (await B.gm('POST', '/actors/import', { id: npcA.id })).body;
  assert.equal(gob.name, 'Goblin'); assert.notEqual(gob.id, npcA.id); assert.deepEqual(gob.perms, {});
  // outside entries are edited and deleted from the global view
  assert.equal((await call('DELETE', `/admin/api/compendium/${meteor.id}`)).status, 200);
  assert.equal((await B.gm('GET', '/state')).body.compendium.find((c) => c.id === copy.id).source.exists, false);
});

test('campaigns tag what a table creates; a campaign\'s system seeds new tables', async () => {
  const { call } = srv;
  const C = await srv.table('camp-src');
  const sys = (await C.gm('GET', '/system')).body;
  sys.derived.find((d) => d.id === 'maxhp').formula = 'con*7';
  await C.gm('PUT', '/system', sys);
  const saved = (await call('POST', '/admin/api/systems', { name: 'Grim rules', table: 'camp-src' })).body;
  const camp = (await call('POST', '/admin/api/campaigns', { name: 'Ashlands', systemId: saved.id })).body;
  assert.deepEqual((await call('GET', '/admin/api/campaigns')).body.campaigns, [{ id: camp.id, name: 'Ashlands', systemId: saved.id }]);
  assert.equal((await call('POST', '/admin/api/campaigns', { name: 'x', systemId: 99999 })).status, 400);
  const made = (await call('POST', '/admin/api/tables', { slug: 'ash-1', campaignId: camp.id })).body;
  assert.equal(made.campaignId, camp.id);
  const ash = (m, p, b) => call(m, '/admin/api/t/ash-1' + p, b);
  const hero = (await ash('POST', '/actors', { name: 'Ash hero' })).body;
  assert.equal(hero.computed.derived.maxhp, 35); // con 5 * 7: the campaign's rules
  assert.equal(hero.campaignId, camp.id);
  await ash('PATCH', `/actors/${hero.id}`, { data: { ...hero.data, items: [{ name: 'Ash cloak' }] } });
  const all = (await call('GET', '/admin/api/compendium')).body;
  assert.equal(all.entries.find((e) => e.name === 'Ash cloak').campaignId, camp.id);
  assert.equal(all.npcs.find((n) => n.id === hero.id).campaignId, camp.id);
  // switching campaign does not touch the rules by itself (the GM applies the linked system after a preview)
  await call('PATCH', '/admin/api/tables/camp-src', { campaignId: camp.id });
  assert.equal((await call('GET', '/admin/api/tables')).body.tables.find((t) => t.slug === 'camp-src').campaignId, camp.id);
  await call('PATCH', '/admin/api/tables/camp-src', { campaignId: null });
  assert.equal((await call('PATCH', '/admin/api/tables/camp-src', { campaignId: 424242 })).status, 400);
  // deleting the campaign just removes the tag
  await call('DELETE', `/admin/api/campaigns/${camp.id}`);
  assert.equal((await call('GET', '/admin/api/tables')).body.tables.find((t) => t.slug === 'ash-1').campaignId, null);
});

test('system library: save a table\'s rules, preview the differences, apply them to another table', async () => {
  const { call } = srv;
  const A = await srv.table('sys-a'), B = await srv.table('sys-b');
  const sys = (await A.gm('GET', '/system')).body;
  sys.derived.find((d) => d.id === 'maxhp').formula = 'con*4';
  sys.stats.find((s) => s.id === 'focus').label = 'Focus!';
  sys.rules.push({ title: 'House rule', body: 'Tea break every hour' });
  await A.gm('PUT', '/system', sys);
  const saved = (await call('POST', '/admin/api/systems', { name: 'House', table: 'sys-a' })).body;
  assert.equal(saved.name, 'House');
  assert.equal((await call('POST', '/admin/api/systems', { name: 'x', table: 'nope' })).status, 400);
  const hero = (await B.gm('POST', '/actors', { name: 'B hero' })).body; // 10/10 HP under the default rules
  const { diff } = (await B.gm('GET', `/system/diff/${saved.id}`)).body;
  assert.deepEqual(diff.map((d) => [d.path, d.op]).sort(), [['derived.maxhp.formula', 'changed'], ['rules.House rule', 'added'], ['stats.focus.label', 'changed']]);
  assert.equal(diff.find((d) => d.path === 'derived.maxhp.formula').after, 'con*4');
  assert.equal((await B.gm('POST', `/system/apply/${saved.id}`)).status, 200);
  const after = (await B.gm('GET', '/state')).body.actors.find((a) => a.id === hero.id);
  assert.equal(after.computed.derived.maxhp, 20); assert.equal(after.data.hp.cur, 20); // current HP followed the max
  assert.deepEqual((await B.gm('GET', `/system/diff/${saved.id}`)).body.diff, []);
  // update the saved system from a table, rename it, delete it
  sys.derived.find((d) => d.id === 'maxhp').formula = 'con*5';
  await A.gm('PUT', '/system', sys);
  await call('PATCH', `/admin/api/systems/${saved.id}`, { name: 'House v2', table: 'sys-a' });
  const list = (await call('GET', '/admin/api/systems')).body.systems;
  assert.equal(list.find((x) => x.id === saved.id).name, 'House v2');
  assert.equal((await B.gm('GET', `/system/diff/${saved.id}`)).body.diff[0].after, 'con*5');
  assert.equal((await call('DELETE', `/admin/api/systems/${saved.id}`)).status, 200);
  assert.equal((await B.gm('GET', `/system/diff/${saved.id}`)).status, 404);
  assert.equal((await srv.call('GET', `/api/t/sys-b/system/diff/1`)).status, 404); // does not exist on the player door
});
