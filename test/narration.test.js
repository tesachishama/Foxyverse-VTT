import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNarration } from '../server/narration.js';

const actors = [{ id: 1, name: 'Gwen' }, { id: 2, name: 'Eleanor Umbra' }, { id: 3, name: 'Eleanor' }, { id: 4, name: 'Mjolnir' }];
const p = (text) => parseNarration(text, actors);

test('narration: @Sheet switches the speaker until the next @, @mj / @gm narrate, the rest is the default identity', () => {
  assert.equal(p('Hello everyone'), null); // no mention: an ordinary message
  assert.equal(p('mail me at a@gwen.com'), null); // "@" inside a word is not a mention
  assert.deepEqual(p('Welcome back.\n@Gwen Hi!\nHow are you?\n@mj The fire crackles.\n@Eleanor Umbra: Quiet.'), [
    { kind: 'default', text: 'Welcome back.' },
    { kind: 'actor', actorId: 1, text: 'Hi!\nHow are you?' },
    { kind: 'narration', text: 'The fire crackles.' },
    { kind: 'actor', actorId: 2, text: 'Quiet.' }, // the longest name wins over "Eleanor"
  ]);
  assert.deepEqual(p('@eleanor yes @GM silence'), [{ kind: 'actor', actorId: 3, text: 'yes' }, { kind: 'narration', text: 'silence' }]);
  assert.deepEqual(p('@Mjolnir strikes'), [{ kind: 'actor', actorId: 4, text: 'strikes' }]); // "@mj" needs a word boundary
  assert.deepEqual(p('@Gwen @mj Night falls.'), [{ kind: 'narration', text: 'Night falls.' }]); // empty lines are dropped
  assert.equal(p('@Nobody hi'), null);
});
