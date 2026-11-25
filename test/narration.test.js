import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNarration, aliasFrom, uniqueAlias } from '../server/narration.js';

const actors = [{ id: 1, alias: 'Gwen' }, { id: 2, alias: 'EleanorUmbra' }, { id: 3, alias: 'Eleanor' }, { id: 4, alias: 'Mjolnir' }];
const p = (text) => parseNarration(text, actors);

test('narration: @Alias switches the speaker until the next @, @mj / @gm narrate, the rest is the default identity', () => {
  assert.equal(p('Hello everyone'), null); // no mention: an ordinary message
  assert.equal(p('mail me at a@gwen.com'), null); // "@" inside a word is not a mention
  assert.deepEqual(p('Welcome back.\n@Gwen Hi!\nHow are you?\n@mj The fire crackles.\n@EleanorUmbra: Quiet.'), [
    { kind: 'default', text: 'Welcome back.' },
    { kind: 'actor', actorId: 1, text: 'Hi!\nHow are you?' },
    { kind: 'narration', text: 'The fire crackles.' },
    { kind: 'actor', actorId: 2, text: 'Quiet.' }, // the longest alias wins over "Eleanor"
  ]);
  assert.deepEqual(p('@eleanor yes @GM silence'), [{ kind: 'actor', actorId: 3, text: 'yes' }, { kind: 'narration', text: 'silence' }]);
  assert.deepEqual(p('@Mjolnir strikes'), [{ kind: 'actor', actorId: 4, text: 'strikes' }]); // "@mj" needs a word boundary
  assert.deepEqual(p('@Gwen @mj Night falls.'), [{ kind: 'narration', text: 'Night falls.' }]); // empty lines are dropped
  assert.equal(p('@Nobody hi'), null);
});

test('aliases: no spaces, a number on duplicates, never mj / gm', () => {
  assert.equal(aliasFrom('Gwen Doline'), 'GwenDoline');
  assert.equal(aliasFrom('  @Bob  the  Elf '), 'BobtheElf');
  assert.equal(uniqueAlias('Gwen Doline', []), 'GwenDoline');
  assert.equal(uniqueAlias('Gwen Doline', ['gwendoline']), 'GwenDoline2');
  assert.equal(uniqueAlias('Gwen Doline', ['GwenDoline', 'GwenDoline2']), 'GwenDoline3');
  assert.equal(uniqueAlias('MJ', []), 'MJ2');
  assert.equal(uniqueAlias('   ', []), 'Fiche');
});
