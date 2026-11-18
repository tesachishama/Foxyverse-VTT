import test from 'node:test';
import assert from 'node:assert/strict';
import { describeServerError } from '../server/log.js';

test('500 reports name the request, the user and carry the stack trace', () => {
  const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const out = describeServerError(err, { method: 'POST', path: '/api/scenes', user: { id: 2, name: 'Mistress', role: 'gm' }, at: new Date(0) });
  assert.match(out, /^\[1970-01-01T00:00:00.000Z\] 500 on POST \/api\/scenes by Mistress \(#2, gm\) \[code ENOSPC\]\n/);
  assert.ok(out.includes(err.stack));
  assert.match(describeServerError('boom', { method: 'GET', path: '/x' }), /by anonymous\nNon-error thrown: boom/);
});
