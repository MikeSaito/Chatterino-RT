/**
 * Channel binding for moderation actions (gutter / timeout popup / UserCard).
 * Snapshot at click/open time; never rely on hub.active at async send time.
 */

/** Normalize a channel login for mod send / compare. */
export function snapshotModChannel(raw: string): string {
  return raw.trim().replace(/^#/, "").toLowerCase();
}

/**
 * UserCard mod row stays enabled only while the active tab still matches the
 * channel the card was opened on (P1). Actions themselves use openChannel.
 */
export function userCardModChannelMatches(
  openChannel: string,
  activeChannel: string,
): boolean {
  const open = snapshotModChannel(openChannel);
  const active = snapshotModChannel(activeChannel);
  return Boolean(open) && open === active;
}
