import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AuthInfo } from "../chat/types";
import { formatInvokeError } from "../i18n/formatError.ts";
import { onLocaleChange, t } from "../i18n/index.ts";

export const CHAT_POLLS_EVENT = "chat:polls";

const PREDICT_MIN = 10;
const PREDICT_MAX = 250_000;
const PRESET_POINTS = [10, 50, 100, 500, 1000] as const;

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

type VoteResult = {
  ok: boolean;
  errorCode?: string | null;
};

type PredictResult = {
  ok: boolean;
  errorCode?: string | null;
  points: number;
};

export type BindPollPanelOpts = {
  host: HTMLElement;
  chatColumn: HTMLElement;
  activeChannel: () => string;
  getAuth: () => AuthInfo;
  startLogin: () => void;
  onStatus: (message: string, kind?: "info" | "danger") => void;
};

export function bindPollPanel(opts: BindPollPanelOpts): {
  sync: () => void;
  syncAuth: () => void;
  stop: () => void;
} {
  const byChannel = new Map<string, PollPanel[]>();
  const votedPolls = new Set<string>();
  const predictedEvents = new Set<string>();
  let busyKey = "";
  let betPanelId = "";
  let betOutcomeId = "";
  let betPoints = String(PREDICT_MIN);
  let statusMsg = "";
  let statusPanelId = "";
  let needsRelogin = false;
  let needsUnavailable = false;
  let unavailableUntil = 0;
  let unavailableTimer = 0;
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
    pruneLocalSelections(channel, panels);
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

  function pruneLocalSelections(channel: string, nextPanels: PollPanel[]): void {
    const prev = byChannel.get(channel) ?? [];
    const result = pruneChannelLocks({
      prev,
      next: nextPanels,
      voted: votedPolls,
      predicted: predictedEvents,
      betPanelId,
    });
    if (!result.betPanelId) {
      clearBetForm();
    }
    if (statusPanelId && result.removed.includes(statusPanelId)) {
      statusMsg = "";
      statusPanelId = "";
    }
  }

  function clearBetForm(): void {
    betPanelId = "";
    betOutcomeId = "";
    betPoints = String(PREDICT_MIN);
  }

  function setStatus(
    panelId: string,
    message: string,
    kind: "info" | "danger" = "info",
  ): void {
    statusPanelId = panelId;
    statusMsg = message;
    if (message) {
      opts.onStatus(message, kind);
    }
  }

  function paint(): void {
    if (stopped) {
      return;
    }
    const focusBet =
      betPanelId &&
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.id === `poll-bet-points-${betPanelId}`
        ? {
            start: document.activeElement.selectionStart ?? betPoints.length,
            end: document.activeElement.selectionEnd ?? betPoints.length,
          }
        : null;
    opts.host.replaceChildren();
    const panels = activePanels().filter(shouldKeepPanel);
    opts.host.hidden = panels.length === 0;
    opts.host.classList.toggle("is-empty", panels.length === 0);
    opts.host.setAttribute("aria-label", t("polls.host.aria"));
    if (panels.length === 0) {
      stopRaf();
      stopPruneTimer();
      statusMsg = "";
      statusPanelId = "";
      clearBetForm();
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
    if (focusBet && betPanelId) {
      const input = opts.host.querySelector<HTMLInputElement>(
        `#poll-bet-points-${CSS.escape(betPanelId)}`,
      );
      if (input) {
        input.focus();
        try {
          input.setSelectionRange(focusBet.start, focusBet.end);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function canInteract(panel: PollPanel): boolean {
    if (isFinished(panel)) {
      return false;
    }
    if (panel.kind === "prediction" && panel.status === "LOCKED") {
      return false;
    }
    return panel.status === "ACTIVE";
  }

  function hasAccount(): boolean {
    return Boolean(opts.getAuth().login?.trim());
  }

  function canAct(): boolean {
    if (needsUnavailable && Date.now() < unavailableUntil) {
      return false;
    }
    return hasAccount() && !needsRelogin;
  }

  function renderPanel(panel: PollPanel): HTMLElement {
    const root = document.createElement("section");
    root.className = `poll-panel poll-panel-${panel.kind}`;
    root.dataset.id = panel.id;
    root.dataset.kind = panel.kind;
    root.dataset.status = panel.status;
    root.setAttribute("role", "region");
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
    title.id = `poll-title-${panel.id}`;
    title.textContent = t(
      panel.kind === "poll" ? "polls.poll.title" : "polls.prediction.title",
      { title: panel.title },
    );
    titleBlock.append(kind, title);
    header.append(titleBlock);
    root.setAttribute("aria-labelledby", title.id);

    if (!isFinished(panel) && panel.status === "LOCKED") {
      const locked = document.createElement("span");
      locked.className = "poll-panel-locked";
      locked.textContent = t("polls.status.locked");
      header.append(locked);
    } else if (!isFinished(panel) && panel.endsAt) {
      const timer = document.createElement("span");
      timer.className = "poll-panel-timer";
      timer.setAttribute("aria-live", "off");
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

    const interactive = canInteract(panel);
    const loggedIn = canAct();
    const showLogin = !hasAccount() || needsRelogin;
    const showUnavailable =
      needsUnavailable && Date.now() < unavailableUntil && hasAccount() && !needsRelogin;
    const voted = panel.kind === "poll" && votedPolls.has(panel.id);
    const predicted = panel.kind === "prediction" && predictedEvents.has(panel.id);

    const list = document.createElement("ol");
    list.className = "poll-panel-options";
    const total = totalVotes(panel);
    for (const option of panel.options) {
      list.append(
        renderOption(panel, option, total, {
          interactive,
          loggedIn,
          voted,
          predicted,
        }),
      );
    }
    root.append(list);

    if (interactive && panel.kind === "prediction" && betPanelId === panel.id && betOutcomeId) {
      root.append(renderBetForm(panel));
    }

    if (statusMsg && statusPanelId === panel.id) {
      const err = document.createElement("p");
      err.className = "poll-panel-status";
      err.setAttribute("role", "status");
      err.textContent = statusMsg;
      root.append(err);
    }

    const hint = document.createElement("p");
    hint.className = "poll-panel-hint";
    if (isFinished(panel)) {
      // summary below
    } else if (showLogin) {
      hint.textContent = needsRelogin ? t("error.polls.relogin") : t("polls.hint.login");
      const login = document.createElement("button");
      login.type = "button";
      login.className = "poll-panel-login";
      login.textContent = t("auth.signin");
      login.addEventListener("click", () => opts.startLogin());
      root.append(hint, login);
    } else if (showUnavailable) {
      hint.textContent = t("polls.hint.unavailable");
      root.append(hint);
    } else if (voted) {
      hint.textContent = t("polls.hint.voted");
      root.append(hint);
    } else if (predicted) {
      hint.textContent = t("polls.hint.predicted");
      root.append(hint);
    } else if (panel.kind === "prediction" && panel.status === "LOCKED") {
      hint.textContent = t("polls.hint.locked");
      root.append(hint);
    } else if (panel.kind === "poll") {
      hint.textContent = t("polls.hint.vote");
      root.append(hint);
    } else {
      hint.textContent = t("polls.hint.predict");
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

  function renderOption(
    panel: PollPanel,
    option: PollOption,
    total: number,
    state: { interactive: boolean; loggedIn: boolean; voted: boolean; predicted: boolean },
  ): HTMLElement {
    const finished = isFinished(panel);
    const percent = total > 0 ? Math.round((option.votes / total) * 100) : 0;
    const selected =
      (panel.kind === "poll" && state.voted) ||
      (panel.kind === "prediction" && betPanelId === panel.id && betOutcomeId === option.id);
    const busy = busyKey === `${panel.kind}:${panel.id}:${option.id}`;
    const canClick =
      state.interactive &&
      state.loggedIn &&
      !state.voted &&
      !state.predicted &&
      !busyKey;

    const countText =
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

    if (canClick || busy) {
      const li = document.createElement("li");
      li.className = "poll-panel-option-wrap";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "poll-panel-option poll-panel-option-btn";
      btn.classList.toggle("is-winner", Boolean(option.isWinner));
      btn.classList.toggle("is-selected", selected);
      btn.classList.toggle("is-busy", busy);
      btn.disabled = Boolean(busyKey);
      if (option.color === "blue" || option.color === "pink") {
        btn.dataset.color = option.color;
      }
      btn.style.setProperty("--poll-fill", `${Math.max(0, Math.min(100, percent))}%`);
      btn.dataset.optionId = option.id;
      const ariaAction =
        panel.kind === "poll"
          ? t("polls.option.voteAria", { title: option.title })
          : t("polls.option.predictAria", { title: option.title });
      btn.setAttribute(
        "aria-label",
        busy
          ? `${ariaAction}. ${countText}. ${t("polls.option.submitting")}`
          : `${ariaAction}. ${countText}`,
      );
      btn.setAttribute("aria-pressed", selected ? "true" : "false");
      if (busy) {
        btn.setAttribute("aria-busy", "true");
      }

      const fill = document.createElement("span");
      fill.className = "poll-panel-option-fill";
      fill.setAttribute("aria-hidden", "true");
      const title = document.createElement("span");
      title.className = "poll-panel-option-title";
      title.textContent = option.title;
      const count = document.createElement("span");
      count.className = "poll-panel-option-count";
      count.textContent = busy ? t("polls.option.submitting") : countText;
      btn.append(fill, title, count);

      btn.addEventListener("click", () => {
        if (busyKey) {
          return;
        }
        if (panel.kind === "poll") {
          void submitVote(panel, option);
        } else {
          openBetForm(panel, option);
        }
      });
      li.append(btn);
      return li;
    }

    const li = document.createElement("li");
    li.className = "poll-panel-option";
    li.classList.toggle("is-winner", Boolean(option.isWinner));
    li.classList.toggle("is-selected", selected);
    if (option.color === "blue" || option.color === "pink") {
      li.dataset.color = option.color;
    }
    li.style.setProperty("--poll-fill", `${Math.max(0, Math.min(100, percent))}%`);

    const fill = document.createElement("span");
    fill.className = "poll-panel-option-fill";
    fill.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "poll-panel-option-title";
    title.textContent = option.title;
    const count = document.createElement("span");
    count.className = "poll-panel-option-count";
    count.textContent = countText;
    const winnerBit =
      finished && option.isWinner ? ` ${t("polls.option.winner")}` : "";
    li.setAttribute("aria-label", `${option.title}. ${countText}${winnerBit}`);
    li.append(fill, title, count);
    return li;
  }

  function openBetForm(panel: PollPanel, option: PollOption): void {
    if (busyKey || stopped) {
      return;
    }
    if (betPanelId === panel.id && betOutcomeId === option.id) {
      clearBetForm();
    } else {
      betPanelId = panel.id;
      betOutcomeId = option.id;
      if (!betPoints.trim()) {
        betPoints = String(PREDICT_MIN);
      }
    }
    statusMsg = "";
    statusPanelId = "";
    paint();
  }

  function renderBetForm(panel: PollPanel): HTMLElement {
    const form = document.createElement("form");
    form.className = "poll-panel-bet";
    form.setAttribute("aria-label", t("polls.bet.aria"));

    const label = document.createElement("label");
    label.className = "poll-panel-bet-label";
    label.htmlFor = `poll-bet-points-${panel.id}`;
    label.textContent = t("polls.bet.points");

    const row = document.createElement("div");
    row.className = "poll-panel-bet-row";

    const input = document.createElement("input");
    input.id = `poll-bet-points-${panel.id}`;
    input.className = "poll-panel-bet-input";
    input.type = "number";
    input.min = String(PREDICT_MIN);
    input.max = String(PREDICT_MAX);
    input.step = "1";
    input.required = true;
    input.value = betPoints;
    input.inputMode = "numeric";
    input.setAttribute("aria-describedby", `poll-bet-hint-${panel.id}`);
    input.addEventListener("input", () => {
      betPoints = input.value;
    });

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "poll-panel-bet-submit";
    const submitting = busyKey.startsWith(`prediction:${panel.id}:`);
    submit.textContent = submitting ? t("polls.option.submitting") : t("polls.bet.submit");
    submit.disabled = Boolean(busyKey);

    row.append(input, submit);

    const presets = document.createElement("div");
    presets.className = "poll-panel-bet-presets";
    presets.setAttribute("role", "group");
    presets.setAttribute("aria-label", t("polls.bet.presets"));
    for (const amount of PRESET_POINTS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "poll-panel-bet-preset";
      chip.textContent = compactNumber(amount);
      chip.disabled = Boolean(busyKey);
      chip.addEventListener("click", () => {
        betPoints = String(amount);
        input.value = betPoints;
      });
      presets.append(chip);
    }

    const hint = document.createElement("p");
    hint.id = `poll-bet-hint-${panel.id}`;
    hint.className = "poll-panel-bet-hint";
    hint.textContent = t("polls.bet.range", { min: PREDICT_MIN, max: PREDICT_MAX });

    form.append(label, row, presets, hint);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const outcome = panel.options.find((o) => o.id === betOutcomeId);
      if (!outcome) {
        return;
      }
      void submitPredict(panel, outcome, input.value);
    });
    return form;
  }

  async function submitVote(panel: PollPanel, option: PollOption): Promise<void> {
    if (stopped || busyKey || votedPolls.has(panel.id) || !canAct()) {
      return;
    }
    const key = `poll:${panel.id}:${option.id}`;
    busyKey = key;
    statusMsg = "";
    statusPanelId = "";
    paint();
    try {
      const result = await invoke<VoteResult>("polls_vote", {
        pollId: panel.id,
        choiceId: option.id,
      });
      if (stopped) {
        return;
      }
      if (result.ok) {
        votedPolls.add(panel.id);
        setStatus(panel.id, t("polls.vote.ok"), "info");
      } else {
        setStatus(panel.id, voteErrorText(result.errorCode), "danger");
        if (
          result.errorCode === "MULTI_CHOICE_VOTE_FORBIDDEN" ||
          result.errorCode === "VOTE_ID_CONFLICT"
        ) {
          votedPolls.add(panel.id);
        }
      }
    } catch (err) {
      if (stopped) {
        return;
      }
      markReloginIfNeeded(err);
      setStatus(panel.id, errorText(err, "polls.vote.error"), "danger");
    } finally {
      busyKey = "";
      if (!stopped) {
        paint();
      }
    }
  }

  async function submitPredict(
    panel: PollPanel,
    option: PollOption,
    rawPoints: string,
  ): Promise<void> {
    if (stopped || busyKey || predictedEvents.has(panel.id) || !canAct()) {
      return;
    }
    const points = parsePredictPoints(rawPoints);
    if (points == null) {
      setStatus(
        panel.id,
        t("error.polls.points_range", { min: PREDICT_MIN, max: PREDICT_MAX }),
        "danger",
      );
      paint();
      return;
    }
    const key = `prediction:${panel.id}:${option.id}`;
    busyKey = key;
    statusMsg = "";
    statusPanelId = "";
    paint();
    try {
      const result = await invoke<PredictResult>("polls_predict", {
        eventId: panel.id,
        outcomeId: option.id,
        points,
      });
      if (stopped) {
        return;
      }
      if (result.ok) {
        predictedEvents.add(panel.id);
        clearBetForm();
        setStatus(
          panel.id,
          t("polls.predict.ok", { points: compactNumber(result.points) }),
          "info",
        );
      } else {
        setStatus(panel.id, predictErrorText(result.errorCode), "danger");
        if (
          result.errorCode === "MULTIPLE_OUTCOMES" ||
          result.errorCode === "DUPLICATE_TRANSACTION"
        ) {
          predictedEvents.add(panel.id);
          clearBetForm();
        }
      }
    } catch (err) {
      if (stopped) {
        return;
      }
      markReloginIfNeeded(err);
      setStatus(panel.id, errorText(err, "polls.predict.error"), "danger");
    } finally {
      busyKey = "";
      if (!stopped) {
        paint();
      }
    }
  }

  function markReloginIfNeeded(err: unknown): void {
    if (!err || typeof err !== "object") {
      return;
    }
    const code = (err as { code?: unknown }).code;
    if (code === "error.polls.relogin" || code === "error.auth.required") {
      needsRelogin = true;
      needsUnavailable = false;
      unavailableUntil = 0;
      clearUnavailableTimer();
      return;
    }
    if (code === "error.polls.unavailable" || code === "error.polls.gql") {
      // Cooldown so repeated clicks do not spam status lines.
      needsUnavailable = true;
      unavailableUntil = Date.now() + 15_000;
      scheduleUnavailableClear();
    }
  }

  function clearUnavailableTimer(): void {
    if (unavailableTimer) {
      window.clearTimeout(unavailableTimer);
      unavailableTimer = 0;
    }
  }

  function scheduleUnavailableClear(): void {
    clearUnavailableTimer();
    const delay = Math.max(250, unavailableUntil - Date.now());
    unavailableTimer = window.setTimeout(() => {
      unavailableTimer = 0;
      if (!needsUnavailable) {
        return;
      }
      if (Date.now() < unavailableUntil) {
        scheduleUnavailableClear();
        return;
      }
      needsUnavailable = false;
      if (!stopped) {
        paint();
      }
    }, delay);
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
    syncAuth() {
      const login = opts.getAuth().login?.trim();
      if (login) {
        needsRelogin = false;
      }
      if (needsUnavailable && Date.now() >= unavailableUntil) {
        needsUnavailable = false;
      }
      paint();
    },
    stop() {
      stopped = true;
      stopRaf();
      stopPruneTimer();
      unlistenEvent?.();
      unlistenLocale();
      resize.disconnect();
      byChannel.clear();
      votedPolls.clear();
      predictedEvents.clear();
      busyKey = "";
      clearBetForm();
      statusMsg = "";
      statusPanelId = "";
      needsRelogin = false;
      needsUnavailable = false;
      unavailableUntil = 0;
      clearUnavailableTimer();
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

/** Pure helper: drop local locks only for panels that left this channel. */
export function pruneChannelLocks(opts: {
  prev: PollPanel[];
  next: PollPanel[];
  voted: Set<string>;
  predicted: Set<string>;
  betPanelId: string;
}): { betPanelId: string; removed: string[] } {
  const nextIds = new Set(opts.next.map((panel) => panel.id));
  const removed: string[] = [];
  let betPanelId = opts.betPanelId;
  for (const panel of opts.prev) {
    if (nextIds.has(panel.id)) {
      continue;
    }
    removed.push(panel.id);
    opts.voted.delete(panel.id);
    opts.predicted.delete(panel.id);
    if (betPanelId === panel.id) {
      betPanelId = "";
    }
  }
  return { betPanelId, removed };
}

export function parsePredictPoints(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return null;
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < PREDICT_MIN || n > PREDICT_MAX) {
    return null;
  }
  return n;
}

export function voteErrorText(code: string | null | undefined): string {
  const key = code ? `polls.vote.error.${code}` : "";
  const translated = key ? t(key) : "";
  return translated && translated !== key ? translated : t("polls.vote.error");
}

export function predictErrorText(code: string | null | undefined): string {
  const key = code ? `polls.predict.error.${code}` : "";
  const translated = key ? t(key) : "";
  return translated && translated !== key ? translated : t("polls.predict.error");
}

function errorText(err: unknown, fallback: "polls.vote.error" | "polls.predict.error"): string {
  const mapped = formatInvokeError(err, "status.error");
  return mapped === t("status.error") ? t(fallback) : mapped;
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
