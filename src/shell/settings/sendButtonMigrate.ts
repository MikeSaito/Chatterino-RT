/** Marker: stale catalog default `ui.showSendButton: false` already migrated. */
export const SEND_BUTTON_DEFAULT_ON_MARKER = "ui.sendButtonDefaultOn";

/**
 * Former catalog default was false and got persisted on Settings save.
 * Flip once to true; intentional uncheck after the marker stays false.
 */
export function migrateSendButtonDefault(
  knobs: Record<string, boolean | string | number | null>,
): { knobs: Record<string, boolean | string | number | null>; migrated: boolean } {
  const next = { ...knobs };
  if (
    next["ui.showSendButton"] === false &&
    next[SEND_BUTTON_DEFAULT_ON_MARKER] !== 1
  ) {
    next["ui.showSendButton"] = true;
    next[SEND_BUTTON_DEFAULT_ON_MARKER] = 1;
    return { knobs: next, migrated: true };
  }
  return { knobs: next, migrated: false };
}
