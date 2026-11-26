// inline(): **bold** and [type formula|label] roll buttons, as in spell descriptions. Minimal fake DOM (lib.js builds with h()).
import test from 'node:test';
import assert from 'node:assert/strict';

const node = (tag) => ({ tag, nodeType: 1, className: '', attrs: {}, kids: [], on: {},
  setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; }, append(...k) { this.kids.push(...k); } });
globalThis.document = { createElement: node, createTextNode: (text) => ({ nodeType: 3, text }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { inline, setKnownRollTypes } = await import('../public/lib.js');
setKnownRollTypes({ stats: [{ id: 'str', aliases: ['for'] }], rollTypes: [{ id: 'pdmg', aliases: [] }], quickRolls: [] });
const text = (n) => (typeof n === 'string' ? n : n.kids.map((k) => (k.nodeType === 3 ? k.text : text(k))).join(''));

test('inline renders a spell description: text, **bold** and two roll buttons that send their command', () => {
  const effect = 'Frappe la cible : **brûlure**\n[pdmg 2d30 | physique] puis [for +2|Résister] ; [zzz 1] reste du texte.';
  const rolled = [];
  const out = inline(effect, (c) => rolled.push(c));
  const buttons = out.filter((n) => n.tag === 'button');
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map(text), ['physique', 'Résister']);
  assert.equal(out.find((n) => n.tag === 'strong') && text(out.find((n) => n.tag === 'strong')), 'brûlure');
  assert.equal(out[0], 'Frappe la cible : ');
  assert.ok(out.some((n) => typeof n === 'string' && n.startsWith('\n')), 'line breaks are kept (shown with pre-wrap)');
  assert.ok(out.some((n) => typeof n === 'string' && n.includes('[zzz 1]')), 'an unknown roll type stays plain text');
  buttons.forEach((b) => b.on.click());
  assert.deepEqual(rolled, ['/pdmg 2d30|physique', '/for +2|Résister']);
  assert.equal(buttons[0].attrs.type, 'button');
});
