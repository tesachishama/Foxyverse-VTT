// ROADMAP 2 §5: teleport cells (public/tp.js is pure), ghosts and their vision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cellCenter, tpAt, linkedTps, ghostsOf, ghostStart, tpGroups, newGroup } from '../public/tp.js';
import { computeVision } from '../public/vision.js';

const tps = [{ id: 'a', x: 35, y: 35, group: '1' }, { id: 'b', x: 735, y: 35, group: '1' }, { id: 'c', x: 735, y: 735, group: '1' }, { id: 'd', x: 385, y: 385, group: '2' }];

test('5 TP cells sit on cell centres; a token stands on one when it is in its cell', () => {
  assert.deepEqual(cellCenter({ grid: 70, ox: 0, oy: 0 }, 100, 20), { x: 105, y: 35 });
  assert.equal(tpAt(tps, 70, 40, 30)?.id, 'a'); assert.equal(tpAt(tps, 70, 80, 30), null);
});

test('5 groups link any number of cells; ghosts appear on every linked cell, none for a lone cell', () => {
  assert.deepEqual(linkedTps(tps, tps[0]).map((c) => c.id), ['b', 'c']);
  const tok = { id: 1, x: 35, y: 35 };
  assert.deepEqual(ghostsOf([tok], tps, 70).map((g) => [g.to.id, g.x, g.y]), [['b', 735, 35], ['c', 735, 735]]);
  assert.deepEqual(ghostsOf([{ id: 2, x: 385, y: 385 }], tps, 70), []); // group 2 has one cell
  assert.deepEqual(ghostsOf([{ id: 3, x: 200, y: 200 }], tps, 70), []); // not on a cell
  assert.deepEqual(tpGroups(tps).map(([g, cells]) => [g, cells.length]), [['1', 3], ['2', 1]]);
  assert.equal(newGroup(tps), '3');
});

test('5 a move from a ghost starts on a cell linked to the one the token stands on, nowhere else', () => {
  const tok = { x: 35, y: 35 };
  assert.deepEqual(ghostStart(tps, 70, tok, 'c'), { x: 735, y: 735 });
  assert.equal(ghostStart(tps, 70, tok, 'd'), null); // another group
  assert.equal(ghostStart(tps, 70, tok, 'a'), null); // its own cell
  assert.equal(ghostStart(tps, 70, { x: 300, y: 300 }, 'b'), null); // not on a TP cell
});

test('5 ghosts give the vision seen from their cell', () => {
  const scene = { width: 1000, height: 1000, grid: 70, walls: [[500, 0, 500, 1000, 0, 0]] };
  const tok = { x: 35, y: 35, vision: 100 };
  const eyes = [tok, ...ghostsOf([tok], tps, 70).map((g) => ({ x: g.x, y: g.y, vision: tok.vision }))];
  assert.ok(!computeVision(scene, [tok], []).canSee(800, 400)); // behind the wall from the token...
  assert.ok(computeVision(scene, eyes, []).canSee(800, 400));   // ...but seen from its ghosts on the other side
});

test('5 a ghost gives its token\'s light from the ghost (dark scene, wall between linked cells); no light, no change', async () => {
  const { ghostLights } = await import('../public/tp.js');
  const scene = { width: 1000, height: 1000, grid: 70, dark: 1, walls: [[500, 0, 500, 1000, 0, 0]] };
  const cells = [{ id: 'a', x: 105, y: 105, group: '1' }, { id: 'b', x: 805, y: 105, group: '1' }];
  const look = (tok, extra = []) => {
    const ghosts = ghostsOf([tok], cells, 70);
    const viewers = [tok, ...ghosts.map((g) => ({ x: g.x, y: g.y, vision: tok.vision }))]; // no darkvision
    const tokenLight = tok.light > 0 ? [{ x: tok.x, y: tok.y, radius: tok.light, player: !!tok.pc }] : [];
    return { before: computeVision(scene, viewers, [...tokenLight, ...extra]), after: computeVision(scene, viewers, [...tokenLight, ...ghostLights(ghosts), ...extra]), ghosts };
  };
  const lit = look({ x: 105, y: 105, vision: 100, light: 2 });
  assert.ok(!lit.before.canSee(860, 105)); // before the fix: dark around the ghost
  assert.ok(lit.after.canSee(860, 105));   // after: the ghost shines
  assert.ok(!lit.after.canSee(860, 400));  // only within the light's radius
  assert.ok(lit.after.canSee(160, 105));   // the token's own light is unchanged
  assert.equal(ghostLights(lit.ghosts).length, 1); // one light per ghost, nothing doubled at the token
  assert.ok(!look({ x: 105, y: 105, vision: 100, light: 0 }).after.canSee(860, 105)); // no light on the token: still dark
  assert.deepEqual(ghostLights(ghostsOf([{ x: 105, y: 105, light: 2, hidden: true }], cells, 70)), []); // hidden token: no light
  // same rules as the token's light: an anti-light puts it out, unless "players' light wins" and it is a player's token
  const anti = { x: 805, y: 105, radius: 2, anti: true };
  assert.ok(!look({ x: 105, y: 105, vision: 100, light: 2 }, [anti]).after.canSee(860, 105));
  assert.ok(look({ x: 105, y: 105, vision: 100, light: 2, pc: true }, [{ ...anti, playersWin: true }]).after.canSee(860, 105));
  assert.ok(!look({ x: 105, y: 105, vision: 100, light: 2 }, [{ ...anti, playersWin: true }]).after.canSee(860, 105)); // an NPC's light still loses
});
