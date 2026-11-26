// ROADMAP 3: pure client modules (tools, selection, layout helpers...).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { TOOLS, TOOL_BUTTONS } from '../public/tools.js';
import { DICT } from '../public/lib.js';

const icon = (name) => new URL(`../public/icons/${name}.svg`, import.meta.url);
/** Every DICT key used by a list of things exists in French and in English. */
const bothLangs = (keys) => { for (const k of keys) { assert.ok(DICT.fr[k], `missing fr "${k}"`); assert.ok(DICT.en[k], `missing en "${k}"`); } };
const squareSvg = (name) => {
  assert.ok(existsSync(icon(name)), `icon ${name}.svg is missing`);
  const svg = readFileSync(icon(name), 'utf8');
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.ok(m && m[1] === m[2], `${name}.svg is not square`);
};

test('1.1 every map tool is an icon (square SVG placeholder) with a tooltip name in FR and EN', () => {
  for (const tl of [...TOOLS, ...TOOL_BUTTONS]) squareSvg(tl.icon);
  bothLangs([...TOOLS, ...TOOL_BUTTONS].map((tl) => tl.label));
  assert.equal(new Set(TOOLS.map((tl) => tl.id)).size, TOOLS.length);
});

export { bothLangs, squareSvg };
