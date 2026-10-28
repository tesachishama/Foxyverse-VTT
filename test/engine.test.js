import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateStatic, parseCommand, translate, FormulaError } from '../server/engine.js';

const fixed = (v) => () => v;
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('arithmetic and the three division operators', () => {
  assert.equal(evaluate('7/2').total, 4);      // nearest
  assert.equal(evaluate('7\\2').total, 3);     // down
  assert.equal(evaluate('7%2').total, 4);      // up (not modulo)
  assert.equal(evaluate('10%5').total, 2);
  assert.equal(evaluate('5/0').total, 0);      // safe fallback
  assert.equal(evaluate('2^3*2').total, 16);
  assert.equal(evaluate('-2+5').total, 3);
});

test('dice: simple, expression operands, nesting', () => {
  assert.equal(evaluate('2d6+3', {}, fixed(4)).total, 11);
  assert.equal(evaluate('1d(1d4+2)', {}, seq(2, 5)).total, 5);
  assert.equal(evaluate('(1d4)d4', {}, seq(3, 1, 2, 4)).total, 7);
  assert.equal(evaluate('d6', {}, fixed(6)).total, 6);
});

test('variables, case/diacritics, unknown = 0', () => {
  const ctx = { con: 12, agi: 17, lvl: 3 };
  assert.equal(evaluate('CON*(LVL+1)', ctx).total, 48);
  assert.equal(evaluate('agi%5', ctx).total, 4);
  assert.equal(evaluate('nothere+2', ctx).total, 2);
});

test('comparators: < is <=, > is >=', () => {
  assert.equal(evaluate('1d20 < 10', {}, fixed(10)).success, true);
  assert.equal(evaluate('1d20 < 10', {}, fixed(11)).success, false);
  assert.equal(evaluate('1d20+3 > 12', {}, fixed(9)).success, true);
});

test('clamps !< and !>', () => {
  assert.equal(evaluate('1d20+2!<con', { con: 9 }, fixed(1)).total, 9);
  assert.equal(evaluate('1d8+1!>6', {}, fixed(8)).total, 6);
});

test('foxyverse derived formulas', () => {
  const c = { con: 14, int: 10, foc: 12, agi: 23, lvl: 4, bonact: 0 };
  assert.equal(evaluateStatic('con*(lvl+1)', c), 70);
  assert.equal(evaluateStatic('((int+foc)*3+lvl^2)/4', c), Math.round(22 * 0.75 + 16 / 4)); // 21
  assert.equal(evaluateStatic('(lvl+1)%3', c), 2);
  assert.equal(evaluateStatic('max(1, lvl\\5 + agi\\10) + bonact', c), 2);
  assert.throws(() => evaluateStatic('1d6', c), FormulaError);
});

test('errors', () => {
  for (const bad of ['', '2+', '(1+2', '3 $ 4', 'foo(1)']) assert.throws(() => evaluate(bad), FormulaError);
});

test('command parsing: type, count, formula, label', () => {
  assert.deepEqual(parseCommand('/STR +3'), { type: 'str', formula: '+3', count: 1, label: '' });
  assert.deepEqual(parseCommand('/pdmg 10 2d4|full burst'), { type: 'pdmg', formula: '2d4', count: 10, label: 'full burst' });
  assert.equal(parseCommand('/roll 5').count, 1); // lone number is a formula, not a count
  assert.equal(parseCommand('hello'), null);
});

test('plugin lexing rules: d after a value is the dice operator, names may start with d', () => {
  assert.equal(evaluate('2dcon', { con: 3 }, fixed(2)).total, 4);          // 2d3
  assert.equal(evaluate('lvld6', { lvl: 3 }, fixed(5)).total, 15);          // 3d6
  assert.equal(evaluate('1+defp', { defp: 4 }).total, 5);                   // "defp" is a variable, not d + efp
  assert.equal(evaluate('1d0', {}, fixed(1)).total, 1);                     // faces below 1 become 1
  assert.equal(evaluate('2^20').total, 4096);                               // exponent capped at 12
});

test('translated formula shows variables as numbers', () => {
  assert.equal(translate('1d20+con*2', { con: 12 }), '1d20+12*2');
  assert.equal(translate('(1+2)*3'), '(1+2)*3');
  assert.equal(translate('1d(lvl+1) < agi', { lvl: 2, agi: 9 }), '1d(2+1) < 9');
});
