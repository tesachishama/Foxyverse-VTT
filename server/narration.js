// GM narration: one chat message where several characters speak in turn.
//   "@GwenDoline Hello there" -> a line said by the sheet whose alias is GwenDoline (its token and name are shown)
//   "@mj The door creaks"     -> narration (italics, no name)       ("@gm" works too)
// The speaker set by a mention stays until the next mention; text before the first mention uses the GM's chosen identity.
// Mentions use each sheet's alias (no spaces, unique in the table, GM-only). Pure module (no DB), shared with the tests.

export const NARRATOR = ['mj', 'gm'];
const boundary = (ch) => ch === undefined || /[\s,.:;!?)]/.test(ch);

/** The alias a name gives: no spaces and no "@" ("Gwen Doline" -> "GwenDoline"), at most 40 characters. */
export const aliasFrom = (name) => String(name ?? '').replace(/[\s@]+/g, '').slice(0, 40);
/** First free alias among base, base2, base3... (case-insensitive; "mj" and "gm" are never free). */
export function uniqueAlias(base, taken) {
  const root = aliasFrom(base) || 'Fiche';
  const used = new Set([...taken].map((x) => String(x).toLowerCase()));
  const free = (x) => !used.has(x.toLowerCase()) && !NARRATOR.includes(x.toLowerCase());
  if (free(root)) return root;
  for (let n = 2; ; n++) { const x = root.slice(0, 40 - String(n).length) + n; if (free(x)) return x; }
}

/** actors: [{ id, alias }]. Returns null when the text mentions nobody (an ordinary message), else
 *  [{ kind: 'default' | 'actor' | 'narration', actorId?, text }] with empty parts dropped. */
export function parseNarration(text, actors) {
  const names = [...actors.filter((a) => a.alias?.trim()).map((a) => ({ key: a.alias.trim().toLowerCase(), actor: a })), ...NARRATOR.map((key) => ({ key, narrator: true }))]
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
