// GM narration: one chat message where several characters speak in turn.
//   "@Gwen Hello there"   -> a line said by the sheet named Gwen (its token and name are shown)
//   "@mj The door creaks" -> narration (italics, no name)       ("@gm" works too)
// The speaker set by a mention stays until the next mention; text before the first mention uses the GM's chosen identity.
// Names may contain spaces: the longest sheet name that follows "@" wins. Pure module (no DB), shared with the tests.

const NARRATOR = ['mj', 'gm'];
const boundary = (ch) => ch === undefined || /[\s,.:;!?)]/.test(ch);

/** actors: [{ id, name }]. Returns null when the text mentions nobody (an ordinary message), else
 *  [{ kind: 'default' | 'actor' | 'narration', actorId?, text }] with empty parts dropped. */
export function parseNarration(text, actors) {
  const names = [...actors.filter((a) => a.name?.trim()).map((a) => ({ key: a.name.trim().toLowerCase(), actor: a })), ...NARRATOR.map((key) => ({ key, narrator: true }))]
    .sort((a, b) => b.key.length - a.key.length);
  const lower = text.toLowerCase();
  const marks = []; // { at, end, who }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' || (i > 0 && !/\s/.test(text[i - 1]))) continue;
    const hit = names.find((n) => lower.startsWith(n.key, i + 1) && boundary(text[i + 1 + n.key.length]));
    if (hit) { marks.push({ at: i, end: i + 1 + hit.key.length, who: hit }); i += hit.key.length; }
  }
  if (!marks.length) return null;
  const parts = [];
  const push = (who, chunk) => {
    const clean = chunk.replace(/^\s*:?\s*/, '').replace(/\s+$/, ''); // "@Gwen: hi" and "@Gwen hi" both say "hi"
    if (!clean) return;
    if (!who) parts.push({ kind: 'default', text: clean });
    else if (who.narrator) parts.push({ kind: 'narration', text: clean });
    else parts.push({ kind: 'actor', actorId: who.actor.id, text: clean });
  };
  push(null, text.slice(0, marks[0].at));
  marks.forEach((m, k) => push(m.who, text.slice(m.end, marks[k + 1]?.at ?? text.length)));
  return parts;
}
