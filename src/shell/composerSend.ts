export type ComposerDraft = {
  text: string;
  channel: string;
  replyToId: string | null;
  revision: number;
};

/** Clear only the draft that was accepted, never edits made while awaiting IPC. */
export async function submitComposerDraft(opts: {
  read: () => ComposerDraft;
  send: (draft: ComposerDraft) => Promise<unknown>;
  clear: () => void;
}): Promise<boolean> {
  const sent = opts.read();
  await opts.send(sent);
  const current = opts.read();
  if (
    current.revision !== sent.revision ||
    current.text !== sent.text ||
    current.channel !== sent.channel ||
    current.replyToId !== sent.replyToId
  ) {
    return false;
  }
  opts.clear();
  return true;
}
