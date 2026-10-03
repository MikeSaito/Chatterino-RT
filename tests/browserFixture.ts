import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Channel } from "@tauri-apps/api/core";
import { encode } from "@msgpack/msgpack";
import type { ChatEvent } from "../src/chat/types";
import type { MessageRing, SlotContext } from "../src/chat/ring";
import type { ChatPerformance } from "../src/chat/performance";
import type { SendResult } from "../src/shell/sendStatus";

const fixtureWindow = window as Window & {
  __crt?: { ring: MessageRing; performance: ChatPerformance };
  __fixture?: { ready: () => boolean; smoke: () => Promise<string[]>; load: (rate: number, seconds: number, scroll: boolean) => Promise<unknown> };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function until(test: () => boolean) {
  const deadline = performance.now() + 15_000;
  while (!test()) { if (performance.now() > deadline) throw new Error(`UI timeout: ${document.querySelector("#status-text")?.textContent}`); await sleep(20); }
}
const session = JSON.parse(localStorage.getItem("fixture-session") ?? '{"open":["alpha","beta"],"lastChannel":"alpha","recents":["alpha","beta"]}');
const saveSession = () => localStorage.setItem("fixture-session", JSON.stringify(session));
let channelPipe: Channel<unknown> | undefined;
const sequences = new Map<string, number>();
const history = new Map<string, ChatEvent[]>();
let nextId = 0;
function message(channel: string, i: number): ChatEvent {
  return { kind: "privmsg", id: `${channel}-${i}`, timestampMs: Date.now(), userId: "1", login: `viewer${i % 20}`, displayName: `Viewer${i % 20}`, color: "#6699ff", badges: [], text: `Message ${i}: Поток сообщений, reply and scrolling. ${i % 7 === 0 ? "A longer line ".repeat(12) : "hello"}`, emoteSpans: [], action: false };
}
for (const channel of ["alpha", "beta"]) history.set(channel, Array.from({ length: 200 }, (_, i) => message(channel, i)));
const pendingSends: { channel: string; text: string; replyToId: string | null; resolve: (r: SendResult) => void; reject: (error: unknown) => void }[] = [];
mockWindows("main");
mockConvertFileSrc("windows");
const { emptySettings } = await import("../src/shell/settings/settingsApply");
const settings = emptySettings();
settings.knobs["appearance.uiLayout"] = "Classic";
settings.knobs["interface.language"] = "en";
settings.knobs["misc.showMessageLength"] = true;
mockIPC(async (cmd, args) => {
  const a = (args ?? {}) as Record<string, unknown>;
  if (cmd === "settings_get" || cmd === "settings_set") return settings;
  if (cmd === "filters_get") return { enableSelfHighlight: true, ignoreLogins: [], ignorePhrases: [], highlightPhrases: [], highlightLogins: [] };
  if (cmd === "auth_status") return { canSend: true, login: "fixture", fromEnv: false, scopesIncomplete: false };
  if (cmd === "session_get") return session;
  if (cmd === "chat_subscribe") { channelPipe = a.channel as Channel<unknown>; return 1; }
  if (cmd === "chat_join") {
    const channel = String(a.channel);
    if (!session.open.includes(channel)) session.open.push(channel);
    if (a.focus !== false) session.lastChannel = channel;
    saveSession();
    void emit("chat:rooms", { open: [...session.open], active: session.lastChannel });
    return channel;
  }
  if (cmd === "chat_leave") {
    session.open = session.open.filter((c: string) => c !== a.channel);
    if (session.lastChannel === a.channel) session.lastChannel = session.open[0] ?? "";
    saveSession();
    void emit("chat:rooms", { open: session.open, active: session.lastChannel, dropped: a.channel });
    return session.lastChannel || null;
  }
  if (cmd === "chat_snapshot") return { channelId: a.channel, seq: sequences.get(String(a.channel)) ?? 1, dropped: 0, events: history.get(String(a.channel)) ?? [] };
  if (cmd === "chat_send") return new Promise<SendResult>((resolve, reject) => pendingSends.push({ channel: String(a.channel), text: String(a.text), replyToId: a.replyToId as string | null, resolve, reject }));
  if (cmd === "chat_viewer_role") return { isMod: false, isBroadcaster: false };
  if (cmd === "chat_profile_image") return { login: a.login, url: null };
  if (cmd === "chat_blocked_users" || cmd === "chat_emote_icons" || cmd === "chat_complete" || cmd === "chat_emote_popup_list") return [];
  if (cmd === "cache_info") return { path: "", isCustom: false };
  if (cmd === "updater_status") return { ready: false, currentVersion: "1.1.6", reason: "fixture" };
  if (cmd === "about_info") return { version: "1.1.6", settingsDirectory: "fixture" };
  if (cmd.startsWith("plugin:window|")) return cmd.endsWith("is_maximized") ? false : null;
  if (cmd === "streamer_mode_detect" || cmd === "supports_incognito_links" || cmd === "chatterino1_commands_available") return false;
  return null;
}, { shouldMockEvents: true });

const html = new DOMParser().parseFromString(await (await fetch("/index.html")).text(), "text/html");
html.querySelectorAll("script").forEach((s) => s.remove());
document.head.innerHTML = html.head.innerHTML;
document.body.innerHTML = html.body.innerHTML;
localStorage.setItem("crt-debug", "1");
await import("../src/main");
window.dispatchEvent(new Event("DOMContentLoaded"));
const input = () => document.querySelector<HTMLTextAreaElement>("#composer-input")!;
const active = () => document.querySelector<HTMLInputElement>("#channel-input")!.value;
async function switchTo(channel: string) {
  const item = document.querySelector<HTMLButtonElement>(`[data-channel="${channel}"] .channel-item`);
  check(item, `missing tab ${channel}`); item.click();
  await until(() => active() === channel && !document.querySelector<HTMLButtonElement>("#join-submit")?.disabled);
  await sleep(50);
}
function type(text: string) { input().value = text; input().dispatchEvent(new Event("input", { bubbles: true })); }
function submit() { document.querySelector<HTMLFormElement>("#composer")!.requestSubmit(); }
function selectReply() {
  const ctx: SlotContext = { msgId: "alpha-4", channel: "alpha", login: "viewer4", authorLogin: "viewer4", nick: "Viewer4", text: "Reply target", fullText: "Viewer4: Reply target", clientX: 100, clientY: 100, disabled: false, replyToId: "", linkUrl: "", imageUrl: "", imageKind: "", imageProvider: "", inReplyThread: false, shiftOnly: false };
  (fixtureWindow.__crt!.ring as unknown as { onContext: (ctx: SlotContext) => void }).onContext(ctx);
  document.querySelector<HTMLButtonElement>('#chat-context [data-action="reply"]')!.click();
}
const state = () => document.querySelector<HTMLElement>("#send-status")!.dataset.state;

fixtureWindow.__fixture = {
  ready: () => active() === session.lastChannel && !input().disabled && Boolean(fixtureWindow.__crt?.ring.scrollSnapshot().contentRows),
  async smoke() {
    const checks: string[] = [];
    await switchTo("alpha");
    type("alpha original");
    selectReply();
    const ring = fixtureWindow.__crt!.ring;
    const selected = ring.workspaceScroll();
    ring.setDesired(25, false);
    await sleep(200);
    const reading = ring.workspaceScroll();
    check(reading.anchor && !reading.atBottom, "alpha reading anchor");
    await switchTo("beta"); type("beta draft");
    await switchTo("alpha");
    check(input().value === "alpha original", "alpha draft restored");
    check(!document.querySelector<HTMLElement>("#reply-bar")!.hidden && document.querySelector("#reply-label")!.textContent!.includes("viewer4"), "reply context restored");
    check(ring.workspaceScroll().anchor?.msgId === reading.anchor.msgId, "alpha reading position restored");
    checks.push("per-channel drafts and reading anchor");
    submit(); await until(() => pendingSends.length === 1);
    check(state() === "queued", "queued status");
    check(pendingSends[0].replyToId === "alpha-4", "send captures reply ID");
    await switchTo("beta");
    pendingSends[0].resolve({ status: "transmitted" }); await sleep(100);
    check(input().value === "beta draft", "late alpha completion preserves beta");
    await switchTo("alpha"); check(input().value === "", "accepted background alpha cleared");
    check(state() === "transmitted", "IRC transport status stays honest");
    checks.push("background completion clears only its accepted draft");
    type("sent text"); submit(); await until(() => pendingSends.length === 2);
    type("edited while waiting"); pendingSends[1].resolve({ status: "sent", messageId: "real-id" }); await sleep(100);
    check(input().value === "edited while waiting", "edited draft survives success");
    checks.push("in-flight edits survive");
    selectReply();
    submit(); await until(() => pendingSends.length === 3);
    pendingSends[2].reject({ code: "error.message.send_timeout" }); await until(() => state() === "error");
    type("new draft after failure");
    document.querySelector<HTMLButtonElement>("#send-retry")!.click(); await until(() => pendingSends.length === 4);
    check(pendingSends[3].text === "edited while waiting" && pendingSends[3].channel === "alpha", "retry retains failed original snapshot");
    check(pendingSends[3].replyToId === "alpha-4", "retry retains failed reply ID");
    pendingSends[3].resolve({ status: "sent" }); await sleep(100);
    check(input().value === "new draft after failure", "retry does not delete newer draft");
    checks.push("retry preserves original channel and newer edits");
    submit(); await until(() => pendingSends.length === 5);
    pendingSends[4].reject({ code: "error.message.send_unknown" }); await until(() => state() === "unknown");
    check(document.querySelector<HTMLButtonElement>("#send-retry")!.hidden, "uncertain write has no automatic retry button");
    checks.push("uncertain delivery does not invite duplicate retry");
    const closeBeta = document.querySelector<HTMLButtonElement>('[data-channel="beta"] .channel-leave')!;
    closeBeta.click(); await until(() => !document.querySelector('[data-channel="beta"]'));
    check(input().value === "new draft after failure", "closing inactive beta preserves alpha");
    checks.push("closing an inactive tab preserves active draft");
    ring.restoreWorkspaceScroll(reading, true);
    selectReply();
    input().dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("blur"));
    check(selected.atBottom, "initial follow");
    checks.push("workspace flushed before restart");
    return checks;
  },
  async load(rate, seconds, scroll) {
    const trace = fixtureWindow.__crt!.performance;
    const ring = fixtureWindow.__crt!.ring;
    ring.goToBottom(); trace.start();
    const channel = active();
    const started = performance.now();
    let generated = 0;
    while (performance.now() - started < seconds * 1000) {
      const due = Math.floor((performance.now() - started) * rate / 1000);
      const count = Math.min(100, Math.max(0, due - generated));
      if (count) {
        const events = Array.from({ length: count }, () => message(channel, 1000 + nextId++));
        const seq = (sequences.get(channel) ?? 1) + 1;
        sequences.set(channel, seq);
        const rows = history.get(channel)!;
        rows.push(...events); rows.splice(0, Math.max(0, rows.length - 1000));
        channelPipe!.onmessage(encode({ channelId: channel, seq, dropped: 0, events }));
        generated += count;
      }
      if (scroll) { const snap = ring.scrollSnapshot(); ring.setDesired(Math.max(0, snap.bottom - 100 + 80 * Math.sin((performance.now() - started) / 800)), true); }
      await sleep(40);
    }
    await sleep(100);
    return { requestedRate: rate, seconds, scroll, generated, visibility: document.visibilityState, ...trace.stop() };
  },
};
