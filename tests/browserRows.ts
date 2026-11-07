import type { MessageRing } from "../src/chat/ring";
import type { MessageRow } from "../src/chat/messageRow";
import type { MessageRowView } from "../src/chat/messageRowView";
import type { ViewPool } from "../src/chat/viewPool";

export function historyRows(ring: MessageRing): readonly MessageRow[] {
  return (ring as unknown as { slots: MessageRow[] }).slots;
}

export function rowView(ring: MessageRing, row: MessageRow | undefined): MessageRowView | undefined {
  if (!row) return undefined;
  return (ring as unknown as { viewPool: ViewPool<MessageRow, MessageRowView> }).viewPool.get(row);
}

export function rowViews(ring: MessageRing): ReadonlySet<MessageRowView> {
  return (ring as unknown as { viewPool: ViewPool<MessageRow, MessageRowView> }).viewPool.views;
}

export function requireRowView(ring: MessageRing, row: MessageRow | undefined): MessageRowView {
  const view = rowView(ring, row);
  if (!view) throw new Error(`Message has no bound view: ${row?.msgId}`);
  return view;
}
