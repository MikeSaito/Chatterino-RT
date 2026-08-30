import { listen } from "@tauri-apps/api/event";
import { onLocaleChange, t } from "../i18n/index.ts";

export const CHAT_POLLS_EVENT = "chat:polls";

type PanelKind = "poll" | "prediction";

export type PollOption = {
  id: string;
  title: string;
  votes: number;
  points?: number;
  color?: "blue" | "pink" | string;
  isWinner?: boolean;
};

export type PollPanel = {
  kind: PanelKind;
  id: string;
  title: string;
  status: string;
  startedAt?: string;
  endsAt?: string;
  endedAt?: string;
  lockedAt?: string;
  winningOptionId?: string;
  totalVotes: number;
  options: PollOption[];
};

export type PollsPayload = {
  channel: string;
  panels: PollPanel[];
};

export type BindPollPanelOpts = {
  host: HTMLElement;
  chatColumn: HTMLElement;
  activeChannel: () => string;
};

export function bindPollPanel(opts: BindPollPanelOpts): {
  sync: () => void;
  stop: () => void;
} {
  const byChannel = new Map<string, PollPanel[]>();
  let raf = 0;
  let pruneTimer = 0;
  let stopped = false;
  let unlistenEvent: (() => void) | null = null;
  const unlistenLocale = onLocaleChange(() => paint());
  const resize = new ResizeObserver(() => syncOffset());
  resize.observe(opts.host);

  const stopRaf = (): void => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const stopPruneTimer = (): void => {
    if (pruneTimer) {
      window.clearTimeout(pruneTimer);
      pruneTimer = 0;
    }
  };

  const schedule = (): void => {
    stopRaf();
    if (stopped || opts.host.hidden) {
      return;
    }
    const tick = (): void => {
      raf = 0;
      updateTimers();
      if (hasActiveCountdown()) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
  };

  const schedulePrune = (): void => {
    stopPruneTimer();
    if (stopped) {
      return;
    }
    let soonest = Number.POSITIVE_INFINITY;
    for (const panels of byChannel.values()) {
      for (const panel of panels) {
        if (!isFinished(panel)) {
          continue;
        }
        const ended = Date.parse(panel.endedAt ?? panel.lockedAt ?? panel.endsAt ?? "");
        if (!Number.isFinite(ended)) {
          continue;
        }
        const dropAt = ended + 10 * 60 * 1000;
        soonest = Math.min(soonest, dropAt);
      }
    }
    if (!Number.isFinite(soonest)) {
      return;
    }
    const delay = Math.max(250, Math.min(60_000, soonest - Date.now()));
    pruneTimer = window.setTimeout(() => {
      pruneTimer = 0;
      if (pruneExpired()) {
        paint();
      } else {
        schedulePrune();
      }
    }, delay);
  };

  void listen<PollsPayload>(CHAT_POLLS_EVENT, (ev) => {
    if (stopped) {
      return;
    }
    const channel = normalizeChannel(ev.payload.channel);
    if (!channel) {
      return;
    }
    const panels = sanitizePanels(ev.payload.panels);
    if (panels.length === 0) {
      byChannel.delete(channel);
    } else {
      byChannel.set(channel, panels);
    }
    paint();
  }).then((dispose) => {
    if (stopped) {
      dispose();
      return;
    }
    unlistenEvent = dispose;
  });

  function activePanels(): PollPanel[] {
    return byChannel.get(normalizeChannel(opts.activeChannel())) ?? [];
  }

  function pruneExpired(): boolean {
    let changed = false;
    for (const [channel, panels] of [...byChannel.entries()]) {
      const next = panels.filter(shouldKeepPanel);
      if (next.length === panels.length) {
        continue;
      }
      changed = true;
      if (next.length === 0) {
        byChannel.delete(channel);
      } else {
        byChannel.set(channel, next);
      }
    }
    return changed;
  }

  function paint(): void {
    opts.host.replaceChildren();
    const panels = activePanels().filter(shouldKeepPanel);
    opts.host.hidden = panels.length === 0;
    opts.host.classList.toggle("is-empty", panels.length === 0);
    if (panels.length === 0) {
      stopRaf();
      stopPruneTimer();
      syncOffset();
      return;
    }
    for (const panel of panels) {
      opts.host.append(renderPanel(panel));
    }
    updateTimers();
    syncOffset();
    schedule();
    schedulePrune();
  }

  function renderPanel(panel: PollPanel): HTMLElement {
    const root = document.createElement("section");
    root.className = `poll-panel poll-panel-${panel.kind}`;
    root.dataset.id = panel.id;
    root.dataset.kind = panel.kind;
    root.dataset.status = panel.status;
    if (isFinished(panel)) {
      root.classList.add("is-finished");
    }

    const header = document.createElement("header");
    header.className = "poll-panel-head";
    const titleBlock = document.createElement("div");
    const kind = document.createElement("span");
    kind.className = "poll-panel-kind";
    kind.textContent = t(panel.kind === "poll" ? "polls.poll.kind" : "polls.prediction.kind");
    const title = document.createElement("h2");
    title.className = "poll-panel-title";
    title.textContent = t(
      panel.kind === "poll" ? "polls.poll.title" : "polls.prediction.title",
      { title: panel.title },
    );
    titleBlock.append(kind, title);
    header.append(titleBlock);

    if (!isFinished(panel) && panel.status === "LOCKED") {
      const locked = document.createElement("span");
      locked.className = "poll-panel-locked";
      locked.textContent = t("polls.status.locked");
      header.append(locked);
    } else if (!isFinished(panel) && panel.endsAt) {
      const timer = document.createElement("span");
      timer.className = "poll-panel-timer";
      timer.dataset.endsAt = panel.endsAt;
      timer.dataset.startedAt = panel.startedAt ?? "";
      timer.textContent = formatPollCountdown(msLeft(panel.endsAt));
      header.append(timer);
    }
    root.append(header);

    if (!isFinished(panel) && panel.endsAt && panel.status !== "LOCKED") {
      const bar = document.createElement("div");
      bar.className = "poll-panel-timebar";
      bar.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.className = "poll-panel-timebar-fill";
      bar.append(fill);
      root.append(bar);
    }

    const list = document.createElement("ol");
    list.className = "poll-panel-options";
    const total = totalVotes(panel);
    for (const option of panel.options) {
      list.append(renderOption(option, total, isFinished(panel)));
    }
    root.append(list);

    if (!isFinished(panel)) {
      const hint = document.createElement("p");
      hint.className = "poll-panel-hint";
      hint.textContent = t("polls.viewerHint");
      root.append(hint);
    }

    const summary = summaryText(panel);
    if (summary) {
      const el = document.createElement("p");
      el.className = "poll-panel-summary";
      el.textContent = summary;
      root.append(el);
    }
    return root;
  }

  function renderOption(option: PollOption, total: number, finished: boolean): HTMLElement {
    const li = document.createElement("li");
    li.className = "poll-panel-option";
    li.classList.toggle("is-winner", Boolean(option.isWinner));
    if (option.color === "blue" || option.color === "pink") {
      li.dataset.color = option.color;
    }
    const percent = total > 0 ? Math.round((option.votes / total) * 100) : 0;
    li.style.setProperty("--poll-fill", `${Math.max(0, Math.min(100, percent))}%`);

    const fill = document.createElement("span");
    fill.className = "poll-panel-option-fill";
    const title = document.createElement("span");
    title.className = "poll-panel-option-title";
    title.textContent = option.title;
    const count = document.createElement("span");
    count.className = "poll-panel-option-count";
    count.textContent =
      option.points && option.points > 0
        ? t("polls.option.points", {
            count: compactNumber(option.votes),
            points: compactNumber(option.points),
            percent,
          })
        : t("polls.option.votes", {
            count: compactNumber(option.votes),
            percent,
          });
    if (finished && option.isWinner) {
      count.setAttribute("aria-label", t("polls.option.winner"));
    }
    li.append(fill, title, count);
    return li;
  }

  function updateTimers(): void {
    const now = Date.now();
    opts.host.querySelectorAll<HTMLElement>(".poll-panel-timer").forEach((el) => {
      const endsAt = el.dataset.endsAt ?? "";
      const left = msLeft(endsAt, now);
      el.textContent = formatPollCountdown(left);
      const startedAt = Date.parse(el.dataset.startedAt ?? "");
      const end = Date.parse(endsAt);
      const panel = el.closest<HTMLElement>(".poll-panel");
      if (panel && Number.isFinite(startedAt) && Number.isFinite(end) && end > startedAt) {
        const progress = 1 - Math.max(0, Math.min(1, left / (end - startedAt)));
        panel.style.setProperty("--poll-time-progress", `${progress}`);
      }
    });
  }

  function hasActiveCountdown(): boolean {
    const now = Date.now();
    return activePanels().some(
      (panel) =>
        !isFinished(panel) &&
        panel.status !== "LOCKED" &&
        panel.endsAt &&
        msLeft(panel.endsAt, now) > 0,
    );
  }

  function syncOffset(): void {
    const height = opts.host.hidden ? 0 : Math.ceil(opts.host.getBoundingClientRect().height);
    opts.chatColumn.style.setProperty("--poll-panel-offset", height ? `${height}px` : "0px");
  }

  paint();

  return {
    sync: paint,
    stop() {
      stopped = true;
      stopRaf();
      stopPruneTimer();
      unlistenEvent?.();
      unlistenLocale();
      resize.disconnect();
      byChannel.clear();
      opts.host.replaceChildren();
      opts.host.hidden = true;
      syncOffset();
    },
  };
}

function mergePanelsByKind(panels: PollPanel[]): PollPanel[] {
  const byKind = new Map<PanelKind, PollPanel>();
  for (const panel of panels) {
    const prev = byKind.get(panel.kind);
    if (!prev || priority(panel) < priority(prev)) {
      byKind.set(panel.kind, panel);
    }
  }
  return [...byKind.values()]
    .filter(shouldKeepPanel)
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, 2);
}

export function sanitizePanels(raw: unknown): PollPanel[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return mergePanelsByKind(
    raw
      .map((panel) => sanitizePanel(panel))
      .filter((panel): panel is PollPanel => Boolean(panel)),
  );
}

function sanitizePanel(raw: unknown): PollPanel | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const kind = rec.kind === "prediction" ? "prediction" : rec.kind === "poll" ? "poll" : null;
  const id = safeText(rec.id, 128);
  const title = safeText(rec.title, 160);
  const status = safeText(rec.status, 32).toUpperCase();
  const options = Array.isArray(rec.options)
    ? rec.options.map(sanitizeOption).filter((item): item is PollOption => Boolean(item))
    : [];
  if (!kind || !id || !title || options.length === 0) {
    return null;
  }
  const finishedStatuses = [
    "COMPLETED",
    "TERMINATED",
    "ARCHIVED",
    "MODERATED",
    "RESOLVED",
    "CANCELED",
    "CANCELLED",
    "INVALID",
  ];
  const normalizedStatus = status || "ACTIVE";
  let endedAt = safeIso(rec.endedAt);
  if (!endedAt && finishedStatuses.includes(normalizedStatus)) {
    endedAt = safeIso(rec.lockedAt) ?? safeIso(rec.endsAt) ?? new Date().toISOString();
  }
  return {
    kind,
    id,
    title,
    status: normalizedStatus,
    startedAt: safeIso(rec.startedAt),
    endsAt: safeIso(rec.endsAt),
    endedAt,
    lockedAt: safeIso(rec.lockedAt),
    winningOptionId: safeText(rec.winningOptionId, 128) || undefined,
    totalVotes: nonNegativeInt(rec.totalVotes),
    options,
  };
}

function sanitizeOption(raw: unknown): PollOption | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const id = safeText(rec.id, 128);
  const title = safeText(rec.title, 80);
  if (!id || !title) {
    return null;
  }
  return {
    id,
    title,
    votes: nonNegativeInt(rec.votes),
    points: rec.points == null ? undefined : nonNegativeInt(rec.points),
    color: safeText(rec.color, 16) || undefined,
    isWinner: Boolean(rec.isWinner),
  };
}

function shouldKeepPanel(panel: PollPanel): boolean {
  if (!isFinished(panel)) {
    return true;
  }
  const ended = Date.parse(panel.endedAt ?? panel.lockedAt ?? panel.endsAt ?? "");
  if (!Number.isFinite(ended)) {
    return false;
  }
  return Date.now() - ended < 10 * 60 * 1000;
}

function priority(panel: PollPanel): number {
  if (!isFinished(panel)) {
    return panel.kind === "poll" ? 0 : 1;
  }
  return panel.kind === "poll" ? 2 : 3;
}

export function summaryText(panel: PollPanel): string {
  if (!isFinished(panel)) {
    return "";
  }
  if (panel.status === "CANCELED" || panel.status === "CANCELLED" || panel.status === "TERMINATED") {
    return t(panel.kind === "poll" ? "polls.poll.cancelled" : "polls.prediction.cancelled");
  }
  const winner = panel.options.find((option) => option.isWinner || option.id === panel.winningOptionId);
  if (!winner) {
    return t(panel.kind === "poll" ? "polls.poll.finishedNoWinner" : "polls.prediction.finishedNoWinner");
  }
  const total = totalVotes(panel);
  const percent = total > 0 ? Math.round((winner.votes / total) * 100) : 0;
  return t(panel.kind === "poll" ? "polls.poll.finished" : "polls.prediction.finished", {
    title: winner.title,
    percent,
    count: compactNumber(winner.votes),
  });
}

function totalVotes(panel: PollPanel): number {
  const explicit = nonNegativeInt(panel.totalVotes);
  return explicit > 0
    ? explicit
    : panel.options.reduce((sum, option) => sum + nonNegativeInt(option.votes), 0);
}

export function isFinished(panel: PollPanel): boolean {
  return [
    "COMPLETED",
    "TERMINATED",
    "ARCHIVED",
    "MODERATED",
    "RESOLVED",
    "CANCELED",
    "CANCELLED",
    "INVALID",
  ].includes(panel.status);
}

function msLeft(endsAt: string, now = Date.now()): number {
  const end = Date.parse(endsAt);
  return Number.isFinite(end) ? Math.max(0, end - now) : 0;
}

export function formatPollCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function compactNumber(n: number): string {
  const value = nonNegativeInt(n);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function normalizeChannel(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function safeText(raw: unknown, max: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return Array.from(raw.replace(/[\0\r\n\u0001]/g, "").trim()).slice(0, max).join("");
}

function safeIso(raw: unknown): string | undefined {
  const text = safeText(raw, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function nonNegativeInt(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
