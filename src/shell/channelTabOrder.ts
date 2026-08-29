/** Pure open-tab reorder (kept free of DOM so node tests can import it). */
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
