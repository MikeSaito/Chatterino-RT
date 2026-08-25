import type { ChatEvent } from "../chat/types";

/** Событие scrollback по msgId слота (parity с ring.ts msgId assignment). */
export function findEventByMsgId(
  events: ChatEvent[],
  msgId: string,
): ChatEvent | null {
  const needle = msgId.trim();
  if (!needle) {
    return null;
  }
  for (const ev of events) {
    if (ev.kind === "privmsg" && ev.id === needle) {
      return ev;
    }
    if (
      ev.kind === "usernotice" &&
      ev.privmsg?.kind === "privmsg" &&
      ev.privmsg.id === needle
    ) {
      return ev;
    }
    if (ev.id === needle) {
      return ev;
    }
  }
  return null;
}
