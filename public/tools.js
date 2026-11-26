// The GM's map tools: id, icon (public/icons/<icon>.svg, square placeholders the user can replace under the same name) and the
// DICT key of its name (shown as a tooltip). Pure (no DOM): the page and the tests share it.

export const TOOLS = [
  { id: 'select', icon: 'tool_select', label: 'toolSelect' },
  { id: 'wall', icon: 'tool_wall', label: 'toolWall' },
  { id: 'edit', icon: 'tool_edit', label: 'toolEdit' },
  { id: 'light', icon: 'tool_light', label: 'toolLight' },
  { id: 'antilight', icon: 'tool_antilight', label: 'toolAntiLight' },
  { id: 'tp', icon: 'tool_tp', label: 'toolTp' },
  { id: 'reveal', icon: 'tool_reveal', label: 'toolReveal' },
  { id: 'erase', icon: 'tool_erase', label: 'toolErase' },
];
/** Buttons next to the tools that are not tools themselves. */
export const TOOL_BUTTONS = [
  { id: 'undo', icon: 'tool_undo', label: 'undo' },
  { id: 'fit', icon: 'tool_fit', label: 'fitMap' },
];
/** The wall tool's shapes (its sub-menu); the boxes tangible / opaque / door go with them. */
export const WALL_SHAPES = [
  { id: 'line', icon: 'tool_line', label: 'shapeLine' },
  { id: 'curve', icon: 'tool_curve', label: 'toolCurve' },
  { id: 'rect', icon: 'tool_rect', label: 'toolRect' },
  { id: 'circle', icon: 'tool_circle', label: 'toolCircle' },
];
export const WALL_FLAGS = [
  { id: 'move', icon: 'tool_tangible', label: 'wallTangible' },
  { id: 'sight', icon: 'tool_opaque', label: 'wallOpaque' },
  { id: 'door', icon: 'tool_door', label: 'toolDoor' },
];
/** The boxes of the wall tool as a new wall's properties: a door blocks everything while closed; only a line can be a door. */
export function wallToolFlags(shape, flags) {
  const door = shape === 'line' && !!flags?.door;
  return { door, move: door || !!flags?.move, sight: door || flags?.sight !== false };
}
/** The reveal tool's three ways of drawing an area. */
export const REVEAL_MODES = [
  { id: 'rect', icon: 'tool_reveal_rect', label: 'revealRect' },
  { id: 'lasso', icon: 'tool_reveal_lasso', label: 'revealLasso' },
  { id: 'poly', icon: 'tool_reveal_poly', label: 'revealPoly' },
];
export const iconUrl = (name) => `/icons/${name}.svg`;
