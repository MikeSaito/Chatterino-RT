/** One-shot flips for knobs whose catalog default used to be false and got persisted. */

type StaleOffMigration = {
  key: string;
  marker: string;
};

const STALE_OFF_TO_ON: StaleOffMigration[] = [
  { key: "ui.showSendButton", marker: "ui.sendButtonDefaultOn" },
  { key: "appearance.showReplyButton", marker: "appearance.replyButtonDefaultOn" },
];

/** @deprecated use MARKERS via migrateStaleFalseDefaults */
export const SEND_BUTTON_DEFAULT_ON_MARKER = "ui.sendButtonDefaultOn";

export const REPLY_BUTTON_DEFAULT_ON_MARKER = "appearance.replyButtonDefaultOn";

/**
 * Former catalog defaults were false and got written on Settings save.
 * Flip once to true; intentional uncheck after the marker stays false.
 */
export function migrateStaleFalseDefaults(
  knobs: Record<string, boolean | string | number | null>,
): { knobs: Record<string, boolean | string | number | null>; migrated: boolean } {
  const next = { ...knobs };
  let migrated = false;
  for (const { key, marker } of STALE_OFF_TO_ON) {
    if (next[key] === false && next[marker] !== 1) {
      next[key] = true;
      next[marker] = 1;
      migrated = true;
    }
  }
  return { knobs: next, migrated };
}

/** @deprecated alias for migrateStaleFalseDefaults */
export function migrateSendButtonDefault(
  knobs: Record<string, boolean | string | number | null>,
): { knobs: Record<string, boolean | string | number | null>; migrated: boolean } {
  return migrateStaleFalseDefaults(knobs);
}
