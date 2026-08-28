export interface SessionSelection {
  ids: ReadonlySet<string>;
  anchor: string | null;
  shiftRange: ReadonlySet<string>;
}

export function emptySelection(): SessionSelection {
  return { ids: new Set(), anchor: null, shiftRange: new Set() };
}

export function selectionClick(
  state: SessionSelection,
  order: readonly string[],
  id: string,
  mods: { shift: boolean; toggle: boolean },
): SessionSelection {
  if (mods.shift) {
    const anchor = state.anchor ?? id;
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    const shiftRange = new Set(a === -1 || b === -1 ? [id] : order.slice(Math.min(a, b), Math.max(a, b) + 1));
    const ids = new Set(state.ids);
    for (const rangeId of state.shiftRange) ids.delete(rangeId);
    for (const rangeId of shiftRange) ids.add(rangeId);
    return { ids, anchor, shiftRange };
  }
  if (mods.toggle) {
    const ids = new Set(state.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { ids, anchor: id, shiftRange: new Set() };
  }
  return { ids: new Set(), anchor: id, shiftRange: new Set() };
}

export function pruneSelection(state: SessionSelection, visible: ReadonlySet<string>): SessionSelection {
  if ([...state.ids].every((id) => visible.has(id))) return state;
  const ids = new Set([...state.ids].filter((id) => visible.has(id)));
  const shiftRange = new Set([...state.shiftRange].filter((id) => visible.has(id)));
  return { ids, anchor: state.anchor, shiftRange };
}
