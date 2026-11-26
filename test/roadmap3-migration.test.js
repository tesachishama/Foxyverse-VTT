// ROADMAP 3 §2.1: "elemental" is gone; tables keep working, default formulas are updated only where safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './helpers.js';

const OLD = { maxhp: 'con*(lvl+1)*(1-elemental) + elemental', maxmp: '((int+foc)*3+lvl^2)/4 + elemental*(con*(lvl+1)-1)*3/4' };

test('2.1 migration: old default formulas become the new ones, edited formulas stay, a table with an elemental sheet is left alone (and logged)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foxy-elem-'));
  try {
    const one = await startServer({ DATA_DIR: dir });
    for (const slug of ['plain', 'edited', 'elem']) await one.call('POST', '/admin/api/tables', { slug });
    const elem = (await one.call('POST', '/admin/api/t/elem/actors', { name: 'Sylph' })).body;
    await one.call('POST', '/admin/api/t/plain/actors', { name: 'Bob' });
    await one.call('POST', '/admin/api/systems', { name: 'Saved', table: 'plain' });
    await one.stop();
    // put the database back as v0.3.2 left it: old default formulas, one edited, one sheet ticked "elemental"
    const db = new DatabaseSync(join(dir, 'foxy.db'));
    const setOld = (sys, edited) => { for (const d of sys.derived) if (OLD[d.id]) d.formula = OLD[d.id]; if (edited) sys.derived.find((d) => d.id === 'maxhp').formula = 'con*2'; return JSON.stringify(sys); };
    for (const t of db.prepare('SELECT id, slug, system FROM game_tables').all()) db.prepare('UPDATE game_tables SET system = ? WHERE id = ?').run(setOld(JSON.parse(t.system), t.slug === 'edited'), t.id);
    for (const s of db.prepare('SELECT id, data FROM systems').all()) db.prepare('UPDATE systems SET data = ? WHERE id = ?').run(setOld(JSON.parse(s.data)), s.id);
    const row = db.prepare('SELECT data FROM actors WHERE id = ?').get(elem.id);
    db.prepare('UPDATE actors SET data = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.data), elemental: true }), elem.id);
    db.prepare("DELETE FROM settings WHERE key = 'r3noElemental'").run();
    db.close();

    const two = await startServer({ DATA_DIR: dir });
    const formulas = async (slug) => Object.fromEntries((await two.call('GET', `/admin/api/t/${slug}/system`)).body.derived.map((d) => [d.id, d.formula]));
    assert.equal((await formulas('plain')).maxhp, 'con*(lvl+1)'); assert.equal((await formulas('plain')).maxmp, '((int+foc)*3+lvl^2)/4');
    assert.equal((await formulas('edited')).maxhp, 'con*2'); // the GM's own formula is never overwritten
    assert.equal((await formulas('edited')).maxmp, '((int+foc)*3+lvl^2)/4');
    assert.equal((await formulas('elem')).maxhp, OLD.maxhp); // not migrated...
    assert.match(two.logs(), /Table "elem": rules not migrated.*Sylph/); // ...and said so
    // the old formulas still work without the variable (unknown names are 0): the elemental sheet is a normal one now
    const st = (await two.call('GET', '/admin/api/t/elem/state')).body;
    assert.equal(st.actors[0].computed.derived.maxhp, 10); assert.equal(st.actors[0].data.elemental, undefined);
    const saved = (await two.call('GET', '/admin/api/systems')).body.systems[0];
    await two.call('POST', '/admin/api/tables', { slug: 'fromsaved' });
    assert.equal((await two.call('GET', `/admin/api/t/plain/system/diff/${saved.id}`)).body.diff.length, 0); // the saved copy was migrated too
    await two.stop();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('2.1 "elemental" is no longer a sheet field, a formula variable, or a damage rule', async () => {
  const { validateSystem, sanitizeActorData, defaultActorData, applyRoll, actorContext } = await import('../server/rules.js');
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('../system/foxyverse.json', import.meta.url), 'utf8'));
  assert.ok(!JSON.stringify(raw).includes('elemental'));
  const sys = validateSystem(raw);
  assert.equal(defaultActorData(sys).elemental, undefined);
  const d = sanitizeActorData({ elemental: true, stats: { constitution: { base: 10 } } }, sys);
  assert.equal(d.elemental, undefined);
  assert.equal(actorContext(sys, d).vars.elemental, undefined);
  d.hp.cur = 20;
  const hit = applyRoll(sys, d, { kind: 'damage', dtype: 'physical', results: [{ total: 25 }], sum: 25 });
  assert.equal(hit.report.dealt, 25); assert.equal(hit.data.hp.cur, 0); assert.equal(hit.report.ko, true); assert.equal(hit.data.mp.cur, d.mp.cur);
  // a system may now use "elemental" for its own stat or value
  assert.doesNotThrow(() => validateSystem({ ...raw, derived: [...raw.derived, { id: 'elemental', label: 'E', formula: '0' }] }));
});
