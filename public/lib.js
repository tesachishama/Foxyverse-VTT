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

// Each open page has its own id: realtime events carry it back ("by") so a page can skip the echo of its own changes.
export const CLIENT_ID = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
// Where table calls go: /api/t/<slug> for a player, /admin/api/t/<slug> for the GM, /admin/api/library for the map library.
let apiBase = '/api', uploadUrl = '/api/upload';
export function setApiBase(base, upload = base + '/upload') { apiBase = base; uploadUrl = upload; }
export const eventsUrl = () => `${apiBase}/events?c=${CLIENT_ID}`;
/** Call an absolute URL. Errors carry the HTTP status (401: pick a player first, 404: no such table). */
export async function request(method, url, body) {
  const res = await fetch(url, { method, headers: { 'X-Client': CLIENT_ID, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}
export const api = (method, path, body) => request(method, apiBase + path, body);
export async function upload(file) {
  const res = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': file.type, 'X-Client': CLIENT_ID }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.url;
}
export function toast(msg, bad = true) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}
/**
 * In-page replacement for confirm() / prompt() (some browsers and embedded views block native dialogs, and the buttons then did nothing).
 * ask(message) -> Promise<boolean>; ask(message, { input: 'default' }) -> Promise<string | null>.
 */
export function ask(message, { input } = {}) {
  return new Promise((resolve) => {
    const field = input !== undefined && h('input', { type: 'text', value: input, class: 'grow' });
    const done = (v) => { wrap.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const ok = () => done(field ? field.value : true), no = () => done(field ? null : false);
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); no(); } else if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    const wrap = h('div', { class: 'modal ask', onclick: (e) => { if (e.target === e.currentTarget) no(); } },
      h('div', { class: 'modal-card' }, h('p', {}, message), field,
        h('div', { class: 'line' }, h('button', { class: 'primary', onclick: ok }, t('okBtn')), h('button', { onclick: no }, t('cancel')))));
    document.body.append(wrap);
    document.addEventListener('keydown', key, true);
    (field || wrap.querySelector('button.primary')).focus();
  });
}
export const debounce =(fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ------------------------------------------------------------------ i18n
const DICT = {
  fr: {
    name: 'Nom', logout: 'Changer de joueur',
    tables: 'Tables', chooseTable: 'Choisis ta table', noTables: "Aucune table publique pour l'instant. Demande le lien à ton MJ.",
    pickPlayer: 'Qui es-tu ?', taken: 'déjà en jeu', you: 'toi', noSlots: "Le MJ n'a pas encore créé de joueur à cette table.", tableNotFound: "Il n'y a pas de table à cette adresse.",
    kicked: "Le MJ t'a déconnecté.", tableGone: 'Cette table a été supprimée.', allTables: 'Toutes les tables',
    gmHome: 'Accueil MJ', newTable: 'Nouvelle table', tableName: 'Nom de la table', tableAddress: 'Adresse', listed: "Listée (visible sur la page d'accueil)", unlisted: 'non listée', listedShort: 'listée',
    openTable: 'Ouvrir', online: 'en ligne', playersShort: 'joueurs', confirmTable: "Tape l'adresse de la table pour la supprimer avec tout son contenu :",
    devMode: 'Mode dev : ADMIN_SECRET est vide, donc /admin est ouvert à tous ceux qui atteignent le serveur. Voir le README.',
    addPlayer: 'Ajouter un joueur', kick: 'Déconnecter', playerLink: 'Lien pour les joueurs', copyLink: 'Copier', copied: 'Copié',
    perms: 'Droits des joueurs', permEdit: 'Édition', permView: 'Vue seule', permNone: 'Aucun', viewOnly: 'Vue seule : tu ne peux pas modifier cette fiche.',
    mapLibrary: 'Bibliothèque de maps', mapHint: 'Maps préparées hors table (murs, lumières...). « Copier vers » en met une copie dans une table.',
    newMap: 'Nouvelle map', editMap: 'Éditer', copyTo: 'Copier vers…', toLibrary: 'Copier dans la bibliothèque', fromLibrary: '+ depuis la bibliothèque', copiedTo: 'Copiée vers',
    tableSettings: 'Réglages de la table', mapName: 'Nom de la map',
    chatHintGm: 'Message, /jet, ou @Fiche pour faire parler… (Maj+Entrée : nouvelle ligne)', narrator: 'narration (italique)', chatToDynamic: 'Replier automatiquement', chatToPinned: 'Garder ouvert',
    life: 'État', lifeAuto: 'Auto (PV de la fiche)', lifeDead: 'Forcer : mort', lifeAlive: 'Forcer : vivant', lifeHint: 'Mort = noir et blanc pour tout le monde. Auto : mort à 0 PV ou moins.', close: 'Fermer', color: 'Couleur', choose: 'Choisir…',
    picture: 'Image du personnage', newPortrait: 'Nouveau portrait', cropToken: 'Recadrer le token', readyToken: 'Token tout fait', zoom: 'Zoom',
    cropHint: 'Glisse pour déplacer, molette ou curseur pour zoomer.',
    lockText: 'Enregistrer la description (la verrouille)', unlockText: 'Modifier la description',
    talentActive: "Coché : s'applique à tous tes tests de stat", talentsOn: 'Talents cochés, sur les tests de stat', talentHint: "Coche un talent pour qu'il s'applique à tous tes tests de stat.", description: 'Description',
    compThis: 'Cette table', compGlobal: 'Global', npcs: 'PNJ', newItem: 'Nouvel objet', newSpell: 'Nouveau sort', visibleToPlayers: 'Visible des joueurs même sans fiche qui le porte',
    autoHint: "Créée depuis une fiche : elle suit la fiche tant que tu ne la modifies pas", staleCopy: "L'original (hors table) a changé depuis la copie", updateCopy: 'Mettre à jour',
    compGmHint: 'Tout objet ou sort nommé sur une fiche arrive ici tout seul. Les joueurs voient ce qui est sur leurs fiches, plus ce que tu coches 👁.',
    compPlayerHint: 'Ici apparaissent les objets et sorts de tes fiches, et ce que le MJ te montre.', npcHint: 'Coche les fiches à montrer aux joueurs dans le compendium (nom et image seulement).',
    shownToPlayers: 'Montré aux joueurs (PNJ)', addToTable: 'Ajouter à la table', inThisTable: 'dans cette table', outside: 'Hors table',
    campaigns: 'Campagnes', campaign: 'Campagne', noCampaign: '— sans campagne —', newCampaign: 'Nouvelle campagne', linkedSystem: 'Système lié', noLinkedSystem: '— pas de système lié —',
    campaignHint: "Une campagne relie des tables d'une même histoire : ce qu'elles créent porte son nom (filtre du compendium global), et son système lié sert de règles de départ.",
    systemsLib: 'Bibliothèque de systèmes', systemsHint: "Les règles d'une table enregistrées sous un nom (onglet Système d'une table), à appliquer à d'autres tables.",
    saveSystemAs: 'Enregistrer ces règles…', updateSystem: 'Écraser un système enregistré…', applySystem: 'Appliquer un système enregistré…', systemName: 'Nom du système enregistré',
    confirmOverwrite: 'Remplacer ce système enregistré par les règles de cette table ?', diffTitle: 'Changements', noDiff: 'Aucune différence avec les règles actuelles.',
    applyNow: 'Appliquer', cancel: 'Annuler', applyLinked: 'Cette campagne a un système lié. Voici ce qui changerait dans les règles de la table :',
    opAdded: 'ajouté', opRemoved: 'retiré', opChanged: 'modifié',
    chat: 'Chat', sheets: 'Fiches', table: 'Table', rules: 'Règles', system: 'Système',
    chatHint: 'Message ou /jet… (/gm pour le MJ seul)', speakingAs: 'En tant que', noChar: '— aucun personnage —',
    newChar: 'Nouveau personnage', back: 'Retour', del: 'Supprimer', confirmDel: 'Supprimer définitivement ?', placeToken: 'Poser un jeton',
    level: 'Niveau', cls: 'Classe', element: 'Élément', elemental: 'Élémentaire', owner: 'Joueur',
    hp: 'PV', temp: 'Temp.', mp: 'Mana', fav: 'Faveurs', actions: 'Actions', defP: 'DP', defM: 'DM',
    base: 'Base', item: 'Objets', passive: 'Passif', total: 'Total', points: 'Points', modifier: 'Modificateur de jet',
    talents: 'Talents', spells: 'Sorts', items: 'Équipement', notes: 'Notes', currency: 'Monnaie', add: 'Ajouter', cast: 'Lancer', use: 'Utiliser',
    armed: 'Armé', continuous: 'Continu', equipped: 'Équipé', qty: 'Qté', bonuses: 'Bonus (ex. for+2 agi-1)', cost: 'Coût', effect: 'Effet', effectHint: 'Effet : **gras**, boutons [pdmg 2d30 | physique], [str +2|label]', tier: 'Palier',
    critSuccess: 'Réussite critique', success: 'Réussite', failure: 'Échec', critFailure: 'Échec critique',
    reroll: 'Relancer (faveur)', apply: 'Appliquer', noTarget: 'Sélectionnez un jeton sur la carte.', applied: 'Appliqué', undoApply: 'Annuler cette application',
    scenes: 'Scènes', newScene: 'Nouvelle scène', mapImage: 'Image de la carte', activate: 'Afficher aux joueurs', active: 'Active', grid: 'Grille (px)', offset: 'Décalage X / Y',
    addToken: 'Ajouter un jeton', tokenName: 'Nom du jeton', players: 'Joueurs', gm: 'MJ', player: 'Joueur',
    size: 'Taille', hidden: 'Caché', linked: 'Personnage lié', none: '— aucun —', tokenImage: 'Image du jeton',
    derived: 'Valeurs dérivées', quick: 'Jets rapides', rulesText: 'Texte des règles', rawJson: 'JSON complet', validate: 'Tester', save: 'Enregistrer', reset: 'Réinitialiser', export: 'Exporter', import: 'Importer',
    formulaTest: 'Tester une formule', saved: 'Enregistré', empty: 'Rien ici pour le moment.', roll: 'Jet', rolling: 'Jet',
    invWeapons: 'Armes', invArmor: 'Armures et équipement', invConsumable: 'Consommables', invBag: 'Sacs', invOther: 'Autres objets',
    equipSlots: "Emplacements d'équipement", unequipped: 'Non équipé', slots: 'Emplacement', slotsExpr: 'Emplacements possibles', noExpr: "Aucune expression : l'objet ne peut être que porté (« Autre »).",
    slotChoices: 'choix possibles', emptySlot: 'vide', noFit: 'Aucun objet compatible.', toggle: 'Détails',
    toolRect: 'Rectangle', toolCircle: 'Cercle', toolCurve: 'Courbe', toolEdit: 'Éditer', undo: 'Annuler', snap: 'Aimantation', snapGrid: 'Grille', snapHalf: 'Demi-case', snapOff: 'Libre',
    viewAs: 'Voir comme', viewPlayers: 'Tous les joueurs', viewSelected: 'Jeton sélectionné', sight: 'Partage sa vue', sightHint: 'Ce jeton donne sa vue à tous les joueurs (allié, porteur de torche...)',
    noViewers: "Aucun jeton ne donne la vue : le brouillard est total. Lie un jeton à un personnage de joueur, coche « Partage sa vue », ou choisis « Jeton sélectionné ».",
    noViewersPlayer: "Aucun jeton à toi sur cette scène : le MJ doit lier un jeton à ton personnage.",
    portrait: 'Portrait', toComp: 'Enregistrer au compendium', fromComp: '+ compendium', journal: 'Journal', sound: 'Son', compendium: 'Compendium',
    newEntry: 'Nouvelle entrée', edit: 'Modifier', showPlayers: 'Montrer aux joueurs', visibility: 'Visible par', visGM: 'MJ seul', visAll: 'Tout le monde', visCustom: 'Joueurs choisis',
    image: 'Image', body: 'Texte', title: 'Titre', play: 'Lecture', stop: 'Stop', stopAll: 'Tout arrêter', loop: 'Boucle', volume: 'Volume', uploadAudio: 'Ajouter un son',
    unlock: 'Activer le son', mute: 'Muet', toolSelect: 'Sélection', toolWall: 'Mur', toolDoor: 'Porte', toolLight: 'Lumière', toolReveal: 'Révéler', toolErase: 'Gomme',
    fog: 'Brouillard', dark: 'Obscurité', playerView: 'Vue joueurs', radius: 'Rayon', vision: 'Vision (cases, 0 = aucune)', light: 'Lumière (cases)',
    clearWalls: 'Effacer les murs', clearReveal: 'Effacer les zones révélées', clearLights: 'Effacer les lumières', view: 'Voir', template: 'Enregistrer comme modèle',
    instantiate: 'Créer + jeton', statsEditor: 'Statistiques', aliases: 'Alias (séparés par des virgules)', kind: 'Type', dtype: 'Dégâts', tiers: 'Paliers de maîtrise',
    charRules: 'Création de personnage', baseStat: 'Stat de départ', startPoints: 'Points de départ', startMax: 'Max au départ', spellStats: 'Jets de sorts (armé / non armé)',
    rollTypes: 'Types de jets', idHint: 'Changer un id remet la stat à zéro sur les fiches existantes.', soundHint: 'Les sons se lancent pour tous les joueurs en même temps.',
    noPlayersTokens: 'Aucun jeton de joueur : le brouillard est total.',
    alias: 'Alias @', aliasAuto: 'depuis le nom', aliasHint: "Pour la narration : @alias dans le chat (sans espaces, unique dans la table, visible par le MJ seul). Vide : suit le nom.",
    search: 'Rechercher', newOne: 'Nouveau', fromCompendium: 'Depuis le compendium', noMatch: 'Aucun résultat.', compEmpty: 'Rien de cette catégorie dans le compendium.',
    toolTp: 'Case de TP', tpGroup: 'Groupe', tpNewGroup: '+ nouveau groupe', tpLinked: 'Liée au groupe', tpHint: 'Un token posé ici apparaît en fantôme sur les autres cases du groupe ; le joueur peut prendre le fantôme pour continuer de l’autre côté.',
    okBtn: 'OK', damage: 'Dégâts', tookDamage: 'a pris {n} dégâts',
    paneToDynamic: 'Replier automatiquement', paneToPinned: 'Garder ouvert', panels: 'Onglets', popOut: 'Détacher en fenêtre', dockBack: 'Remettre dans les onglets',
    floating: 'en fenêtre', allFloating: 'Tous les onglets sont en fenêtres.',
    toolTWall: 'Mur tangible', toolAntiLight: 'Anti-lumière', wallKind: 'Type de mur dessiné', wallBoth: 'Mur + tangible', wallTitle: 'Mur',
    isDoor: 'Porte', doorOpen: 'Ouverte', doorLocked: 'Verrouillée', doorLockedHint: 'Seul le MJ peut l’ouvrir ou la fermer.',
    blocksMove: 'Bloque le mouvement', blocksMoveHint: 'Les joueurs ne peuvent pas déplacer leur token au travers (le MJ si).', blocksSight: 'Bloque la vue et la lumière',
    sharedVision: 'Vision partagée', sharedVisionHint: 'Les joueurs voient aussi par les tokens des fiches qu’ils ne font que voir.',
    darkvision: 'Darkvision', darkvisionHint: 'Voit toute sa zone de vision sans lumière (en noir et blanc là où il fait noir).',
    exploreMemory: 'Mémoire d’exploration', exploreHint: 'Ce qu’un joueur a déjà vu reste assombri au lieu de redevenir noir (sans les tokens).',
    resetExplore: 'Réinitialiser l’exploration…', everyone: 'Tous les joueurs', confirmResetExplore: 'Effacer ce qui a été exploré sur cette scène ?',
    playersWin: 'La lumière des joueurs l’emporte', playersWinHint: 'Les lumières portées par les tokens des joueurs ne sont pas éteintes par cette zone.',
    // ROADMAP 3 (fr)
    shapeLine: "Ligne",
    wallTangible: "Tangible",
    wallTangibleHint: "Bloque le mouvement des joueurs (le MJ passe)",
    wallOpaque: "Opaque",
    wallOpaqueHint: "Bloque la vue ET la lumière",
    toolDoorHint: "Le segment est une porte (fermée : bloque tout ; ouverte : rien)",
    doorLineOnly: "Seule une ligne peut être une porte",
    revealRect: "Révéler : rectangle",
    revealLasso: "Révéler : lasso (main levée)",
    revealPoly: "Révéler : polygone (clic sur chaque coin)",
    selectWhat: "Sélectionner…",
    sel_tokens: "Tokens",
    sel_walls: "Murs",
    sel_doors: "Portes",
    sel_lights: "Lumières",
    sel_tps: "Cases de TP",
    sel_reveal: "Zones révélées",
    selectedCount: "{n} éléments sélectionnés",
    groupHint: "Glisse l'un d'eux pour tout déplacer. Suppr : tout supprimer, Ctrl+Z : annuler.",
    delKey: "Supprimer (Suppr)",
    fitMap: 'Ajuster la vue',
  },
  en: {
    name: 'Name', logout: 'Switch player',
    tables: 'Tables', chooseTable: 'Pick your table', noTables: 'No public table yet. Ask your GM for the link.',
    pickPlayer: 'Who are you?', taken: 'already playing', you: 'you', noSlots: 'The GM has not created any player at this table yet.', tableNotFound: 'There is no table at this address.',
    kicked: 'The GM disconnected you.', tableGone: 'This table was deleted.', allTables: 'All tables',
    gmHome: 'GM home', newTable: 'New table', tableName: 'Table name', tableAddress: 'Address', listed: 'Listed (shown on the home page)', unlisted: 'unlisted', listedShort: 'listed',
    openTable: 'Open', online: 'online', playersShort: 'players', confirmTable: 'Type the table address to delete it with everything in it:',
    devMode: 'Dev mode: ADMIN_SECRET is empty, so /admin is open to anyone who can reach the server. See the README.',
    addPlayer: 'Add a player', kick: 'Disconnect', playerLink: 'Link for players', copyLink: 'Copy', copied: 'Copied',
    perms: 'Player rights', permEdit: 'Edit', permView: 'View only', permNone: 'None', viewOnly: 'View only: you cannot change this sheet.',
    mapLibrary: 'Map library', mapHint: 'Maps prepared outside any table (walls, lights...). "Copy to" puts a copy into a table.',
    newMap: 'New map', editMap: 'Edit', copyTo: 'Copy to…', toLibrary: 'Copy to the library', fromLibrary: '+ from the library', copiedTo: 'Copied to',
    tableSettings: 'Table settings', mapName: 'Map name',
    chatHintGm: 'Message, /roll, or @Sheet to speak as… (Shift+Enter: new line)', narrator: 'narration (italics)', chatToDynamic: 'Fold away automatically', chatToPinned: 'Keep open',
    life: 'State', lifeAuto: 'Auto (sheet HP)', lifeDead: 'Force: dead', lifeAlive: 'Force: alive', lifeHint: 'Dead = black and white for everyone. Auto: dead at 0 HP or less.', close: 'Close', color: 'Colour', choose: 'Choose…',
    picture: 'Character picture', newPortrait: 'New portrait', cropToken: 'Frame the token', readyToken: 'Ready-made token', zoom: 'Zoom',
    cropHint: 'Drag to move, wheel or slider to zoom.',
    lockText: 'Save the description (locks it)', unlockText: 'Edit the description',
    talentActive: 'Ticked: applies to all your stat checks', talentsOn: 'Ticked talents, on stat checks', talentHint: 'Tick a talent to apply it to all your stat checks.', description: 'Description',
    compThis: 'This table', compGlobal: 'Global', npcs: 'NPCs', newItem: 'New item', newSpell: 'New spell', visibleToPlayers: 'Visible to players even without a sheet carrying it',
    autoHint: 'Created from a sheet: it follows the sheet until you edit it', staleCopy: 'The original (outside tables) changed since the copy', updateCopy: 'Update',
    compGmHint: 'Every item or spell named on a sheet lands here by itself. Players see what is on their sheets, plus what you tick 👁.',
    compPlayerHint: 'The items and spells of your sheets show here, plus whatever the GM shows you.', npcHint: 'Tick the sheets to list for players in the compendium (name and picture only).',
    shownToPlayers: 'Shown to players (NPC)', addToTable: 'Add to this table', inThisTable: 'in this table', outside: 'Outside tables',
    campaigns: 'Campaigns', campaign: 'Campaign', noCampaign: '— no campaign —', newCampaign: 'New campaign', linkedSystem: 'Linked system', noLinkedSystem: '— no linked system —',
    campaignHint: 'A campaign ties together tables of one story: what they create carries its name (global compendium filter), and its linked system is their starting rules.',
    systemsLib: 'System library', systemsHint: "A table's rules saved under a name (a table's System tab), to apply to other tables.",
    saveSystemAs: 'Save these rules…', updateSystem: 'Overwrite a saved system…', applySystem: 'Apply a saved system…', systemName: 'Name of the saved system',
    confirmOverwrite: "Replace this saved system with this table's rules?", diffTitle: 'Changes', noDiff: 'No difference with the current rules.',
    applyNow: 'Apply', cancel: 'Cancel', applyLinked: "This campaign has a linked system. Here is what would change in the table's rules:",
    opAdded: 'added', opRemoved: 'removed', opChanged: 'changed',
    chat: 'Chat', sheets: 'Sheets', table: 'Table', rules: 'Rules', system: 'System',
    chatHint: 'Message or /roll… (/gm for GM-only)', speakingAs: 'As', noChar: '— no character —',
    newChar: 'New character', back: 'Back', del: 'Delete', confirmDel: 'Delete for good?', placeToken: 'Place token',
    level: 'Level', cls: 'Class', element: 'Element', elemental: 'Elemental', owner: 'Player',
    hp: 'HP', temp: 'Temp', mp: 'Mana', fav: 'Favors', actions: 'Actions', defP: 'DP', defM: 'DM',
    base: 'Base', item: 'Items', passive: 'Passive', total: 'Total', points: 'Points', modifier: 'Roll modifier',
    talents: 'Talents', spells: 'Spells', items: 'Equipment', notes: 'Notes', currency: 'Currency', add: 'Add', cast: 'Cast', use: 'Use',
    armed: 'Armed', continuous: 'Continuous', equipped: 'Equipped', qty: 'Qty', bonuses: 'Bonuses (e.g. str+2 agi-1)', cost: 'Cost', effect: 'Effect', effectHint: 'Effect: **bold**, buttons [pdmg 2d30 | physical], [str +2|label]', tier: 'Tier',
    critSuccess: 'Critical success', success: 'Success', failure: 'Failure', critFailure: 'Critical failure',
    reroll: 'Reroll (favor)', apply: 'Apply', noTarget: 'Select a token on the map first.', applied: 'Applied', undoApply: 'Undo this application',
    scenes: 'Scenes', newScene: 'New scene', mapImage: 'Map image', activate: 'Show to players', active: 'Active', grid: 'Grid (px)', offset: 'Offset X / Y',
    addToken: 'Add token', tokenName: 'Token name', players: 'Players', gm: 'GM', player: 'Player',
    size: 'Size', hidden: 'Hidden', linked: 'Linked character', none: '— none —', tokenImage: 'Token image',
    derived: 'Derived values', quick: 'Quick rolls', rulesText: 'Rules text', rawJson: 'Raw JSON', validate: 'Test', save: 'Save', reset: 'Reset', export: 'Export', import: 'Import',
    formulaTest: 'Test a formula', saved: 'Saved', empty: 'Nothing here yet.', roll: 'Roll', rolling: 'Roll',
    invWeapons: 'Weapons', invArmor: 'Armor and gear', invConsumable: 'Consumables', invBag: 'Bags', invOther: 'Other items',
    equipSlots: 'Equipment slots', unequipped: 'Unequipped', slots: 'Slot', slotsExpr: 'Usable slots', noExpr: 'No expression: the item can only be carried ("Other").',
    slotChoices: 'choices', emptySlot: 'empty', noFit: 'No compatible item.', toggle: 'Details',
    toolRect: 'Rectangle', toolCircle: 'Circle', toolCurve: 'Curve', toolEdit: 'Edit', undo: 'Undo', snap: 'Snapping', snapGrid: 'Grid', snapHalf: 'Half cell', snapOff: 'Free',
    viewAs: 'View as', viewPlayers: 'All players', viewSelected: 'Selected token', sight: 'Shares its sight', sightHint: 'This token gives its sight to every player (ally, torch bearer...)',
    noViewers: 'No token provides sight, so the fog is total. Link a token to a player character, tick "Shares its sight", or choose "Selected token".',
    noViewersPlayer: 'None of your tokens is on this scene: the GM needs to link a token to your character.',
    portrait: 'Portrait', toComp: 'Save to compendium', fromComp: '+ compendium', journal: 'Journal', sound: 'Sound', compendium: 'Compendium',
    newEntry: 'New entry', edit: 'Edit', showPlayers: 'Show to players', visibility: 'Visible to', visGM: 'GM only', visAll: 'Everyone', visCustom: 'Chosen players',
    image: 'Image', body: 'Text', title: 'Title', play: 'Play', stop: 'Stop', stopAll: 'Stop all', loop: 'Loop', volume: 'Volume', uploadAudio: 'Add a sound',
    unlock: 'Enable sound', mute: 'Mute', toolSelect: 'Select', toolWall: 'Wall', toolDoor: 'Door', toolLight: 'Light', toolReveal: 'Reveal', toolErase: 'Erase',
    fog: 'Fog', dark: 'Darkness', playerView: 'Player view', radius: 'Radius', vision: 'Vision (cells, 0 = none)', light: 'Light (cells)',
    clearWalls: 'Clear walls', clearReveal: 'Clear revealed areas', clearLights: 'Clear lights', view: 'View', template: 'Save as template',
    instantiate: 'Create + token', statsEditor: 'Stats', aliases: 'Aliases (comma separated)', kind: 'Kind', dtype: 'Damage', tiers: 'Knowledge tiers',
    charRules: 'Character creation', baseStat: 'Starting stat', startPoints: 'Starting points', startMax: 'Starting max', spellStats: 'Spell rolls (armed / unarmed)',
    rollTypes: 'Roll types', idHint: 'Changing an id resets that stat on existing sheets.', soundHint: 'Sounds start for every player at the same time.',
    noPlayersTokens: 'No player tokens: fog is total.',
    alias: '@ alias', aliasAuto: 'from the name', aliasHint: 'For narration: @alias in the chat (no spaces, unique in the table, seen by the GM only). Empty: follows the name.',
    search: 'Search', newOne: 'New', fromCompendium: 'From the compendium', noMatch: 'No match.', compEmpty: 'Nothing of this category in the compendium.',
    toolTp: 'TP cell', tpGroup: 'Group', tpNewGroup: '+ new group', tpLinked: 'Linked group', tpHint: 'A token standing here shows as a ghost on the other cells of the group; the player can pick up the ghost to go on from there.',
    okBtn: 'OK', damage: 'Damage', tookDamage: 'took {n} damage',
    paneToDynamic: 'Fold away automatically', paneToPinned: 'Keep open', panels: 'Tabs', popOut: 'Pop out into a window', dockBack: 'Put back in the tabs',
    floating: 'in a window', allFloating: 'Every tab is in a window.',
    toolTWall: 'Tangible wall', toolAntiLight: 'Anti-light', wallKind: 'Kind of wall drawn', wallBoth: 'Wall + tangible', wallTitle: 'Wall',
    isDoor: 'Door', doorOpen: 'Open', doorLocked: 'Locked', doorLockedHint: 'Only the GM can open or close it.',
    blocksMove: 'Blocks movement', blocksMoveHint: 'Players cannot move their token through it (the GM can).', blocksSight: 'Blocks sight and light',
    sharedVision: 'Shared vision', sharedVisionHint: 'Players also see through the tokens of sheets they can only view.',
    darkvision: 'Darkvision', darkvisionHint: 'Sees its whole vision zone without light (in black and white where it is dark).',
    exploreMemory: 'Exploration memory', exploreHint: 'What a player has already seen stays dimmed instead of going black again (without tokens).',
    resetExplore: 'Reset exploration…', everyone: 'All players', confirmResetExplore: 'Erase what was explored on this scene?',
    playersWin: "Players' light wins", playersWinHint: "Lights carried by players' tokens are not put out by this area.",
    // ROADMAP 3 (en)
    shapeLine: "Line",
    wallTangible: "Tangible",
    wallTangibleHint: "Blocks players' movement (the GM goes through)",
    wallOpaque: "Opaque",
    wallOpaqueHint: "Blocks sight AND light",
    toolDoorHint: "The segment is a door (closed: blocks everything; open: nothing)",
    doorLineOnly: "Only a line can be a door",
    revealRect: "Reveal: rectangle",
    revealLasso: "Reveal: lasso (free hand)",
    revealPoly: "Reveal: polygon (click each corner)",
    selectWhat: "Select…",
    sel_tokens: "Tokens",
    sel_walls: "Walls",
    sel_doors: "Doors",
    sel_lights: "Lights",
    sel_tps: "TP cells",
    sel_reveal: "Revealed areas",
    selectedCount: "{n} things selected",
    groupHint: "Drag one of them to move them all. Delete: delete them all, Ctrl+Z: undo.",
    delKey: "Delete (Del)",
    fitMap: 'Fit to view',
  },
};
// Browser storage can be missing or throw (private window, blocked site data, and Node for the tests): reads fall back.
const stored = (k) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } };
let lang = stored('lang') || (globalThis.navigator?.language || 'fr').slice(0, 2);
if (!DICT[lang]) lang = 'en';
export { DICT };
export const getLang = () => lang;
export const setLang = (l) => { lang = l; try { localStorage.setItem('lang', l); } catch { /* not kept */ } };
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
