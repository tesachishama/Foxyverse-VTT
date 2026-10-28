// Small shared helpers for the client. No framework, no build step.

/** Hyperscript: h('div', {class:'x', onclick}, child, [children]). Text is always inserted as text (no innerHTML). */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  const late = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') late[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(9)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  Object.assign(el, late); // value must be set after <option> children exist
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
export async function upload(file) {
  const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.url;
}
export function toast(msg, bad = true) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ------------------------------------------------------------------ i18n
const DICT = {
  fr: {
    signIn: 'Se connecter', create: 'Créer le compte', name: 'Nom', password: 'Mot de passe (8 caractères min.)', invite: "Code d'invitation",
    firstRun: 'Premier lancement : ce compte sera le MJ.', haveAccount: "J'ai déjà un compte", needAccount: 'Créer un compte', logout: 'Quitter',
    chat: 'Chat', sheets: 'Fiches', table: 'Table', rules: 'Règles', system: 'Système',
    chatHint: 'Message ou /jet… (/gm pour le MJ seul)', speakingAs: 'En tant que', noChar: '— aucun personnage —',
    newChar: 'Nouveau personnage', back: 'Retour', del: 'Supprimer', confirmDel: 'Supprimer définitivement ?', placeToken: 'Poser un jeton',
    level: 'Niveau', cls: 'Classe', element: 'Élément', elemental: 'Élémentaire', owner: 'Joueur',
    hp: 'PV', temp: 'Temp.', mp: 'Mana', fav: 'Faveurs', actions: 'Actions', defP: 'DP', defM: 'DM',
    base: 'Base', item: 'Objets', passive: 'Passif', total: 'Total', points: 'Points', modifier: 'Modificateur de jet',
    talents: 'Talents', spells: 'Sorts', items: 'Équipement', notes: 'Notes', currency: 'Monnaie', add: 'Ajouter', cast: 'Lancer', use: 'Utiliser',
    armed: 'Armé', continuous: 'Continu', equipped: 'Équipé', qty: 'Qté', bonuses: 'Bonus (ex. for+2 agi-1)', cost: 'Coût', effect: 'Effet', tier: 'Palier',
    critSuccess: 'Réussite critique', success: 'Réussite', failure: 'Échec', critFailure: 'Échec critique',
    reroll: 'Relancer (faveur)', apply: 'Appliquer', noTarget: 'Sélectionnez un jeton sur la carte.', applied: 'Appliqué',
    scenes: 'Scènes', newScene: 'Nouvelle scène', mapImage: 'Image de la carte', activate: 'Afficher aux joueurs', active: 'Active', grid: 'Grille (px)', offset: 'Décalage X / Y',
    addToken: 'Ajouter un jeton', tokenName: 'Nom du jeton', players: 'Joueurs', inviteCode: "Code d'invitation", regen: 'Nouveau code', gm: 'MJ', player: 'Joueur',
    size: 'Taille', hidden: 'Caché', linked: 'Personnage lié', none: '— aucun —', tokenImage: 'Image du jeton',
    derived: 'Valeurs dérivées', quick: 'Jets rapides', rulesText: 'Texte des règles', rawJson: 'JSON complet', validate: 'Tester', save: 'Enregistrer', reset: 'Réinitialiser', export: 'Exporter', import: 'Importer',
    formulaTest: 'Tester une formule', saved: 'Enregistré', empty: 'Rien ici pour le moment.', roll: 'Jet', rolling: 'Jet',
    invWeapons: 'Armes', invArmor: 'Armures et équipement', invConsumable: 'Consommables', invBag: 'Sacs', invOther: 'Autres objets',
    equipSlots: "Emplacements d'équipement", unequipped: 'Non équipé', slots: 'Emplacement', slotsExpr: 'Emplacements possibles', noExpr: "Aucune expression : l'objet ne peut être que porté (« Autre »).",
    slotChoices: 'choix possibles', emptySlot: 'vide', noFit: 'Aucun objet compatible.', toggle: 'Détails',
    toolRect: 'Rectangle', toolCircle: 'Cercle', toolCurve: 'Courbe', toolEdit: 'Éditer', undo: 'Annuler', snap: 'Aimantation', snapGrid: 'Grille', snapHalf: 'Demi-case', snapOff: 'Libre',
    viewAs: 'Voir comme', viewPlayers: 'Tous les joueurs', viewSelected: 'Jeton sélectionné', sight: 'Partage sa vue', sightHint: 'Ce jeton donne sa vue à tous les joueurs (allié, porteur de torche...)',
    noViewers: "Aucun jeton ne donne la vue : le brouillard est total. Lie un jeton à un personnage de joueur, coche « Partage sa vue », ou choisis « Jeton sélectionné ».",
    noViewersPlayer: "Aucun jeton à toi sur cette scène : le MJ doit lier un jeton à ton personnage.", customCode: 'Choisir un code', setCode: 'Définir',
    portrait: 'Portrait', toComp: 'Enregistrer au compendium', fromComp: '+ compendium', journal: 'Journal', sound: 'Son', compendium: 'Compendium',
    newEntry: 'Nouvelle entrée', edit: 'Modifier', showPlayers: 'Montrer aux joueurs', visibility: 'Visible par', visGM: 'MJ seul', visAll: 'Tout le monde', visCustom: 'Joueurs choisis',
    image: 'Image', body: 'Texte', title: 'Titre', play: 'Lecture', stop: 'Stop', stopAll: 'Tout arrêter', loop: 'Boucle', volume: 'Volume', uploadAudio: 'Ajouter un son',
    unlock: 'Activer le son', mute: 'Muet', toolSelect: 'Sélection', toolWall: 'Mur', toolDoor: 'Porte', toolLight: 'Lumière', toolReveal: 'Révéler', toolErase: 'Gomme',
    fog: 'Brouillard', dark: 'Obscurité', playerView: 'Vue joueurs', radius: 'Rayon', vision: 'Vision (cases)', light: 'Lumière (cases)',
    clearWalls: 'Effacer les murs', clearReveal: 'Effacer les zones révélées', clearLights: 'Effacer les lumières', view: 'Voir', template: 'Enregistrer comme modèle',
    instantiate: 'Créer + jeton', statsEditor: 'Statistiques', aliases: 'Alias (séparés par des virgules)', kind: 'Type', dtype: 'Dégâts', tiers: 'Paliers de maîtrise',
    charRules: 'Création de personnage', baseStat: 'Stat de départ', startPoints: 'Points de départ', startMax: 'Max au départ', spellStats: 'Jets de sorts (armé / non armé)',
    rollTypes: 'Types de jets', idHint: 'Changer un id remet la stat à zéro sur les fiches existantes.', soundHint: 'Les sons se lancent pour tous les joueurs en même temps.',
    noPlayersTokens: 'Aucun jeton de joueur : le brouillard est total.',
  },
  en: {
    signIn: 'Sign in', create: 'Create account', name: 'Name', password: 'Password (8+ characters)', invite: 'Invite code',
    firstRun: 'First run: this account becomes the GM.', haveAccount: 'I already have an account', needAccount: 'Create an account', logout: 'Sign out',
    chat: 'Chat', sheets: 'Sheets', table: 'Table', rules: 'Rules', system: 'System',
    chatHint: 'Message or /roll… (/gm for GM-only)', speakingAs: 'As', noChar: '— no character —',
    newChar: 'New character', back: 'Back', del: 'Delete', confirmDel: 'Delete for good?', placeToken: 'Place token',
    level: 'Level', cls: 'Class', element: 'Element', elemental: 'Elemental', owner: 'Player',
    hp: 'HP', temp: 'Temp', mp: 'Mana', fav: 'Favors', actions: 'Actions', defP: 'DP', defM: 'DM',
    base: 'Base', item: 'Items', passive: 'Passive', total: 'Total', points: 'Points', modifier: 'Roll modifier',
    talents: 'Talents', spells: 'Spells', items: 'Equipment', notes: 'Notes', currency: 'Currency', add: 'Add', cast: 'Cast', use: 'Use',
    armed: 'Armed', continuous: 'Continuous', equipped: 'Equipped', qty: 'Qty', bonuses: 'Bonuses (e.g. str+2 agi-1)', cost: 'Cost', effect: 'Effect', tier: 'Tier',
    critSuccess: 'Critical success', success: 'Success', failure: 'Failure', critFailure: 'Critical failure',
    reroll: 'Reroll (favor)', apply: 'Apply', noTarget: 'Select a token on the map first.', applied: 'Applied',
    scenes: 'Scenes', newScene: 'New scene', mapImage: 'Map image', activate: 'Show to players', active: 'Active', grid: 'Grid (px)', offset: 'Offset X / Y',
    addToken: 'Add token', tokenName: 'Token name', players: 'Players', inviteCode: 'Invite code', regen: 'New code', gm: 'GM', player: 'Player',
    size: 'Size', hidden: 'Hidden', linked: 'Linked character', none: '— none —', tokenImage: 'Token image',
    derived: 'Derived values', quick: 'Quick rolls', rulesText: 'Rules text', rawJson: 'Raw JSON', validate: 'Test', save: 'Save', reset: 'Reset', export: 'Export', import: 'Import',
    formulaTest: 'Test a formula', saved: 'Saved', empty: 'Nothing here yet.', roll: 'Roll', rolling: 'Roll',
    invWeapons: 'Weapons', invArmor: 'Armor and gear', invConsumable: 'Consumables', invBag: 'Bags', invOther: 'Other items',
    equipSlots: 'Equipment slots', unequipped: 'Unequipped', slots: 'Slot', slotsExpr: 'Usable slots', noExpr: 'No expression: the item can only be carried ("Other").',
    slotChoices: 'choices', emptySlot: 'empty', noFit: 'No compatible item.', toggle: 'Details',
    toolRect: 'Rectangle', toolCircle: 'Circle', toolCurve: 'Curve', toolEdit: 'Edit', undo: 'Undo', snap: 'Snapping', snapGrid: 'Grid', snapHalf: 'Half cell', snapOff: 'Free',
    viewAs: 'View as', viewPlayers: 'All players', viewSelected: 'Selected token', sight: 'Shares its sight', sightHint: 'This token gives its sight to every player (ally, torch bearer...)',
    noViewers: 'No token provides sight, so the fog is total. Link a token to a player character, tick "Shares its sight", or choose "Selected token".',
    noViewersPlayer: 'None of your tokens is on this scene: the GM needs to link a token to your character.', customCode: 'Choose a code', setCode: 'Set',
    portrait: 'Portrait', toComp: 'Save to compendium', fromComp: '+ compendium', journal: 'Journal', sound: 'Sound', compendium: 'Compendium',
    newEntry: 'New entry', edit: 'Edit', showPlayers: 'Show to players', visibility: 'Visible to', visGM: 'GM only', visAll: 'Everyone', visCustom: 'Chosen players',
    image: 'Image', body: 'Text', title: 'Title', play: 'Play', stop: 'Stop', stopAll: 'Stop all', loop: 'Loop', volume: 'Volume', uploadAudio: 'Add a sound',
    unlock: 'Enable sound', mute: 'Mute', toolSelect: 'Select', toolWall: 'Wall', toolDoor: 'Door', toolLight: 'Light', toolReveal: 'Reveal', toolErase: 'Erase',
    fog: 'Fog', dark: 'Darkness', playerView: 'Player view', radius: 'Radius', vision: 'Vision (cells)', light: 'Light (cells)',
    clearWalls: 'Clear walls', clearReveal: 'Clear revealed areas', clearLights: 'Clear lights', view: 'View', template: 'Save as template',
    instantiate: 'Create + token', statsEditor: 'Stats', aliases: 'Aliases (comma separated)', kind: 'Kind', dtype: 'Damage', tiers: 'Knowledge tiers',
    charRules: 'Character creation', baseStat: 'Starting stat', startPoints: 'Starting points', startMax: 'Starting max', spellStats: 'Spell rolls (armed / unarmed)',
    rollTypes: 'Roll types', idHint: 'Changing an id resets that stat on existing sheets.', soundHint: 'Sounds start for every player at the same time.',
    noPlayersTokens: 'No player tokens: fog is total.',
  },
};
let lang = localStorage.getItem('lang') || (navigator.language || 'fr').slice(0, 2);
if (!DICT[lang]) lang = 'en';
export const getLang = () => lang;
export const setLang = (l) => { lang = l; localStorage.setItem('lang', l); };
export const t = (k) => DICT[lang][k] ?? DICT.en[k] ?? k;

// ------------------------------------------------------------------ rich text
let knownTypes = new Set();
export function setKnownRollTypes(system) {
  knownTypes = new Set([
    ...system.stats.flatMap((s) => [s.id, ...s.aliases]),
    ...system.rollTypes.flatMap((r) => [r.id, ...r.aliases]),
    ...system.quickRolls.map((q) => q.id),
  ]);
}
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Inline text with **bold** and [type formula|label] roll buttons. onRoll(commandString) is called on click. */
export function inline(text, onRoll) {
  const out = [];
  const re = /\[([\p{L}_]+)\s*([^\]|]*)(?:\|([^\]]*))?\]|\*\*([^*]+)\*\*/gu;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[4] != null) out.push(h('strong', {}, m[4]));
    else if (knownTypes.has(norm(m[1]))) {
      const cmd = `/${m[1]} ${m[2].trim()}${m[3] ? '|' + m[3].trim() : ''}`.replace(/\s+\|/, '|');
      out.push(h('button', { class: 'inline-roll', type: 'button', title: cmd, onclick: () => onRoll(cmd) }, (m[3] || `${m[1]} ${m[2]}`).trim()));
    } else out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Tiny block renderer for rules and notes: "# heading", "- list", paragraphs. */
export function markdown(text, onRoll) {
  const root = h('div', { class: 'md' });
  let list = null;
  for (const block of String(text).split('\n')) {
    const line = block.trimEnd();
    if (line.startsWith('- ')) { if (!list) root.append((list = h('ul'))); list.append(h('li', {}, inline(line.slice(2), onRoll))); continue; }
    list = null;
    if (line.startsWith('# ')) root.append(h('h4', {}, line.slice(2)));
    else if (line.trim()) root.append(h('p', {}, inline(line, onRoll)));
  }
  return root;
}
