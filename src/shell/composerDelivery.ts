import type { Workspace, ChannelDraft } from "./workspace";
import type { SendStatus } from "./sendStatus";

/** Completes a send against its original draft, even if the active tab changes. */
export async function completeComposerSend(channel: string, draft: ChannelDraft, deps: {
  status: SendStatus;
  workspace: Workspace;
  alive: () => boolean;
  isClosed: (channel: string) => boolean;
  activeChannel: () => string;
  saveDraft: () => void;
  acceptedActive: () => void;
  paintStatus: () => void;
  syncComposer: () => void;
}): Promise<void> {
  const result = await deps.status.submit(channel, draft);
  if (!deps.alive()) return;
  deps.saveDraft();
  if (result && !deps.isClosed(channel) && deps.workspace.clearAccepted(channel, draft) && channel === deps.activeChannel()) {
    deps.acceptedActive();
  }
  deps.workspace.flush();
  deps.paintStatus();
  if (deps.isClosed(channel)) deps.status.forget(channel);
  deps.syncComposer();
}
