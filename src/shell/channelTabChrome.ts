/** Pure helpers for channel tab live/avatar chrome (no DOM). */

export function tabAvatarLetter(login: string): string {
  const key = login.trim().toLowerCase();
  return key ? key.slice(0, 1).toUpperCase() : "";
}

export function normalizeTabLive(live: boolean | null | undefined): boolean {
  return live === true;
}

/** Stock `showTabLive`: live chrome only when the channel is live and the knob is on. */
export function tabLiveVisible(
  live: boolean | null | undefined,
  showTabLive: boolean,
): boolean {
  return normalizeTabLive(live) && showTabLive === true;
}
