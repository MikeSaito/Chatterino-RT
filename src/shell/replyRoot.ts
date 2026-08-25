export type ReplyMessage = {
  id: string;
  login: string;
  text: string;
  replyToId?: string;
};

/** Корень reply-ветки по scrollback (если родитель обрезан — самый ранний известный узел). */
export function resolveReplyRoot(
  events: ReplyMessage[],
  seedId: string,
): ReplyMessage | null {
  const byId = new Map(events.map((ev) => [ev.id, ev]));
  let rootId = seedId;
  const seen = new Set<string>();
  while (byId.has(rootId) && !seen.has(rootId)) {
    seen.add(rootId);
    const node = byId.get(rootId);
    if (!node?.replyToId || !byId.has(node.replyToId)) {
      break;
    }
    rootId = node.replyToId;
  }
  return byId.get(rootId) ?? null;
}
