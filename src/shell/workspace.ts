import type { ScrollAnchor } from "../chat/scroll";

export type ReplyDraft = { id: string; login: string; text: string };
export type ChannelDraft = { text: string; reply: ReplyDraft | null; start: number; end: number; revision: number };
export type WorkspaceScroll = { atBottom: boolean; anchor?: ScrollAnchor; rowsFromBottom: number };
type ChannelWorkspace = { draft: ChannelDraft; scroll?: WorkspaceScroll };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
export const WORKSPACE_KEY = "crt-workspace-v1";
const empty = (): ChannelDraft => ({ text: "", reply: null, start: 0, end: 0, revision: 0 });
const channelKey = (channel: string): string => channel.trim().replace(/^#/, "").toLowerCase();
const validChannel = (channel: string): boolean => /^[a-z0-9_]{1,25}$/.test(channel);
const finite = (n: unknown, max: number): number => typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;

/** Bounded, versioned local workspace. Disk failures never discard live drafts. */
export class Workspace {
  private channels = new Map<string, ChannelWorkspace>();
  private storage: StorageLike;
  private schedule: (fn: () => void) => number;
  private cancel: (id: number) => void;
  private timer: number | undefined;
  private dirty = false;
  onError?: () => void;

  constructor(storage: StorageLike, schedule = (fn: () => void) => window.setTimeout(fn, 250), cancel = (id: number) => window.clearTimeout(id)) {
    this.storage = storage;
    this.schedule = schedule;
    this.cancel = cancel;
    try {
      const raw = storage.getItem(WORKSPACE_KEY);
      if (!raw || raw.length > 2_000_000) return;
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.channels)) return;
      for (const row of data.channels.slice(-20)) {
        if (!row || typeof row.channel !== "string" || !validChannel(row.channel) || typeof row.draft?.text !== "string") continue;
        const text = row.draft.text.slice(0, 20_000);
        const r = row.draft.reply;
        const reply = r && typeof r.id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(r.id) && typeof r.login === "string" && typeof r.text === "string"
          ? { id: r.id, login: r.login.slice(0, 100), text: r.text.slice(0, 2000) } : null;
        const draft = { text, reply, start: finite(row.draft.start, text.length), end: finite(row.draft.end, text.length), revision: 0 };
        const s = row.scroll;
        const scroll: WorkspaceScroll | undefined = s && typeof s.atBottom === "boolean" ? {
          atBottom: s.atBottom, rowsFromBottom: finite(s.rowsFromBottom, 1_000_000),
          anchor: s.anchor && typeof s.anchor.msgId === "string" && s.anchor.msgId.length <= 200
            ? { msgId: s.anchor.msgId, offsetFrac: finite(s.anchor.offsetFrac, 1) } : undefined,
        } : undefined;
        this.channels.set(row.channel, { draft, scroll });
      }
    } catch { /* A corrupt/missing workspace starts empty. */ }
  }

  draft(channel: string): ChannelDraft {
    const d = this.channels.get(channelKey(channel))?.draft ?? empty();
    return { ...d, reply: d.reply ? { ...d.reply } : null };
  }

  putDraft(channel: string, value: Omit<ChannelDraft, "revision">): ChannelDraft {
    const key = channelKey(channel);
    if (!validChannel(key)) return empty();
    const previous = this.draft(key);
    const changed = previous.text !== value.text || JSON.stringify(previous.reply) !== JSON.stringify(value.reply);
    const draft = { ...value, reply: value.reply ? { ...value.reply } : null, revision: previous.revision + Number(changed) };
    this.put(key, { ...this.channels.get(key), draft });
    return this.draft(key);
  }

  clearAccepted(channel: string, sent: ChannelDraft): boolean {
    const current = this.draft(channel);
    if (current.revision !== sent.revision || current.text !== sent.text || JSON.stringify(current.reply) !== JSON.stringify(sent.reply)) return false;
    this.putDraft(channel, empty());
    return true;
  }

  scroll(channel: string): WorkspaceScroll | undefined {
    const scroll = this.channels.get(channelKey(channel))?.scroll;
    return scroll ? { ...scroll, anchor: scroll.anchor ? { ...scroll.anchor } : undefined } : undefined;
  }

  putScroll(channel: string, scroll: WorkspaceScroll): void {
    const key = channelKey(channel);
    if (!validChannel(key)) return;
    this.put(key, { draft: this.draft(key), scroll: { ...scroll, anchor: scroll.anchor ? { ...scroll.anchor } : undefined } });
  }

  retain(open: string[]): void {
    const keep = new Set(open.map(channelKey));
    for (const key of this.channels.keys()) if (!keep.has(key)) this.channels.delete(key);
    this.changed();
  }

  private put(key: string, value: ChannelWorkspace): void {
    this.channels.delete(key);
    this.channels.set(key, value);
    while (this.channels.size > 20) this.channels.delete(this.channels.keys().next().value!);
    this.changed();
  }

  private changed(): void {
    this.dirty = true;
    if (this.timer === undefined) this.timer = this.schedule(() => { this.timer = undefined; this.flush(); });
  }

  flush(): void {
    if (this.timer !== undefined) { this.cancel(this.timer); this.timer = undefined; }
    if (!this.dirty) return;
    try {
      this.storage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 1, channels: [...this.channels].map(([channel, row]) => ({ channel, ...row })) }));
      this.dirty = false;
    } catch { this.onError?.(); }
  }
}
