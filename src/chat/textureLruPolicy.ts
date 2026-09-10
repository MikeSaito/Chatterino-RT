/** Oldest unpinned keys to remove to reach maxSize. */
export function lruVictimsToSize(
  keys: Iterable<string>,
  isPinned: (key: string) => boolean,
  maxSize: number,
): string[] {
  const remaining = [...keys];
  const victims: string[] = [];
  const target = Math.max(0, Math.floor(maxSize));
  while (remaining.length > target) {
    const index = remaining.findIndex((key) => !isPinned(key));
    if (index < 0) {
      break;
    }
    const [victim] = remaining.splice(index, 1);
    if (victim !== undefined) {
      victims.push(victim);
    }
  }
  return victims;
}
