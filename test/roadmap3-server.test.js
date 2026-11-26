// ROADMAP 3: server behaviours (rights are checked on the server, not only hidden buttons).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, T, gm, pip, pipSlot, scene;
before(async () => {
  srv = await startServer();
  T = await srv.table('r3');
  gm = T.gm;
  pipSlot = await T.slot('Pip');
  pip = await T.join(pipSlot.id);
  scene = (await gm('POST', '/scenes', { name: 'S', width: 1000, height: 1000, grid: 50 })).body;
});
after(() => srv.stop());

test('1.2 a deleted token comes back on undo with its look (life is accepted on creation); players cannot delete tokens or edit the map', async () => {
  const tk = (await gm('POST', '/tokens', { sceneId: scene.id, name: 'Back', x: 10, y: 10, life: 'dead', hidden: true })).body;
  assert.equal(tk.life, 'dead'); assert.equal(tk.hidden, true);
  assert.equal((await gm('POST', '/tokens', { sceneId: scene.id, life: 'zombie' })).body.life, 'auto');
  assert.equal((await pip('DELETE', `/tokens/${tk.id}`)).status, 404); // no such route on the player door
  assert.equal((await pip('PATCH', `/scenes/${scene.id}`, { walls: [] })).status, 404);
  assert.equal((await gm('DELETE', `/tokens/${tk.id}`)).status, 200);
});

export { srv, T, gm, pip, pipSlot, scene };

test('1.3 revealed areas: rectangles and polygons are stored, junk and polygons under 3 points are dropped', async () => {
  const r = await gm('PATCH', `/scenes/${scene.id}`, { reveal: [[1, 2, -3, 4], { poly: [[0, 0], [10.04, 0], [0, 'x'], [5, 5]] }, { poly: [[0, 0], [1, 1]] }, 'junk', { poly: 7 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.reveal, [[1, 2, 3, 4], { poly: [[0, 0], [10, 0], [0, 0], [5, 5]] }]);
  await gm('PATCH', `/scenes/${scene.id}`, { reveal: [] });
});

test('1.6 a click on a TP ghost: the player\'s token jumps to the ghost (linked cell), and a ghost stays on the cell it left', async () => {
  const sc = (await gm('POST', '/scenes', { name: 'TP', width: 1000, height: 1000, grid: 50,
    tps: [{ id: 'a', x: 75, y: 75, group: 'g' }, { id: 'b', x: 775, y: 775, group: 'g' }], walls: [[400, 0, 400, 1000, 0, 0, 0, 1, 1]] })).body;
  await gm('POST', `/scenes/${sc.id}/activate`);
  const hero = (await gm('POST', '/actors', { name: 'Jumper' })).body;
  await gm('PUT', `/actors/${hero.id}/perms`, { perms: { [pipSlot.id]: 'edit' } });
  const tk = (await gm('POST', '/tokens', { sceneId: sc.id, actorId: hero.id, x: 75, y: 75 })).body;
  // the click sends the ghost's own position, "via" the cell it stands on (a tangible wall between the cells does not matter)
  const r = await pip('PATCH', `/tokens/${tk.id}`, { x: 775, y: 775, via: 'b' });
  assert.equal(r.status, 200); assert.deepEqual([r.body.x, r.body.y], [775, 775]);
  const { ghostsOf } = await import('../public/tp.js');
  const ghosts = ghostsOf([r.body], (await gm('GET', '/state')).body.scenes.find((s) => s.id === sc.id).tps, 50);
  assert.deepEqual(ghosts.map((g) => [g.x, g.y]), [[75, 75]]); // the old cell now shows the ghost
  assert.equal((await pip('PATCH', `/tokens/${tk.id}`, { x: 75, y: 75, via: 'zzz' })).status, 409); // not a linked cell
});

test('1.7 the GM\'s free reroll costs no favor; players cannot use it; the normal reroll still costs a favor, GM included', async () => {
  const hero = (await gm('POST', '/actors', { name: 'Lucky' })).body;
  await gm('PUT', `/actors/${hero.id}/perms`, { perms: { [pipSlot.id]: 'edit' } });
  const favs = async () => (await gm('GET', '/state')).body.actors.find((a) => a.id === hero.id).data.fav.cur;
  const start = await favs();
  assert.ok(start >= 1);
  const roll = (await pip('POST', '/chat', { text: '/con', actorId: hero.id })).body;
  assert.equal((await pip('POST', `/chat/${roll.id}/reroll`, { free: true })).status, 403);
  assert.equal(await favs(), start);
  const free = await gm('POST', `/chat/${roll.id}/reroll`, { free: true });
  assert.equal(free.status, 200); assert.equal(free.body.body.rerolls, 1); assert.equal(free.body.body.freeRerolls, 1);
  assert.equal(await favs(), start);
  assert.equal((await gm('POST', `/chat/${roll.id}/reroll`)).status, 200);
  assert.equal(await favs(), start - 1);
});

// ---------------------------------------------------------------- 2.3 manual mode
const manualSheet = async (name) => {
  const a = (await gm('POST', '/actors', { name })).body;
  await gm('PUT', `/actors/${a.id}/perms`, { perms: { [pipSlot.id]: 'edit' } });
  return a;
};
const setManual = (who, a, manual) => who('PATCH', `/actors/${a.id}`, { data: { ...a.data, manual } });
for (const [key, path, value] of [['maxhp', 'derived.maxhp', 77], ['maxmp', 'derived.maxmp', 55], ['maxfav', 'derived.maxfav', 9], ['act', 'derived.act', 4], ['pdef', 'pdef', 12], ['mdef', 'mdef', 8]]) {
  test(`2.3 manual mode: a typed ${key} wins over the formula, only while the mode is on`, async () => {
    const a = await manualSheet('Manual ' + key);
    const get = (r) => path.split('.').reduce((o, k) => o[k], r.body.computed);
    const before = get({ body: a });
    const on = await setManual(gm, a, { on: true, [key]: value });
    assert.equal(on.status, 200); assert.equal(get(on), value); assert.equal(on.body.data.manual[key], value);
    const off = await setManual(gm, on.body, { ...on.body.data.manual, on: false });
    assert.equal(get(off), before); // the typed value is kept, unused
    assert.equal(off.body.data.manual[key], value);
  });
}
test('2.3 manual mode: values are sanitised (ranges, empty = formula); only the GM changes it, players keep it as it is', async () => {
  const a = await manualSheet('Manual rights');
  const r = await setManual(gm, a, { on: 'yes', maxhp: -5, maxfav: 5000, act: 'x', pdef: '', mdef: 3.7 });
  assert.deepEqual(r.body.data.manual, { on: false, maxhp: 0, maxmp: null, maxfav: 999, act: null, pdef: null, mdef: 3 });
  const on = await setManual(gm, a, { on: true, maxhp: 50 });
  const pipTry = await setManual(pip, on.body, { on: false, maxhp: 999 });
  assert.equal(pipTry.status, 200); // the rest of the sheet saves...
  assert.deepEqual([pipTry.body.data.manual.on, pipTry.body.data.manual.maxhp, pipTry.body.computed.derived.maxhp], [true, 50, 50]); // ...the manual mode does not change
  const pipOn = await setManual(pip, a, { on: true, maxhp: 1 });
  assert.equal(pipOn.body.data.manual.maxhp, 50);
});

test('2.4 items are locked by default (a saved "edit" unlocks); players edit the bonuses of their own items; compendium copies carry no lock', async () => {
  const a = await manualSheet('Gear');
  const items = [{ name: 'Old sword', type: 'weapon' }, { name: 'New ring', type: 'other', locked: false, bonuses: { strength: 1 } }];
  const r = await gm('PATCH', `/actors/${a.id}`, { data: { ...a.data, items } });
  assert.deepEqual(r.body.data.items.map((i) => i.locked), [true, false]);
  // a player with the edit right changes a bonus (trust decision: no extra check beyond the sheet's edit right)
  const mine = r.body.data.items.map((i) => (i.name === 'New ring' ? { ...i, bonuses: { strength: 3 }, usedSlots: ['other'] } : i));
  const p = await pip('PATCH', `/actors/${a.id}`, { data: { ...r.body.data, items: mine } });
  assert.equal(p.status, 200); assert.equal(p.body.data.items[1].bonuses.strength, 3);
  assert.equal(p.body.computed.stats.strength.item, 3);
  const entry = (await gm('GET', '/compendium')).body.entries.find((e) => e.name === 'New ring');
  assert.equal(entry.data.locked, undefined);
});

test('2.5 only the GM puts tokens down (players have no such route)', async () => {
  const a = await manualSheet('Placed');
  assert.equal((await pip('POST', '/tokens', { sceneId: scene.id, actorId: a.id, x: 75, y: 75 })).status, 404);
  const tk = await gm('POST', '/tokens', { sceneId: scene.id, actorId: a.id, x: 75, y: 125 });
  assert.equal(tk.status, 200); assert.deepEqual([tk.body.x, tk.body.y, tk.body.actorId], [75, 125, a.id]);
});

test('2.7 a sheet window shows what the server sends: a view-only player gets the sheet but cannot save it; an invisible sheet is not sent', async () => {
  const seen = (await gm('POST', '/actors', { name: 'Seen' })).body, hidden = (await gm('POST', '/actors', { name: 'Hidden' })).body;
  await gm('PUT', `/actors/${seen.id}/perms`, { perms: { [pipSlot.id]: 'view' } });
  const st = (await pip('GET', '/state')).body;
  assert.equal(st.actors.find((a) => a.id === seen.id)?.perm, 'view');
  assert.equal(st.actors.find((a) => a.id === hidden.id), undefined);
  assert.equal((await pip('PATCH', `/actors/${seen.id}`, { name: 'Renamed' })).status, 403);
});

test('2.8 bio labels are renamed per language in the system (defaults for old systems); the sheet has a race field', async () => {
  const sys = (await gm('GET', '/system')).body;
  assert.deepEqual(sys.labels.bio.element, { fr: 'Élément', en: 'Element' });
  const { labels, ...old } = sys; // a system saved before labels existed
  const put = await gm('PUT', '/system', { ...old, labels: { bio: { element: { fr: '  Affinité ', en: 'x'.repeat(99) }, race: { fr: '' } } } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.labels.bio.element, { fr: 'Affinité', en: 'x'.repeat(40) });
  assert.deepEqual(put.body.labels.bio.race, { fr: 'Race', en: 'Race' }); // empty = default
  assert.deepEqual((await gm('PUT', '/system', old)).body.labels.bio.level, { fr: 'Niveau', en: 'Level' });
  const a = (await gm('POST', '/actors', { name: 'Elf', data: { bio: { race: 'Elfe'.repeat(30), level: 2 } } })).body;
  assert.equal(a.data.bio.race.length, 60); assert.equal(a.data.bio.level, 2);
  assert.equal((await pip('GET', '/system')).body.labels.bio.element.fr, 'Élément'); // players read the labels too
});

test('2.8 a table whose rules were saved before the labels existed still gets the default labels', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { join } = await import('node:path');
  await srv.call('POST', '/admin/api/tables', { slug: 'oldlabels' });
  const db = new DatabaseSync(join(srv.dataDir, 'foxy.db'));
  const row = db.prepare("SELECT id, system FROM game_tables WHERE slug = 'oldlabels'").get();
  const { labels, ...old } = JSON.parse(row.system);
  db.prepare('UPDATE game_tables SET system = ? WHERE id = ?').run(JSON.stringify(old), row.id);
  db.close();
  // the server caches rules per table: this table's were never read yet, so they are read from the database now
  assert.deepEqual((await srv.call('GET', '/admin/api/t/oldlabels/system')).body.labels.bio.class, { fr: 'Classe', en: 'Class' });
});

// ---------------------------------------------------------------- phase 3
test('3.1 journal entries belong to a table (or none) and to a campaign; players cannot write them; outside-table entries are copied into a table', async () => {
  const camp = (await srv.call('POST', '/admin/api/campaigns', { name: 'Saga' })).body;
  const j = (await gm('POST', '/journals', { title: 'Lore', body: 'secret', campaignId: camp.id })).body;
  assert.equal(j.campaignId, camp.id);
  assert.equal((await gm('PATCH', `/journals/${j.id}`, { campaignId: null })).body.campaignId, null);
  assert.equal((await gm('PATCH', `/journals/${j.id}`, { campaignId: 99999 })).status, 400);
  assert.equal((await pip('POST', '/journals', { title: 'Mine' })).status, 404);
  assert.equal((await pip('PATCH', `/journals/${j.id}`, { title: 'Mine' })).status, 404);
  assert.equal((await pip('GET', '/state')).body.journals.some((x) => x.id === j.id), false); // GM only by default
  const out = (await srv.call('POST', '/admin/api/journals', { title: 'World map notes', campaignId: camp.id })).body;
  const g = (await srv.call('GET', '/admin/api/compendium')).body;
  assert.deepEqual(g.journals.find((x) => x.id === out.id).table, null);
  assert.equal(g.journals.find((x) => x.id === j.id).table, 'r3');
  const copy = (await gm('POST', '/journals/import', { id: out.id })).body;
  assert.equal(copy.title, 'World map notes'); assert.equal(copy.campaignId, camp.id); assert.equal(copy.visibility, 'gm');
  assert.equal((await srv.call('PATCH', `/admin/api/journals/${out.id}`, { body: 'edited' })).body.body, 'edited');
  assert.equal((await srv.call('DELETE', `/admin/api/journals/${out.id}`)).status, 200);
});

test('3.2 the compendium\'s "show" box on a journal entry: players get it (state and live), and lose it when unticked', async () => {
  const j = (await gm('POST', '/journals', { title: 'Handout', body: 'The map is in the well' })).body;
  const ev = await srv.events('/api/t/r3/events', pip.cookie);
  try {
    await gm('PATCH', `/journals/${j.id}`, { visibility: 'all' });
    const up = await ev.next((e) => e.type === 'journal');
    assert.equal(up.op, 'upsert'); assert.equal(up.data.body, 'The map is in the well'); assert.equal(up.data.campaignId, undefined);
    assert.ok((await pip('GET', '/state')).body.journals.some((x) => x.id === j.id));
    await gm('PATCH', `/journals/${j.id}`, { visibility: 'gm' });
    const gone = await ev.next((e) => e.type === 'journal');
    assert.deepEqual([gone.op, gone.data], ['delete', { id: j.id }]);
    assert.ok(!(await pip('GET', '/state')).body.journals.some((x) => x.id === j.id));
  } finally { ev.close(); }
});

test('3.4 the eye: a journal entry pops up for the chosen players only; the others never receive its content', async () => {
  const beaSlot = await T.slot('Bea'), bea = await T.join(beaSlot.id);
  const j = (await gm('POST', '/journals', { title: 'Secret letter', body: 'TOP-SECRET-CONTENT' })).body;
  const evPip = await srv.events('/api/t/r3/events', pip.cookie), evBea = await srv.events('/api/t/r3/events', bea.cookie);
  try {
    const r = await gm('POST', `/journals/${j.id}/show`, { slots: [beaSlot.id, 99999] });
    assert.deepEqual(r.body.shownTo, [beaSlot.id]);
    const got = await evBea.next((e) => e.type === 'show');
    assert.equal(got.kind, 'journal'); assert.equal(got.data.body, 'TOP-SECRET-CONTENT'); assert.equal(got.data.campaignId, undefined);
    await gm('POST', '/chat', { text: 'marker' }); // everyone gets this; Pip must get it with nothing secret before it
    const pipSaw = [];
    await evPip.next((e) => { pipSaw.push(JSON.stringify(e)); return e.type === 'chat'; });
    assert.ok(!pipSaw.some((e) => e.includes('TOP-SECRET-CONTENT') || e.includes('"show"')), pipSaw.join('\n'));
    // nothing is kept: the entry is still the GM's, nobody gets it from the state
    assert.equal((await bea('GET', '/state')).body.journals.some((x) => x.id === j.id), false);
    // "make it visible in the compendium": now everyone has it
    await gm('POST', `/journals/${j.id}/show`, { slots: 'all', reveal: true });
    assert.equal((await pip('GET', '/state')).body.journals.some((x) => x.id === j.id), true);
    assert.equal((await pip('POST', `/journals/${j.id}/show`, { slots: 'all' })).status, 404); // players cannot show anything
  } finally { evPip.close(); evBea.close(); }
});

test('3.4 the eye on an NPC sends only its portrait and name to the chosen players; "reveal" lists it in the compendium', async () => {
  const npc = (await gm('POST', '/actors', { name: 'Mysterious stranger', data: { notes: 'NPC-SECRET-NOTES' } })).body;
  const ev = await srv.events('/api/t/r3/events', pip.cookie);
  try {
    const r = await gm('POST', `/actors/${npc.id}/show`, { slots: [pipSlot.id] });
    assert.equal(r.body.shown, false);
    const got = await ev.next((e) => e.type === 'show');
    assert.deepEqual(got, { type: 'show', kind: 'npc', data: { id: npc.id, name: 'Mysterious stranger', portrait: null } });
    assert.ok(!(await pip('GET', '/state')).body.npcs.some((n) => n.id === npc.id)); // nothing kept
    assert.equal((await gm('POST', `/actors/${npc.id}/show`, { slots: [], reveal: true })).body.shown, true);
    assert.ok((await pip('GET', '/state')).body.npcs.some((n) => n.id === npc.id));
    assert.equal((await pip('POST', `/actors/${npc.id}/show`, { slots: 'all' })).status, 404);
  } finally { ev.close(); }
});
