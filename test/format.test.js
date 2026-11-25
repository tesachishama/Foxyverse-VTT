// Display rules of the page (public/format.js is pure, so it runs here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { signed, tierLabel, damageDetail, damageText, matchesSearch } from '../public/format.js';
import { isTokenDead } from '../public/vision.js';
import { DEAD_ALPHA } from '../public/map.js';

test('1.2 talent tiers are shown as signed maluses: T0 -0, T1 -1, T2 -3, T3 -5, T4 -10', () => {
  const tiers = { 1: -1, 2: -3, 3: -5, 4: -10 };
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => tierLabel(tiers, n)), ['T0 -0', 'T1 -1', 'T2 -3', 'T3 -5', 'T4 -10']);
  assert.equal(signed(-4), '-4'); assert.equal(signed(2), '+2'); assert.equal(signed(0), '-0');
});

test('1.1 an application gives the total received, then each roll with the armor taken off it', () => {
  const took = (n) => `a pris ${n} dégâts`;
  assert.equal(damageText({ dealt: 25, rolls: [{ raw: 20, armor: 5, dealt: 15 }, { raw: 15, armor: 5, dealt: 10 }] }, took), 'a pris 25 dégâts (20−5 + 15−5)');
  assert.equal(damageText({ dealt: 6, rolls: [{ raw: 6, armor: 0, dealt: 6 }] }, took), 'a pris 6 dégâts'); // one roll, no armor: nothing to explain
  assert.equal(damageDetail([{ raw: 6, armor: 0, dealt: 6 }, { raw: 2, armor: 0, dealt: 2 }]), '6 + 2');
  assert.equal(damageDetail([{ raw: 3, armor: 3, dealt: 0 }, { raw: 9, armor: 3, dealt: 6 }]), '3−3 + 9−3');
  assert.equal(damageText({ dealt: 4 }, took), 'a pris 4 dégâts'); // applications saved before the detail existed
});

test('1.5 compendium search: live name filter, case and accents ignored', () => {
  assert.ok(matchesSearch('Épée longue', 'epee')); assert.ok(matchesSearch('Épée longue', 'LONG'));
  assert.ok(!matchesSearch('Bouclier', 'epee')); assert.ok(matchesSearch('Bouclier', '  '));
});

test('1.8 a dead token: 50 % opacity, forced by the GM or from the sheet HP', () => {
  assert.equal(DEAD_ALPHA, 0.5);
  assert.equal(isTokenDead({ life: 'auto' }, 0), true); assert.equal(isTokenDead({ life: 'auto' }, 3), false);
  assert.equal(isTokenDead({ life: 'alive' }, -2), false); assert.equal(isTokenDead({ life: 'dead' }, 10), true);
  assert.equal(isTokenDead({ life: 'auto', dead: true }), true); // no sheet on this page: what the server says
});
