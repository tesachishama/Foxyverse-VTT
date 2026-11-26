// The GM's map tools: id, icon (public/icons/<icon>.svg, square placeholders the user can replace under the same name) and the
// DICT key of its name (shown as a tooltip). Pure (no DOM): the page and the tests share it.

export const TOOLS = [
  { id: 'select', icon: 'tool_select', label: 'toolSelect' },
  { id: 'wall', icon: 'tool_wall', label: 'toolWall' },
  { id: 'twall', icon: 'tool_line', label: 'toolTWall' },
  { id: 'rect', icon: 'tool_rect', label: 'toolRect' },
  { id: 'circle', icon: 'tool_circle', label: 'toolCircle' },
  { id: 'curve', icon: 'tool_curve', label: 'toolCurve' },
  { id: 'door', icon: 'tool_door', label: 'toolDoor' },
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
/** The reveal tool's three ways of drawing an area. */
export const REVEAL_MODES = [
  { id: 'rect', icon: 'tool_reveal_rect', label: 'revealRect' },
  { id: 'lasso', icon: 'tool_reveal_lasso', label: 'revealLasso' },
  { id: 'poly', icon: 'tool_reveal_poly', label: 'revealPoly' },
];
export const iconUrl = (name) => `/icons/${name}.svg`;
