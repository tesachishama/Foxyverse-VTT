import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSystem, defaultActorData, sanitizeActorData, actorContext, executeRoll, applyRoll, undoApply, castSpell, pointBudget } from '../server/rules.js';
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
  const a = make({ stats: { constitution: 15 }, items: [{ id: 'x', name: 'Plate', usedSlots: ['torso'], pdef: 6, mdef: 2 }] });
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

test('equipment: only items in a slot count; "other" counts too; one item per slot', () => {
  const a = make({ items: [
    { id: 'a', name: 'Helm', usedSlots: ['hat'], pdef: 2, bonuses: { strength: 1 } },
    { id: 'b', name: 'Another helm', usedSlots: ['hat'], pdef: 5 },            // same slot: loses it
    { id: 'c', name: 'Tattoo', usedSlots: ['other'], mdef: 3, bonuses: { strength: 2 } },
    { id: 'd', name: 'Backpack stuff', pdef: 9 },                              // carried, not equipped
    { id: 'e', name: 'Old save', equipped: true, pdef: 1 },                    // pre-slot sheet: becomes "other"
  ] });
  assert.deepEqual(a.items.map((i) => i.usedSlots), [['hat'], [], ['other'], [], ['other']]);
  const c = actorContext(sys, a);
  assert.equal(c.pdef, 2 + 1); assert.equal(c.mdef, 3); assert.equal(c.stats.strength.item, 3);
  assert.equal(sanitizeActorData({ items: [{ name: 'W', type: 'weapon' }] }, sys).items[0].equipExpr, '[weapons]');
  assert.deepEqual(sanitizeActorData({ items: [{ name: 'X', usedSlots: ['Chapeau', 'épauleD', 'nonsense'] }] }, sys).items[0].usedSlots, ['hat', 'rshoulder']);
});

test('nat grading follows the plugin: first die min/max shifts the grade, any die size, comparators', () => {
  const a = make({ stats: { strength: 10 } });
  assert.equal(roll('/str', a, fixed(1)).results[0].outcome, 'critSuccess');
  assert.equal(roll('/roll 1d20 < 10', null, fixed(1)).results[0].outcome, 'critSuccess');   // min on "<" raises
  assert.equal(roll('/roll 1d20 < 10', null, fixed(20)).results[0].outcome, 'critFailure');  // max on "<" lowers
  assert.equal(roll('/roll 1d20 > 15', null, fixed(1)).results[0].outcome, 'critFailure');   // reversed for ">"
  assert.equal(roll('/roll 1d20 > 15', null, fixed(20)).results[0].outcome, 'critSuccess');
  assert.equal(roll('/roll 1d6 < 3', null, fixed(6)).results[0].outcome, 'critFailure');      // any die size, not only d20
  assert.equal(roll('/str +2', a, fixed(5)).translated, '1d20+2');
  assert.equal(roll('/pdmg 1d6+str', a, fixed(3)).translated, '1d6+10');
});

test('resources follow their maximum: +delta when it rises, capped when it falls', async () => {
  const { resourceMaxes, followMax, fillResources } = await import('../server/rules.js');
  const a = make({ stats: { constitution: 5 } });           // level 1: maxhp 10
  assert.deepEqual([a.hp.cur, a.mp.cur, a.fav.cur], Object.values(resourceMaxes(sys, a))); // created full
  const before = resourceMaxes(sys, a);
  a.hp.cur = 4;                                              // wounded: 4/10
  a.bio.level = 2;                                           // maxhp 15, maxfav 1
  followMax(before, resourceMaxes(sys, a), a);
  assert.equal(a.hp.cur, 9);                                 // +5, not refilled
  const full = make(); const b0 = resourceMaxes(sys, full);
  full.bio.level = 3; followMax(b0, resourceMaxes(sys, full), full);
  assert.equal(full.hp.cur, 20); assert.equal(full.fav.cur, 2); // 10/10 -> 20/20, favors 1 -> 2
  assert.equal(full.mp.cur, resourceMaxes(sys, full).mp);
  const b1 = resourceMaxes(sys, full);
  full.bio.level = 1; followMax(b1, resourceMaxes(sys, full), full);
  assert.equal(full.hp.cur, 10); assert.equal(full.fav.cur, 1); // falls: capped at the new max
  const low = make(); low.hp.cur = 3; const b2 = resourceMaxes(sys, low);
  low.bio.level = 1; followMax(b2, resourceMaxes(sys, low), low);
  assert.equal(low.hp.cur, 3);                               // unchanged max: untouched
  const raw = { stats: {}, bio: { level: 1 } };              // raw stored data with no resources yet
  followMax({ hp: 10 }, { hp: 12 }, raw); assert.equal(raw.hp.cur, 2);
  assert.equal(fillResources(sys, sanitizeActorData({ bio: { level: 2 } }, sys)).hp.cur, 15);
});

test('undoApply reverses only one application', () => {
  const a = make({ stats: { constitution: 10 } }); a.hp.cur = 20; // 20/20
  a.hp.temp = 3;
  const dmg = { kind: 'damage', dtype: 'true', results: [{ total: 5 }], sum: 5 };
  const one = applyRoll(sys, a, dmg);                          // temp 3 -> 0, hp 20 -> 18
  const two = applyRoll(sys, one.data, dmg);                   // hp 18 -> 13
  assert.deepEqual(one.report.delta, { hp: -2, temp: -3, mp: 0 });
  const back = undoApply(sys, two.data, one.report.delta);
  assert.equal(back.hp.cur, 15); assert.equal(back.hp.temp, 3); // the second hit stays
  const heal = applyRoll(sys, back, { kind: 'heal', results: [{ total: 4 }], sum: 4 });
  assert.equal(heal.data.hp.cur, 19);
  assert.equal(undoApply(sys, heal.data, heal.report.delta).hp.cur, 15);
  const theal = applyRoll(sys, back, { kind: 'theal', results: [{ total: 6 }], sum: 6 });
  assert.equal(undoApply(sys, theal.data, theal.report.delta).hp.temp, 3);
  const full = make({ stats: { constitution: 10 } }); full.hp.cur = 20;
  const hit = applyRoll(sys, full, dmg);
  const healed = applyRoll(sys, hit.data, { kind: 'heal', results: [{ total: 9 }], sum: 9 }); // back to 20/20
  assert.equal(undoApply(sys, healed.data, hit.report.delta).hp.cur, 20); // never above max
});

test('ticked talents add their tier modifier to stat checks only, summed', async () => {
  const { talentModifier } = await import('../server/rules.js');
  const a = make({ stats: { constitution: 12 } });
  a.talents = sanitizeActorData({ talents: [{ name: 'Survivaliste', tier: 4, enabled: true }, { name: 'Boussole', tier: 2, enabled: true }, { name: 'Off', tier: 3, enabled: false }, { name: 'Zero', tier: 0, enabled: true }] }, sys).talents;
  assert.deepEqual(talentModifier(sys, a), { total: -13, names: ['Survivaliste', 'Boussole'] }); // T4 -10 + T2 -3; unticked and T0 count for nothing
  const check = roll('/con +1', a, fixed(11));
  assert.equal(check.formula, '1d20+1-13'); assert.equal(check.results[0].total, -1); // 11 + 1 - 13: well under CON 12
  assert.equal(check.results[0].outcome, 'success');
  assert.deepEqual(check.talents, { total: -13, names: ['Survivaliste', 'Boussole'] });
  assert.equal(check.cmd.formula, '+1'); // a reroll recomputes with the talents ticked at that time
  const dmg = roll('/pdmg 2d6', a, fixed(3));
  assert.equal(dmg.formula, '2d6'); assert.equal(dmg.talents, undefined); // damage, heals, free rolls: untouched
  assert.equal(sanitizeActorData({ talents: [{ name: 'x' }] }, sys).talents[0].enabled, false); // new talents start unticked
  assert.equal(sanitizeActorData({ talents: [{ name: 'x', tier: 0, description: 'd'.repeat(5000) }] }, sys).talents[0].description.length, 4000);
});

test('a spell description can be locked (saved) and is kept as is', () => {
  const sp = sanitizeActorData({ spells: [{ name: 'Spark', effect: 'Fire', locked: true }, { name: 'Ward' }] }, sys).spells;
  assert.equal(sp[0].locked, true); assert.equal(sp[0].effect, 'Fire'); assert.equal(sp[1].locked, false);
});
