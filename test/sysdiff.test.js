import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSystems } from '../server/sysdiff.js';

test('system diff: lists with ids compare by id, objects by key, everything else as a whole', () => {
  const a = { name: 'A', stats: [{ id: 'con', label: 'Con', aliases: ['c'] }, { id: 'str', label: 'Str', aliases: [] }], character: { baseStat: 5 }, rules: [{ title: 'Intro', body: 'Hi' }] };
  const b = { name: 'B', stats: [{ id: 'str', label: 'Str', aliases: [] }, { id: 'con', label: 'Constitution', aliases: ['c', 'co'] }, { id: 'luck', label: 'Luck', aliases: [] }],
    character: { baseStat: 6 }, rules: [] };
  const d = diffSystems(a, b);
  assert.deepEqual(d.map((x) => [x.path, x.op]), [
    ['name', 'changed'], ['stats.con.label', 'changed'], ['stats.con.aliases', 'changed'], ['stats.luck', 'added'],
    ['character.baseStat', 'changed'], ['rules.Intro', 'removed'],
  ]); // reordering str/con is not a difference
  assert.deepEqual(d[3].after, { id: 'luck', label: 'Luck', aliases: [] });
  assert.deepEqual(diffSystems(a, structuredClone(a)), []);
});
