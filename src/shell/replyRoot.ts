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

/** Все сообщения ветки от root (DFS, порядок: root → replies). */
export function collectReplyThread<T extends ReplyMessage>(
  events: T[],
  seedId: string,
): T[] {
  const byId = new Map(events.map((ev) => [ev.id, ev]));
  const rootId = resolveReplyRoot(events, seedId)?.id ?? seedId;
  const out: T[] = [];
  const walk = (id: string): void => {
    const node = byId.get(id);
    if (!node) {
      return;
    }
    out.push(node);
    for (const ev of events) {
      if (ev.replyToId === id) {
        walk(ev.id);
      }
    }
  };
  walk(rootId);
  return out;
}

/** Privmsg принадлежит ветке, если цепочка replyToId ведёт к rootId. */
export function isInReplyThread(
  events: ReplyMessage[],
  rootId: string,
  msgId: string,
): boolean {
  if (msgId === rootId) {
    return true;
  }
  const byId = new Map(events.map((ev) => [ev.id, ev]));
  let id = msgId;
  const seen = new Set<string>();
  while (byId.has(id) && !seen.has(id)) {
    seen.add(id);
    if (id === rootId) {
      return true;
    }
    const node = byId.get(id);
    if (!node?.replyToId) {
      return false;
    }
    id = node.replyToId;
  }
  return id === rootId;
}
