/** Pure helpers for channel tab live/avatar chrome (no DOM). */

export function tabAvatarLetter(login: string): string {
  const key = login.trim().toLowerCase();
  return key ? key.slice(0, 1).toUpperCase() : "";
}

export function normalizeTabLive(live: boolean | null | undefined): boolean {
  return live === true;
}
