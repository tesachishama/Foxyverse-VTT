/**
 * Expression engine.
 *
 * Parses the human-authored "usable slots" syntax into concrete equip options.
 * - Accepts EN and FR aliases for slots/groups
 * - Produces equip options as arrays of canonical slot ids (e.g. ["hat","pendant2"])
 *
 * The grammar and aliases are documented in `docs/equipment-slots.md`.
 * Code map: `docs/CODEBASE.md#supporting-modules`.
 */
/**
 * Equipment slots: expression engine ported from the Foxyverse Owlbear plugin (src/data/equipSlots.js, MIT).
 * Shared by the server (validation) and the browser (equip menus). See README "Equipment slots" for the syntax.
 */
/** Lowercase key: trim + diacritic fold. */
export function normalizeKey(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{Diacritic}+/gu, '').trim().toLowerCase();
}

export const CANONICAL_SLOTS = [
  "weapon1", "weapon2", "weapon3",
  "hat", "face",
  "pendant1", "pendant2", "pendant3",
  "torso",
  "rshoulder", "lshoulder",
  "rarm", "larm",
  "rwrist", "lwrist",
  "rthumb", "rindex", "rmiddle", "rring", "rpinky",
  "lthumb", "lindex", "lmiddle", "lring", "lpinky",
  "belt",
  "rleg", "lleg",
  "rankle", "lankle",
  "rfoot", "lfoot",
  "other",
];

export const SLOT_ALIASES = Object.freeze({
  weapon1: "weapon1", arme1: "weapon1",
  weapon2: "weapon2", arme2: "weapon2",
  weapon3: "weapon3", arme3: "weapon3",
  hat: "hat", chapeau: "hat",
  face: "face", visage: "face",
  pendant1: "pendant1", pendentif1: "pendant1",
  pendant2: "pendant2", pendentif2: "pendant2",
  pendant3: "pendant3", pendentif3: "pendant3",
  torso: "torso", torse: "torso",
  rshoulder: "rshoulder", epauled: "rshoulder",
  lshoulder: "lshoulder", epauleg: "lshoulder",
  rarm: "rarm", brasd: "rarm",
  larm: "larm", brasg: "larm",
  rwrist: "rwrist", poignetd: "rwrist",
  lwrist: "lwrist", poignetg: "lwrist",
  rthumb: "rthumb", pouced: "rthumb",
  rindex: "rindex", indexd: "rindex",
  rmiddle: "rmiddle", majeurd: "rmiddle",
  rring: "rring", annulaired: "rring",
  rpinky: "rpinky", auriculaired: "rpinky",
  lthumb: "lthumb", pouceg: "lthumb",
  lindex: "lindex", indexg: "lindex",
  lmiddle: "lmiddle", majeurg: "lmiddle",
  lring: "lring", annulaireg: "lring",
  lpinky: "lpinky", auriculaireg: "lpinky",
  belt: "belt", ceinture: "belt",
  rleg: "rleg", jambed: "rleg",
  lleg: "lleg", jambeg: "lleg",
  rankle: "rankle", chevilled: "rankle",
  lankle: "lankle", chevilleg: "lankle",
  rfoot: "rfoot", piedd: "rfoot",
  lfoot: "lfoot", piedg: "lfoot",
  other: "other", autre: "other",
});

/** Resolve a slot token (alias, FR/EN, legacy PascalCase, or canonical id) to a canonical slot id. */
export function canonizeSlotToken(raw) {
  const k = normalizeKey(raw);
  if (!k) return null;
  if (SLOT_ALIASES[k]) return SLOT_ALIASES[k];
  if (CANONICAL_SLOTS.includes(k)) return k;
  return null;
}

const GROUP_SLOTS = Object.freeze({
  weapons: ["weapon1", "weapon2", "weapon3"],
  head: ["hat", "face"],
  necklace: ["pendant1", "pendant2", "pendant3"],
  upper: [
    "torso", "rshoulder", "lshoulder", "rarm", "larm", "rwrist", "lwrist",
    "rthumb", "rindex", "rmiddle", "rring", "rpinky",
    "lthumb", "lindex", "lmiddle", "lring", "lpinky",
  ],
  shoulders: ["rshoulder", "lshoulder"],
  arms: ["rarm", "larm"],
  wrists: ["rwrist", "lwrist"],
  fingers: [
    "rthumb", "rindex", "rmiddle", "rring", "rpinky",
    "lthumb", "lindex", "lmiddle", "lring", "lpinky",
  ],
  rfingers: ["rthumb", "rindex", "rmiddle", "rring", "rpinky"],
  lfingers: ["lthumb", "lindex", "lmiddle", "lring", "lpinky"],
  lower: ["belt", "rleg", "lleg", "rankle", "lankle", "rfoot", "lfoot"],
  legs: ["rleg", "lleg"],
  ankles: ["rankle", "lankle"],
  feet: ["rfoot", "lfoot"],
  fullrarm: ["rshoulder", "rarm"],
  fulllarm: ["lshoulder", "larm"],
  fullrleg: ["rleg", "rfoot"],
  fulllleg: ["lleg", "lfoot"],
});

export const GROUP_ALIASES = Object.freeze({
  weapons: "weapons", armes: "weapons",
  head: "head", tete: "head",
  necklace: "necklace", collier: "necklace",
  upper: "upper", haut: "upper",
  shoulders: "shoulders", epaules: "shoulders",
  arms: "arms", bras: "arms",
  wrists: "wrists", poignets: "wrists",
  fingers: "fingers", doigts: "fingers",
  rfingers: "rfingers", doigtsd: "rfingers",
  lfingers: "lfingers", doigtsg: "lfingers",
  lower: "lower", bas: "lower",
  legs: "legs", jambes: "legs",
  ankles: "ankles", chevilles: "ankles",
  feet: "feet", pieds: "feet",
  fullrarm: "fullrarm", brasdcomplet: "fullrarm",
  fulllarm: "fulllarm", brasgcomplet: "fulllarm",
  fullrleg: "fullrleg", jambedcomplete: "fullrleg",
  fulllleg: "fulllleg", jambegcomplete: "fulllleg",
});

function canonicalSlot(raw) {
  const k = normalizeKey(raw);
  return SLOT_ALIASES[k] || null;
}

function canonicalGroup(raw) {
  const k = normalizeKey(raw);
  return GROUP_ALIASES[k] || null;
}

function isIdentChar(ch) {
  return /[A-Za-z0-9_\u00C0-\u017F]/.test(ch);
}

function tokenize(input) {
  const s = String(input || "");
  const out = [];
  let i = 0;
  const push = (type, value = null) => out.push({ type, value });
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]") { push(ch); i++; continue; }
    if (ch === "&" || ch === "+" || ch === "|" || ch === "-" || ch === "*") { push(ch); i++; continue; }
    if (/\d/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /\d/.test(s[j])) j++;
      push("num", s.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentChar(ch)) {
      let j = i + 1;
      while (j < s.length && isIdentChar(s[j])) j++;
      const raw = s.slice(i, j);
      const k = normalizeKey(raw);
      if (k === "and") push("and");
      else if (k === "or") push("or");
      else if (k === "all") push("all");
      else push("ident", raw);
      i = j;
      continue;
    }
    // Unknown char: skip, but keep a marker for error reporting.
    push("unknown", ch);
    i++;
  }
  push("eof");
  return out;
}

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.i = 0;
    this.errors = [];
  }
  peek() { return this.toks[this.i] || { type: "eof" }; }
  next() { return this.toks[this.i++] || { type: "eof" }; }
  accept(type) {
    if (this.peek().type === type) { this.next(); return true; }
    return false;
  }
  acceptAny(types) {
    const t = this.peek().type;
    if (types.includes(t)) { this.next(); return t; }
    return null;
  }
  expect(type, msg) {
    if (this.accept(type)) return true;
    this.errors.push(msg || `Expected ${type}`);
    return false;
  }

  parse() {
    const expr = this.parseOr();
    // Eat trailing unknown tokens
    while (this.peek().type !== "eof") {
      const t = this.next();
      if (t.type === "unknown") this.errors.push(`Unexpected '${t.value}'`);
    }
    return { ast: expr, errors: this.errors };
  }

  // OR (lowest)
  parseOr() {
    let left = this.parseAnd();
    const parts = [left];
    while (true) {
      const t = this.acceptAny(["|", "or"]);
      if (!t) break;
      parts.push(this.parseAnd());
    }
    return parts.length === 1 ? left : { kind: "or", parts };
  }

  // AND
  parseAnd() {
    let left = this.parseExclude();
    const parts = [left];
    while (true) {
      const t = this.acceptAny(["&", "+", "and"]);
      if (!t) break;
      parts.push(this.parseExclude());
    }
    return parts.length === 1 ? left : { kind: "and", parts };
  }

  // exclusion: A - B (right associative-ish; chain left)
  parseExclude() {
    let left = this.parseQty();
    while (this.accept("-")) {
      const right = this.parseQty();
      left = { kind: "exclude", base: left, remove: right };
    }
    return left;
  }

  // quantity: [group] * (num|all)
  parseQty() {
    let node = this.parseAtom();
    if (this.accept("*")) {
      const tok = this.peek();
      if (tok.type === "num") {
        this.next();
        node = { kind: "qty", node, count: parseInt(tok.value, 10) || 1 };
      } else if (tok.type === "all") {
        this.next();
        node = { kind: "qty", node, count: "all" };
      } else {
        this.errors.push("Expected number or 'all' after '*'");
        node = { kind: "qty", node, count: 1 };
      }
    }
    return node;
  }

  parseAtom() {
    const t = this.peek();
    if (this.accept("(")) {
      const inner = this.parseOr();
      this.expect(")", "Missing ')'");
      return inner;
    }
    if (this.accept("[")) {
      const idTok = this.peek();
      let name = "";
      if (idTok.type === "ident") {
        name = String(idTok.value || "");
        this.next();
      } else {
        this.errors.push("Expected group name after '['");
      }
      this.expect("]", "Missing ']'");
      return { kind: "group", name };
    }
    if (t.type === "ident") {
      this.next();
      return { kind: "slot", name: String(t.value || "") };
    }
    if (t.type === "unknown") {
      this.next();
      this.errors.push(`Unexpected '${t.value}'`);
      return { kind: "slot", name: "" };
    }
    // eof or unexpected
    this.next();
    this.errors.push("Unexpected end of expression");
    return { kind: "slot", name: "" };
  }
}

function uniqKeyedOptions(options) {
  const seen = new Set();
  const out = [];
  for (const opt of options) {
    const key = [...opt].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(opt);
  }
  return out;
}

function chooseN(arr, n) {
  const out = [];
  const rec = (start, picked) => {
    if (picked.length === n) { out.push([...picked]); return; }
    for (let i = start; i < arr.length; i++) {
      picked.push(arr[i]);
      rec(i + 1, picked);
      picked.pop();
    }
  };
  rec(0, []);
  return out;
}

function evalNode(node) {
  if (!node || typeof node !== "object") return [];
  switch (node.kind) {
    case "slot": {
      const c = canonicalSlot(node.name);
      return c ? [[c]] : [];
    }
    case "group": {
      const g = canonicalGroup(node.name);
      const slots = g ? (GROUP_SLOTS[g] || []) : [];
      return slots.map((s) => [s]);
    }
    case "or": {
      const all = node.parts.flatMap((p) => evalNode(p));
      return uniqKeyedOptions(all);
    }
    case "and": {
      let acc = [[]];
      for (const p of node.parts) {
        const rhs = evalNode(p);
        const next = [];
        for (const a of acc) {
          for (const b of rhs) {
            const merged = [...a];
            let ok = true;
            for (const s of b) {
              if (merged.includes(s)) { ok = false; break; }
              merged.push(s);
            }
            if (ok) next.push(merged);
          }
        }
        acc = next;
      }
      return uniqKeyedOptions(acc);
    }
    case "exclude": {
      // Intended primarily for: [group] - (slot|slot)
      const base = node.base;
      if (!base || base.kind !== "group") {
        return evalNode(base);
      }
      const g = canonicalGroup(base.name);
      const slots = g ? [...(GROUP_SLOTS[g] || [])] : [];
      const rmOpts = evalNode(node.remove);
      const rmSet = new Set(rmOpts.flat());
      const remaining = slots.filter((s) => !rmSet.has(s));
      return remaining.map((s) => [s]);
    }
    case "qty": {
      // Intended for: [group] * N or [group] * all
      const base = node.node;
      if (!base || base.kind !== "group") {
        return evalNode(base);
      }
      const g = canonicalGroup(base.name);
      const slots = g ? [...(GROUP_SLOTS[g] || [])] : [];
      if (node.count === "all") return slots.length ? [slots] : [];
      const n = Math.max(0, Math.min(slots.length, Number(node.count) || 0));
      if (n <= 0) return [];
      return chooseN(slots, n);
    }
    default:
      return [];
  }
}

export function parseEquipSlotsExpr(expr) {
  const toks = tokenize(expr);
  const p = new Parser(toks);
  return p.parse();
}

/**
 * Evaluate a usable-slots expression into equip options.
 * Returns canonical slot sets; does NOT auto-add "other".
 */
export function evalEquipSlotsExpr(expr) {
  const { ast, errors } = parseEquipSlotsExpr(expr);
  const options = ast ? uniqKeyedOptions(evalNode(ast)) : [];
  return { options, errors };
}


/** Display names of the canonical slots (from the plugin's translations). */
export const SLOT_LABELS = Object.freeze({
  weapon1: { en: 'Weapon 1', fr: 'Arme 1' }, weapon2: { en: 'Weapon 2', fr: 'Arme 2' }, weapon3: { en: 'Weapon 3', fr: 'Arme 3' },
  hat: { en: 'Hat', fr: 'Chapeau' }, face: { en: 'Face', fr: 'Visage' },
  pendant1: { en: 'Pendant 1', fr: 'Pendentif 1' }, pendant2: { en: 'Pendant 2', fr: 'Pendentif 2' }, pendant3: { en: 'Pendant 3', fr: 'Pendentif 3' },
  torso: { en: 'Torso', fr: 'Torse' },
  rshoulder: { en: 'Right shoulder', fr: 'Épaule droite' }, lshoulder: { en: 'Left shoulder', fr: 'Épaule gauche' },
  rarm: { en: 'Right arm', fr: 'Bras droit' }, larm: { en: 'Left arm', fr: 'Bras gauche' },
  rwrist: { en: 'Right wrist', fr: 'Poignet droit' }, lwrist: { en: 'Left wrist', fr: 'Poignet gauche' },
  rthumb: { en: 'R. thumb', fr: 'Pouce D' }, rindex: { en: 'R. index', fr: 'Index D' }, rmiddle: { en: 'R. middle', fr: 'Majeur D' }, rring: { en: 'R. ring', fr: 'Annulaire D' }, rpinky: { en: 'R. pinky', fr: 'Auriculaire D' },
  lthumb: { en: 'L. thumb', fr: 'Pouce G' }, lindex: { en: 'L. index', fr: 'Index G' }, lmiddle: { en: 'L. middle', fr: 'Majeur G' }, lring: { en: 'L. ring', fr: 'Annulaire G' }, lpinky: { en: 'L. pinky', fr: 'Auriculaire G' },
  belt: { en: 'Belt', fr: 'Ceinture' },
  rleg: { en: 'Right leg', fr: 'Jambe droite' }, lleg: { en: 'Left leg', fr: 'Jambe gauche' },
  rankle: { en: 'Right ankle', fr: 'Cheville droite' }, lankle: { en: 'Left ankle', fr: 'Cheville gauche' },
  rfoot: { en: 'Right foot', fr: 'Pied droit' }, lfoot: { en: 'Left foot', fr: 'Pied gauche' },
  other: { en: 'Other', fr: 'Autre' },
});
export const slotLabel = (id, lang = 'en') => SLOT_LABELS[id]?.[lang] ?? SLOT_LABELS[id]?.en ?? id;
