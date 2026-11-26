// Sheet lists (ROADMAP 3 §2.6). Pure (no DOM): the page and the tests share it.

/** A player character: at least one player slot has the edit right on the sheet (same rule as the server's "player's token"). */
export const isPC = (actor) => Object.values(actor?.perms ?? {}).includes('edit');
/** The GM's sheet list in two automatic sections: player characters, then the others (NPCs). Each by name. */
export function splitSheets(actors) {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  const list = [...(actors ?? [])].sort(byName);
  return { pcs: list.filter(isPC), npcs: list.filter((a) => !isPC(a)) };
}
