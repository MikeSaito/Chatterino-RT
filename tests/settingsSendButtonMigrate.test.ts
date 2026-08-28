import {
  migrateSendButtonDefault,
  SEND_BUTTON_DEFAULT_ON_MARKER,
} from "../src/shell/settings/sendButtonMigrate.ts";
import { defaultKnobs } from "../src/shell/settings/catalog.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

{
  const { knobs, migrated } = migrateSendButtonDefault({
    "ui.showSendButton": false,
  });
  assert(migrated === true, "stale false migrates");
  assert(knobs["ui.showSendButton"] === true, "send on after migrate");
  assert(knobs[SEND_BUTTON_DEFAULT_ON_MARKER] === 1, "marker set");
}

{
  const { knobs, migrated } = migrateSendButtonDefault({
    "ui.showSendButton": false,
    [SEND_BUTTON_DEFAULT_ON_MARKER]: 1,
  });
  assert(migrated === false, "intentional false kept");
  assert(knobs["ui.showSendButton"] === false, "stays off after marker");
}

{
  const { knobs, migrated } = migrateSendButtonDefault({
    ...defaultKnobs(),
    "ui.showSendButton": false,
  });
  assert(migrated === true, "merge-shaped knobs migrate");
  assert(knobs["ui.showSendButton"] === true, "defaultKnobs path on");
  assert(knobs[SEND_BUTTON_DEFAULT_ON_MARKER] === 1, "defaultKnobs marker");
}

{
  const { migrated } = migrateSendButtonDefault({
    "ui.showSendButton": true,
  });
  assert(migrated === false, "already true no-op");
}

console.log("settingsSendButtonMigrate.test.ts ok");
