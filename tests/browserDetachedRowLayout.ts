import { createMessageRow, type MessageRow } from "../src/chat/messageRow";
import type { MessageRing } from "../src/chat/ring";

export function checkDetachedRowLayout(ring: MessageRing) {
  const owner = ring as unknown as {
    measureSlot: (row: MessageRow) => void;
    lineHeight: number;
    app: { stage: { children: unknown[] } };
    textures: { diagnostics: () => unknown };
  };
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const children = owner.app.stage.children.length;
  const textures = JSON.stringify(owner.textures.diagnostics());
  const row = createMessageRow();
  row.msgId = "detached-measurement";
  row.bodyRaw = "Short message";
  row.nickRaw = "Viewer";
  row.useNickStyle = true;
  owner.measureSlot(row);
  check(row.lineCount === 1 && row.wrapLines.length === 1 && row.wrapLines[0].end === row.bodyRaw.length, "plain data can measure a complete single-line message");
  row.replyToLogin = "other";
  owner.measureSlot(row);
  check(row.replyRows === 1 && row.lineCount === 2 && row.bodyY === owner.lineHeight, "reply context reserves one row without a display object");
  row.bodyRaw = "Long message. ".repeat(200);
  owner.measureSlot(row);
  check(row.wrapLines.length > 1 && row.lineCount > 2, "offscreen data retains exact multiline height");
  row.replyToLogin = "";
  row.system = true;
  row.useNickStyle = false;
  row.bodyRaw = "System message";
  owner.measureSlot(row);
  check(row.systemCloudBounds && row.replyRows === 0 && row.bodyY > 0, "system cloud dimensions can be computed without graphics");
  check(owner.app.stage.children.length === children, "measurement does not allocate a message view");
  check(JSON.stringify(owner.textures.diagnostics()) === textures, "measurement does not acquire or load media");
}
