import {
  migrateStaleFalseDefaults,
  SEND_BUTTON_DEFAULT_ON_MARKER,
  REPLY_BUTTON_DEFAULT_ON_MARKER,
} from "../src/shell/settings/sendButtonMigrate.ts";
import { defaultKnobs } from "../src/shell/settings/catalog.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

{
  const { knobs, migrated } = migrateStaleFalseDefaults({
    "ui.showSendButton": false,
  });
  assert(migrated === true, "stale send migrates");
  assert(knobs["ui.showSendButton"] === true, "send on after migrate");
  assert(knobs[SEND_BUTTON_DEFAULT_ON_MARKER] === 1, "send marker set");
}

{
  const { knobs, migrated } = migrateStaleFalseDefaults({
    "appearance.showReplyButton": false,
  });
  assert(migrated === true, "stale reply migrates");
  assert(knobs["appearance.showReplyButton"] === true, "reply on after migrate");
  assert(knobs[REPLY_BUTTON_DEFAULT_ON_MARKER] === 1, "reply marker set");
}

{
  const { knobs, migrated } = migrateStaleFalseDefaults({
    "ui.showSendButton": false,
    [SEND_BUTTON_DEFAULT_ON_MARKER]: 1,
    "appearance.showReplyButton": false,
    [REPLY_BUTTON_DEFAULT_ON_MARKER]: 1,
  });
  assert(migrated === false, "intentional false kept");
  assert(knobs["ui.showSendButton"] === false, "send stays off");
  assert(knobs["appearance.showReplyButton"] === false, "reply stays off");
}

{
  const { knobs, migrated } = migrateStaleFalseDefaults({
    ...defaultKnobs(),
    "ui.showSendButton": false,
    "appearance.showReplyButton": false,
  });
  assert(migrated === true, "both migrate");
  assert(knobs["ui.showSendButton"] === true, "send on");
  assert(knobs["appearance.showReplyButton"] === true, "reply on");
}

{
  const { migrated } = migrateStaleFalseDefaults({
    "ui.showSendButton": true,
    "appearance.showReplyButton": true,
  });
  assert(migrated === false, "already true no-op");
}

console.log("settingsSendButtonMigrate.test.ts ok");
