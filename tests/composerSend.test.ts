import assert from "node:assert/strict";
import { submitComposerDraft, type ComposerDraft } from "../src/shell/composerSend.ts";

async function scenario(change?: (draft: ComposerDraft) => ComposerDraft, fail = false) {
  let draft: ComposerDraft = { text: "first", channel: "alpha", replyToId: "parent", revision: 0 };
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let sent: ComposerDraft | undefined;
  let clears = 0;
  const operation = submitComposerDraft({
    read: () => ({ ...draft }),
    send: async (snapshot) => {
      sent = snapshot;
      await pending;
      if (fail) throw new Error("send rejected");
    },
    clear: () => { clears += 1; draft.text = ""; draft.replyToId = null; },
  });
  if (change) draft = change(draft);
  const expected = { ...draft };
  release();
  if (fail) {
    await assert.rejects(operation, /send rejected/);
  } else {
    assert.equal(await operation, !change);
  }
  assert.equal(clears, !change && !fail ? 1 : 0);
  assert.equal(sent?.channel, "alpha", "send retains the channel selected at submit");
  assert.equal(sent?.replyToId, "parent");
  if (fail) assert.deepEqual(draft, expected, "rejected sends retain text and reply");
}

await scenario();
await scenario((draft) => ({ ...draft, text: "second", revision: 1 }));
await scenario((draft) => ({ ...draft, channel: "beta", revision: 1 }));
await scenario((draft) => ({ ...draft, replyToId: "another" }));
await scenario((draft) => ({ ...draft, revision: 2 }), false); // edit then restore same text
await scenario(undefined, true);
await scenario((draft) => ({ ...draft, text: "new draft", revision: 1 }), true);
console.log("composerSend tests ok");
