import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSystem, defaultActorData, sanitizeActorData, actorContext, executeRoll, applyRoll, castSpell, pointBudget } from '../server/rules.js';
import { parseCommand } from '../server/engine.js';

const sys = validateSystem(JSON.parse(readFileSync(new URL('../system/foxyverse.json', import.meta.url), 'utf8')));
const fixed = (v) => () => v;
const roll = (line, actor, rng) => executeRoll(sys, parseCommand(line), actor, rng);
const make = (patch = {}) => {
  const a = defaultActorData(sys);
  for (const [k, v] of Object.entries(patch.stats ?? {})) a.stats[k].base = v;
  Object.assign(a.bio, patch.bio ?? {}); a.elemental = !!patch.elemental; a.items = patch.items ?? [];
  return sanitizeActorData(a, sys);
};

test('default system validates', () => assert.equal(sys.stats.length, 7));

test('new level-1 character: stats 5, derived values', () => {
  const c = actorContext(sys, make());
  assert.equal(c.derived.maxhp, 5 * 2);               // con*(lvl+1)
  assert.equal(c.derived.maxmp, Math.round(10 * 0.75 + 0.25)); // 8
  assert.equal(c.derived.maxfav, 1);
  assert.equal(c.derived.act, 1);
});

test('favor table from the PDF: levels 1,3,6,9 -> 1,2,3,4', () => {
  const f = (lvl) => actorContext(sys, make({ bio: { level: lvl } })).derived.maxfav;
  assert.deepEqual([1, 2, 3, 5, 6, 8, 9].map(f), [1, 1, 2, 2, 3, 3, 4]);
});

test('stat check outcomes incl. nat 1 / nat 20', () => {
  const a = make({ stats: { intelligence: 18 } });
  assert.equal(roll('/int', a, fixed(18)).results[0].outcome, 'success');       // equal passes
  assert.equal(roll('/int', a, fixed(19)).results[0].outcome, 'failure');
  assert.equal(roll('/int', a, fixed(1)).results[0].outcome, 'critSuccess');
  assert.equal(roll('/int', a, fixed(20)).results[0].outcome, 'critFailure');
  // nat 1 with a malus that makes the roll fail is still a plain success
  const low = make({ stats: { intelligence: 1 } });
  assert.equal(roll('/int +5', low, fixed(1)).results[0].outcome, 'success');
  // malus: +3 turns a 16 into 19 against 18
  assert.equal(roll('/int +3', a, fixed(16)).results[0].outcome, 'failure');
  // talent bonus: -1
  assert.equal(roll('/int -1', a, fixed(19)).results[0].outcome, 'success');
});

test('stat check needs a character; multi-roll; damage sums', () => {
  assert.throws(() => roll('/str', null), /character/);
  const b = roll('/pdmg 3 2d4', null, fixed(2));
  assert.equal(b.results.length, 3); assert.equal(b.sum, 12);
});

test('physical damage uses pdef per roll, magical uses mdef, true ignores both', () => {
  const a = make({ stats: { constitution: 15 }, items: [{ id: 'x', name: 'Plate', equipped: true, pdef: 6, mdef: 2 }] });
  assert.equal(actorContext(sys, a).pdef, 6);
  const phys = roll('/pdmg 10', a, fixed(1)); phys.results[0].total = 10; phys.sum = 10; phys.dtype = 'physical';
  assert.equal(applyRoll(sys, a, phys).report.dealt, 4);
  const small = { ...phys, results: [{ total: 3 }], sum: 3 };
  assert.equal(applyRoll(sys, a, small).report.dealt, 0);
  const magic = { ...phys, dtype: 'magical' }; assert.equal(applyRoll(sys, a, magic).report.dealt, 8);
  const tru = { ...phys, dtype: 'true' }; assert.equal(applyRoll(sys, a, tru).report.dealt, 10);
});

test('temp HP absorbs first; KO at 0', () => {
  const a = make({ stats: { constitution: 5 } }); a.hp.cur = 10; a.hp.temp = 4;
  const body = { kind: 'damage', dtype: 'true', results: [{ total: 6 }], sum: 6 };
  const { data, report } = applyRoll(sys, a, body);
  assert.equal(data.hp.temp, 0); assert.equal(data.hp.cur, 8); assert.equal(report.tempLost, 4);
  const ko = applyRoll(sys, a, { ...body, results: [{ total: 99 }], sum: 99 });
  assert.equal(ko.data.hp.cur, 0); assert.equal(ko.report.ko, true);
});

test('elementals: HP 1, immune to physical, magic drains temp then mana', () => {
  const e = make({ elemental: true, stats: { constitution: 10, intelligence: 10, focus: 10 }, bio: { level: 2 } });
  const c = actorContext(sys, e);
  assert.equal(c.derived.maxhp, 1);
  assert.equal(c.derived.maxmp, Math.round(Math.round(20 * 0.75 + 4 / 4) + (30 - 1) * 0.75)); // plugin formula
  e.hp.cur = 1; e.mp.cur = 20; e.hp.temp = 3;
  assert.equal(applyRoll(sys, e, { kind: 'damage', dtype: 'physical', results: [{ total: 50 }], sum: 50 }).report.dealt, 0);
  const m = applyRoll(sys, e, { kind: 'damage', dtype: 'magical', results: [{ total: 10 }], sum: 10 });
  assert.equal(m.data.hp.cur, 1); assert.equal(m.data.hp.temp, 0); assert.equal(m.data.mp.cur, 13);
});

test('heal is capped at max HP; mana at max MP', () => {
  const a = make(); a.hp.cur = 3;
  assert.equal(applyRoll(sys, a, { kind: 'heal', results: [{ total: 99 }], sum: 99 }).data.hp.cur, 10);
});

test('spells spend mana, then life at 0 mana', () => {
  const a = make(); a.mp.cur = 1; a.hp.cur = 10;
  a.spells = [{ id: 's1', name: 'Bolt', cost: 3, costType: 'mp' }];
  const r = castSpell(sys, a, 's1');
  assert.equal(r.data.mp.cur, 0); assert.equal(r.data.hp.cur, 8);
});

test('point budget: 30 at level 1; 1 point per step to 20, 2 per step 21-30', () => {
  const a = make({ stats: { strength: 15, agility: 15, perception: 15 } }); // 3 stats * 10 steps
  assert.deepEqual(pointBudget(sys, a), { budget: 30, spent: 30 });
  assert.equal(pointBudget(sys, make({ stats: { strength: 22 } })).spent, 15 + 2 * 2);
  assert.equal(pointBudget(sys, make({ bio: { level: 10 } })).budget, 30 + 45);
});

test('validation rejects bad systems', () => {
  const base = JSON.parse(readFileSync(new URL('../system/foxyverse.json', import.meta.url), 'utf8'));
  const bad = (m) => { const s = structuredClone(base); m(s); return () => validateSystem(s); };
  assert.throws(bad((s) => { s.derived[0].formula = '1d6'; }), /Dice/);
  assert.throws(bad((s) => { s.derived[0].formula = 'con*'; }), /maxhp/);
  assert.throws(bad((s) => { s.stats[1].aliases.push('con'); }), /both/);
  assert.throws(bad((s) => { s.derived = s.derived.filter((d) => d.id !== 'act'); }), /"act" is required/);
});
