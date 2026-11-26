// ROADMAP 3 §5: table backups (export / import) and campaign packs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.js';
import { zipWriter } from '../server/zip.js';

let srv, src, gm, pipSlot, pip;
const PNG = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, n)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000, 9)]);
const up = async (type, bytes) => (await (await fetch(srv.base + '/admin/api/t/src/upload', { method: 'POST', headers: { 'Content-Type': type }, body: bytes })).json()).url;
const get = async (path) => { const r = await fetch(srv.base + path); return { status: r.status, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) }; };
const post = async (path, bytes) => { const r = await fetch(srv.base + path, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes }); return { status: r.status, body: await r.json() }; };
const postJson = async (path, body) => { const r = await fetch(srv.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };
/** A ZIP in memory, from { name: Buffer | string }. */
async function makeZip(entries) {
  const parts = [], out = new Writable({ write(c, _, cb) { parts.push(c); cb(); } }), z = zipWriter(out);
  for (const [name, v] of Object.entries(entries)) await z.add(name, Buffer.from(typeof v === 'string' ? v : v));
  await z.finish();
  return Buffer.concat(parts);
}
const manifest = (o = {}) => JSON.stringify({ format: 'foxyverse-vtt', formatVersion: 1, kind: 'table', name: 'x', ...o });
const state = async (slug) => (await srv.call('GET', `/admin/api/t/${slug}/state`)).body;

let portrait, mapImg, sound, camp;
before(async () => {
  srv = await startServer();
  src = await srv.table('src', { name: 'Source' }); gm = src.gm;
  pipSlot = await src.slot('Pip'); pip = await src.join(pipSlot.id);
  camp = (await srv.call('POST', '/admin/api/campaigns', { name: 'Saga' })).body;
  await srv.call('PATCH', '/admin/api/tables/src', { campaignId: camp.id });
  mapImg = await up('image/png', PNG(1)); portrait = await up('image/png', PNG(2)); sound = await up('audio/mpeg', MP3);
  const sc = (await gm('POST', '/scenes', { name: 'Crypt', image: mapImg, width: 800, height: 600, fog: true, walls: [[0, 0, 100, 0, 1, 0, 1, 1, 1]], lights: [{ x: 5, y: 5, radius: 3 }], tps: [{ x: 35, y: 35, group: 'a' }], reveal: [{ poly: [[0, 0], [9, 0], [0, 9]] }] })).body;
  await gm('POST', '/scenes', { name: 'Second' });
  const hero = (await gm('POST', '/actors', { name: 'Hero', data: { portrait, items: [{ name: 'Blade', type: 'weapon', bonuses: { strength: 2 }, usedSlots: ['weapon1'] }], spells: [{ name: 'Spark', cost: 2 }] } })).body;
  const npc = (await gm('POST', '/actors', { name: 'Goblin' })).body;
  await gm('PATCH', `/actors/${npc.id}`, { shown: true, alias: 'gob' });
  await gm('PUT', `/actors/${hero.id}/perms`, { perms: { [pipSlot.id]: 'edit' } });
  await gm('POST', '/tokens', { sceneId: sc.id, actorId: hero.id, x: 35, y: 35, life: 'dead' });
  await gm('POST', '/tokens', { sceneId: sc.id, name: 'Barrel', x: 105, y: 35 });
  await pip('POST', '/chat', { text: '/con', actorId: hero.id });
  await gm('POST', '/chat', { text: '@gob Grr' });
  await gm('POST', '/journals', { title: 'For Pip', body: 'hello', image: portrait, visibility: [pipSlot.id] });
  await gm('POST', '/compendium', { kind: 'item', name: 'Potion', data: { type: 'consumable' }, visible: true });
  await gm('POST', '/sounds', { name: 'Rain', url: sound, group: 'Ambiance', subgroup: 'Weather', tags: 'calm' });
  await gm('POST', '/sounds', { name: 'Tavern', youtube: 'https://youtu.be/dQw4w9WgXcQ', loop: true });
});
after(() => srv.stop());

test('5.1 export then import a table: a new table with everything, ids remapped (sheets, tokens, scenes, slots, chat, journal)', async () => {
  const zip = await get('/admin/api/tables/src/archive');
  assert.equal(zip.status, 200); assert.equal(zip.type, 'application/zip');
  // the uploaded files travel in the archive: remove them here, the import brings them back
  for (const u of [mapImg, portrait, sound]) unlinkSync(join(srv.dataDir, u));
  const imp = await post('/admin/api/tables/archive', zip.bytes);
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.slug, 'src-2'); assert.equal(imp.body.campaignId, camp.id); // address taken: a suffix; same campaign (by name)
  for (const u of [mapImg, portrait, sound]) assert.ok(existsSync(join(srv.dataDir, u)), u);
  const a = await state('src'), b = await state('src-2');
  assert.equal(b.table.name, 'Source (2)');
  assert.deepEqual(b.system, a.system);
  assert.deepEqual(b.users.map((u) => [u.name, u.color]), a.users.map((u) => [u.name, u.color]));
  const strip = (s) => { const { id, ...rest } = s; return rest; };
  assert.deepEqual(b.scenes.map(strip), a.scenes.map(strip)); // walls, lights, TP, polygons, image, active...
  const byName = (st) => Object.fromEntries(st.actors.map((x) => [x.name, x]));
  const A = byName(a), B = byName(b);
  assert.deepEqual(Object.keys(B).sort(), ['Goblin', 'Hero']);
  assert.deepEqual(B.Hero.data, A.Hero.data); assert.deepEqual(B.Hero.computed, A.Hero.computed);
  assert.equal(B.Goblin.alias, 'gob'); assert.equal(B.Goblin.shown, true);
  const newPip = b.users.find((u) => u.name === 'Pip').id;
  assert.notEqual(newPip, pipSlot.id); assert.deepEqual(B.Hero.perms, { [newPip]: 'edit' });
  const tok = (st, A2) => st.tokens.map((t) => [t.name, t.x, t.y, t.life, t.actorId ? Object.values(A2).find((x) => x.id === t.actorId).name : null, st.scenes.find((s) => s.id === t.sceneId).name]).sort();
  assert.deepEqual(tok(b, B), tok(a, A));
  assert.equal(b.chat.length, a.chat.length);
  assert.equal(b.chat[0].actorId, B.Hero.id); assert.equal(b.chat[0].userId, newPip);
  assert.equal(b.chat[1].body.parts[0].actorId, B.Goblin.id); // narration lines follow their sheet
  assert.deepEqual(b.journals.map((j) => [j.title, j.visibility, j.image]), [['For Pip', [newPip], portrait]]);
  assert.deepEqual(b.compendium.map((c) => [c.kind, c.name, c.visible]).sort(), a.compendium.map((c) => [c.kind, c.name, c.visible]).sort());
  assert.deepEqual(b.sounds.map(({ id, created, ...s }) => s), a.sounds.map(({ id, created, ...s }) => s)); // eslint-disable-line no-unused-vars
  // nobody is connected to the copy: players pick their slot again
  assert.ok(b.users.every((u) => !u.online));
  const named = await post('/admin/api/tables/archive?name=Restored&slug=restored', zip.bytes);
  assert.deepEqual([named.body.slug, named.body.name], ['restored', 'Restored']);
});

test('5.3 the format is versioned: a newer file, a foreign or damaged file, a pack in the wrong place are refused with a clear message', async () => {
  const newer = await post('/admin/api/tables/archive', await makeZip({ 'manifest.json': manifest({ formatVersion: 2 }), 'data.json': '{}' }));
  assert.equal(newer.status, 400); assert.match(newer.body.error, /newer Foxyverse VTT \(format 2/);
  for (const bytes of [Buffer.from('not a zip at all'), await makeZip({ 'readme.txt': 'hi' }), await makeZip({ 'manifest.json': '{"format":"other"}' }), await makeZip({ 'manifest.json': manifest(), 'data.json': '{broken' })]) {
    const r = await post('/admin/api/tables/archive', bytes);
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, /archive|Damaged/);
  }
  const zip = (await get('/admin/api/tables/src/archive')).bytes, cut = await post('/admin/api/tables/archive', zip.subarray(0, zip.length - 100));
  assert.equal(cut.status, 400);
  const pack = await post('/admin/api/tables/archive', await makeZip({ 'manifest.json': manifest({ kind: 'pack' }), 'data.json': '{}' }));
  assert.match(pack.body.error, /campaign pack/);
  const bad = await post('/admin/api/tables/archive', await makeZip({ 'manifest.json': manifest(), 'data.json': '{"system":{}}' }));
  assert.match(bad.body.error, /invalid rules/);
  // a file whose content does not match its name is refused, and nothing is created
  const before = (await srv.call('GET', '/admin/api/tables')).body.tables.length;
  const fake = await post('/admin/api/tables/archive', await makeZip({ 'manifest.json': manifest(), 'data.json': JSON.stringify({ system: (await state('src')).system }), [`files/${'0'.repeat(64)}.png`]: PNG(7) }));
  assert.equal(fake.status, 400); assert.match(fake.body.error, /does not match/);
  assert.equal((await srv.call('GET', '/admin/api/tables')).body.tables.length, before);
  assert.equal((await srv.call('GET', `/api/t/src/state`, null, pip.cookie)).status, 200);
  assert.equal((await fetch(srv.base + '/api/t/src/archive')).status, 404); // no player route
});

test('5.2 campaign packs: the GM picks what goes in; importing copies it into a table with the campaign tag; no chat, no slots', async () => {
  const sysLib = (await srv.call('POST', '/admin/api/systems', { name: 'Saga rules', table: 'src' })).body;
  await srv.call('PATCH', `/admin/api/campaigns/${camp.id}`, { systemId: sysLib.id });
  const contents = (await srv.call('GET', `/admin/api/campaigns/${camp.id}/contents`)).body;
  assert.equal(contents.system.name, 'Saga rules');
  const potion = contents.items.find((i) => i.name === 'Potion' && i.table === 'src');
  const hero = contents.actors.find((a) => a.name === 'Hero' && a.table === 'src');
  assert.ok(potion && hero); assert.ok(contents.scenes.some((s) => s.name === 'Crypt')); assert.ok(contents.journals.length); assert.ok(contents.sounds.length);
  const pack = await postJson('/admin/api/packs', { campaignId: camp.id, items: [potion.id], actors: [hero.id], scenes: [contents.scenes.find((s) => s.name === 'Crypt' && s.table === 'src').id],
    journals: [contents.journals[0].id], sounds: contents.sounds.filter((s) => s.table === 'src').map((s) => s.id), system: true });
  assert.equal(pack.status, 200);
  assert.equal((await postJson('/admin/api/packs', { campaignId: 99999 })).status, 400);
  // into another table (no campaign yet), with the system applied
  await srv.table('dest');
  const wrong = await post('/admin/api/tables/archive', pack.bytes);
  assert.match(wrong.body.error, /campaign pack, not a table backup/);
  const tableZip = (await get('/admin/api/tables/src/archive')).bytes;
  assert.match((await post('/admin/api/t/dest/packs/archive', tableZip)).body.error, /table backup, not a campaign pack/);
  const imp = await post('/admin/api/t/dest/packs/archive?applySystem=1', pack.bytes);
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.deepEqual(imp.body, { items: 1, spells: 0, actors: 1, scenes: 1, journals: 1, sounds: 2, system: true });
  const d = await state('dest');
  assert.equal(d.actors[0].name, 'Hero'); assert.equal(d.actors[0].campaignId, camp.id); assert.deepEqual(d.actors[0].perms, {}); // no player rights travel
  assert.equal(d.users.length, 0); assert.equal(d.chat.length, 0);
  const copy = d.compendium.find((c) => c.name === 'Potion');
  assert.equal(copy.campaignId, camp.id); assert.equal(copy.source.id, potion.id); // the copy remembers its original
  assert.equal(d.scenes[0].name, 'Crypt'); assert.equal(d.tokens.length, 0); // maps without tokens
  assert.equal(d.journals[0].visibility, 'gm'); assert.equal(d.journals[0].campaignId, camp.id);
  assert.equal(d.sounds.length, 2);
  assert.ok((await srv.call('GET', '/admin/api/systems')).body.systems.some((s) => s.name === 'Saga (pack)'));
  assert.equal((await fetch(srv.base + '/api/t/dest/packs/archive', { method: 'POST', body: pack.bytes })).status, 404); // GM only
});
