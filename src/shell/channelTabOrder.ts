/** Pure open-tab reorder helpers (no DOM — safe for node tests). */

export function moveOpenTab(
  open: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] | null {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= open.length ||
    toIndex >= open.length ||
    fromIndex === toIndex
  ) {
    return null;
  }
  const next = [...open];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) {
    return null;
  }
  next.splice(toIndex, 0, item);
  return next;
}

/**
 * Absolute drag preview from the order frozen at gesture arm.
 * Always derives from `startOpen` + `startIndex` (not incremental live swaps),
 * so a pointer over a far slot lands at that index in one step.
 */
export function orderAtDragTarget(
  startOpen: readonly string[],
  startIndex: number,
  toIndex: number,
): string[] | null {
  if (
    startIndex < 0 ||
    toIndex < 0 ||
    startIndex >= startOpen.length ||
    toIndex >= startOpen.length
  ) {
    return null;
  }
  if (toIndex === startIndex) {
    return [...startOpen];
  }
  return moveOpenTab(startOpen, startIndex, toIndex);
}

export type TabLayoutBox = { left: number; width: number };

/**
 * Slot index for content X: first tab whose horizontal midpoint is to the right
 * of `x` (content coordinates: scrollLeft + clientX - listLeft).
 * Used against geometry frozen at drag-arm so live DOM shifts cannot pin the
 * dragged tab to a neighbor-only swap.
 */
export function indexAtContentX(
  tabs: readonly TabLayoutBox[],
  x: number,
): number {
  if (tabs.length === 0) {
    return -1;
  }
  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    if (!tab || tab.width <= 0) {
      continue;
    }
    const mid = tab.left + tab.width / 2;
    if (x < mid) {
      return i;
    }
  }
  return tabs.length - 1;
}
