import { invoke } from "@tauri-apps/api/core";
import { getLocale, t, type MessageKey } from "../i18n";
import { formatInvokeError } from "../i18n/formatError";
import type { AuthInfo } from "../chat/types";
import { bindFocusTrap } from "./focusTrap";
import { closeModal, prepareModalOpen } from "./modalClose";
import { iconEl, setButtonIcon } from "./icons";
import { isSettingsWindowOpen } from "./settings/settingsWindowState";

type ChannelPointReward = {
  id: string;
  title: string;
  prompt?: string | null;
  cost: number;
  backgroundColor?: string | null;
  imageUrl?: string | null;
  isEnabled: boolean;
  isPaused: boolean;
  isInStock: boolean;
  isSubOnly: boolean;
  isUserInputRequired: boolean;
  cooldownExpiresAt?: string | null;
  globalCooldownSeconds?: number | null;
  maxPerStream?: number | null;
  maxPerUserPerStream?: number | null;
  redemptionsRedeemedCurrentStream?: number | null;
};

type ChannelPointsSnapshot = {
  channel: string;
  channelId?: string | null;
  displayName?: string | null;
  pointsName?: string | null;
  balance?: number | null;
  availableClaimId?: string | null;
  isSubscribed: boolean;
  enabled: boolean;
  authRequired: boolean;
  unavailableReason?: string | null;
  rewards: ChannelPointReward[];
};

type RedeemResult = {
  ok: boolean;
  redemptionId?: string | null;
  errorCode?: string | null;
  balance?: number | null;
};

type ClaimResult = {
  ok: boolean;
  errorCode?: string | null;
  balance?: number | null;
};

const REFRESH_MS = 20_000;
const REFRESH_MS_HIDDEN = 60_000;
/** When GQL needs re-login, do not hammer status every poll cycle. */
const REFRESH_MS_AUTH_REQUIRED = 300_000;
const TEXT_LIMIT = 500;

export function bindChannelPoints(opts: {
  button: HTMLButtonElement;
  label: HTMLElement;
  modal: HTMLElement;
  activeChannel: () => string | null;
  getAuth: () => AuthInfo;
  startLogin: () => void;
  onStatus: (message: string) => void;
}): {
  refresh: () => void;
  syncAuth: () => void;
  onChannelChanged: () => void;
  relabel: () => void;
  stop: () => void;
} {
  const { button, label, modal, activeChannel, getAuth, startLogin, onStatus } = opts;
  const dialog = modal.querySelector<HTMLElement>("#points-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#points-backdrop");
  const closeBtn = modal.querySelector<HTMLButtonElement>("#points-close");
  const title = modal.querySelector<HTMLElement>("#points-title");
  const sub = modal.querySelector<HTMLElement>("#points-sub");
  const balanceEl = modal.querySelector<HTMLElement>("#points-balance");
  const view = modal.querySelector<HTMLElement>("#points-view");
  const refreshBtn = modal.querySelector<HTMLButtonElement>("#points-refresh");
  if (!dialog || !backdrop || !closeBtn || !title || !sub || !balanceEl || !view || !refreshBtn) {
    return emptyBinding();
  }

  setButtonIcon(button, "points", { size: 14, label: t("points.open") });
  setButtonIcon(closeBtn, "close", { size: 16, label: t("points.close") });
  setButtonIcon(refreshBtn, "refresh", { size: 15, label: t("points.refresh") });
  button.append(label);

  let timer = 0;
  let cooldownTimer = 0;
  let seq = 0;
  let last: ChannelPointsSnapshot | null = null;
  let loading = false;
  let redeeming = "";
  let claiming = false;

  const trap = bindFocusTrap(dialog, {
    isActive: () => !modal.hidden,
    onEscape: () => {
      close();
      return true;
    },
  });

  const schedule = (): void => {
    window.clearTimeout(timer);
    let delay = REFRESH_MS;
    if (last?.authRequired) {
      delay = REFRESH_MS_AUTH_REQUIRED;
    } else if (document.visibilityState === "hidden" && modal.hidden) {
      delay = REFRESH_MS_HIDDEN;
    }
    timer = window.setTimeout(() => {
      void refresh(false);
    }, delay);
  };

  const channel = (): string => activeChannel()?.trim().toLowerCase() ?? "";

  const relabel = (): void => {
    button.setAttribute("aria-label", t("points.open"));
    button.title = t("points.open");
    closeBtn.setAttribute("aria-label", t("points.close"));
    closeBtn.title = t("points.close");
    refreshBtn.setAttribute("aria-label", t("points.refresh"));
    refreshBtn.title = t("points.refresh");
    paintButton();
    if (!modal.hidden) {
      paintModal(last);
    }
  };

  const paintButton = (): void => {
    const auth = getAuth();
    const ch = channel();
    button.hidden = false;
    button.disabled = false;
    button.classList.toggle("is-loading", loading);
    button.classList.remove("is-auth-cta");
    if (!auth.login) {
      label.textContent = "—";
      button.title = t("points.loginCta");
      button.setAttribute("aria-label", t("points.loginCta"));
      button.classList.add("is-auth-cta");
      return;
    }
    if (!ch) {
      label.textContent = t("points.noChannel");
      button.disabled = true;
      button.title = t("points.noChannel");
      button.setAttribute("aria-label", t("points.noChannel"));
      return;
    }
    if (last && last.channel === ch && last.authRequired) {
      label.textContent = "—";
      button.title = t("points.empty.relogin");
      button.setAttribute("aria-label", t("points.empty.relogin"));
      button.classList.add("is-auth-cta");
      return;
    }
    if (last && last.channel === ch && !last.authRequired && last.enabled && typeof last.balance === "number") {
      label.textContent = formatPoints(last.balance);
      button.title = t("points.balanceTitle", { points: formatPoints(last.balance) });
      button.setAttribute("aria-label", t("points.open"));
      return;
    }
    if (last && last.channel === ch && !last.enabled) {
      label.textContent = t("points.disabledShort");
      button.title = t("points.disabled");
      button.setAttribute("aria-label", t("points.disabled"));
      return;
    }
    label.textContent = loading ? "…" : "—";
    button.title = loading ? t("points.loading") : t("points.label");
    button.setAttribute("aria-label", t("points.open"));
  };

  const refresh = async (foreground: boolean): Promise<void> => {
    const auth = getAuth();
    const ch = channel();
    if (!auth.login || !ch) {
      last = null;
      loading = false;
      paintButton();
      if (!modal.hidden) {
        paintModal(last);
      }
      return;
    }
    const token = ++seq;
    const login = auth.login;
    loading = true;
    paintButton();
    try {
      const snapshot = await invoke<ChannelPointsSnapshot>("channel_points_status", { channel: ch });
      if (token !== seq || snapshot.channel !== channel() || getAuth().login !== login) {
        return;
      }
      last = snapshot;
      if (!modal.hidden) {
        paintModal(snapshot);
      }
    } catch (err) {
      if (token !== seq) {
        return;
      }
      // Relogin is returned as authRequired snapshot; other errors only surface on demand
      // or while the modal is open (avoid silent stale rewards list).
      if (foreground) {
        onStatus(errorText(err, "points.error.load"));
      }
      if (!modal.hidden) {
        paintError(errorText(err, "points.error.load"));
      }
    } finally {
      if (token === seq) {
        loading = false;
        paintButton();
        schedule();
      }
    }
  };

  const open = (): void => {
    if (isSettingsWindowOpen()) {
      return;
    }
    prepareModalOpen(modal);
    trap.activate();
    button.setAttribute("aria-expanded", "true");
    paintModal(last);
    refreshBtn.focus();
    void refresh(true);
  };

  const close = (): void => {
    trap.deactivate();
    button.setAttribute("aria-expanded", "false");
    void closeModal(modal);
  };

  const redeem = async (reward: ChannelPointReward, textarea: HTMLTextAreaElement | null): Promise<void> => {
    if (redeeming) {
      return;
    }
    const ch = channel();
    if (!ch) {
      return;
    }
    const token = seq;
    const text = textarea?.value.trim() || null;
    if (reward.isUserInputRequired && !text) {
      onStatus(t("points.error.textRequired"));
      textarea?.focus();
      return;
    }
    redeeming = reward.id;
    paintModal(last);
    try {
      const result = await invoke<RedeemResult>("channel_points_redeem", {
        channel: ch,
        rewardId: reward.id,
        textInput: text,
      });
      if (token !== seq || channel() !== ch) {
        return;
      }
      if (result.ok) {
        onStatus(t("points.redeem.ok"));
        if (textarea) {
          textarea.value = "";
        }
      } else {
        onStatus(redeemErrorText(result.errorCode));
      }
      await refresh(true);
    } catch (err) {
      if (token === seq) {
        onStatus(errorText(err, "points.error.redeem"));
      }
    } finally {
      redeeming = "";
      if (token === seq) {
        paintModal(last);
      }
    }
  };

  const claim = async (): Promise<void> => {
    if (claiming) {
      return;
    }
    const ch = channel();
    const claimId = last?.availableClaimId?.trim();
    if (!ch || !claimId || last?.channel !== ch) {
      return;
    }
    const token = seq;
    claiming = true;
    paintModal(last);
    try {
      const result = await invoke<ClaimResult>("channel_points_claim", {
        channel: ch,
        claimId,
      });
      if (token !== seq || channel() !== ch) {
        return;
      }
      if (result.ok) {
        onStatus(t("points.claim.ok"));
      } else {
        onStatus(redeemErrorText(result.errorCode) || t("points.error.claim"));
      }
      await refresh(true);
    } catch (err) {
      if (token === seq) {
        onStatus(errorText(err, "points.error.claim"));
      }
    } finally {
      claiming = false;
      if (token === seq) {
        paintModal(last);
      }
    }
  };

  const paintModal = (snapshot: ChannelPointsSnapshot | null): void => {
    window.clearTimeout(cooldownTimer);
    view.replaceChildren();
    const auth = getAuth();
    const ch = channel();
    title.textContent = ch ? t("points.title.channel", { channel: ch }) : t("points.title");
    sub.textContent = t("points.subtitle");
    balanceEl.replaceChildren(iconEl("points", 18), document.createTextNode(" "));
    if (!auth.login) {
      balanceEl.append(t("points.loginCta"));
      paintLoginState();
      return;
    }
    if (!ch) {
      balanceEl.append(t("points.noChannel"));
      paintEmpty("points.empty.noChannel");
      return;
    }
    if (!snapshot || snapshot.channel !== ch) {
      balanceEl.append(loading ? t("points.loading") : t("points.label"));
      paintEmpty(loading ? "points.empty.loading" : "points.empty.open");
      return;
    }
    if (snapshot.authRequired) {
      balanceEl.append(t("points.loginCta"));
      paintReloginState();
      return;
    }
    if (!snapshot.enabled) {
      balanceEl.append(t("points.disabled"));
      paintEmpty("points.empty.disabled");
      return;
    }
    if (typeof snapshot.balance === "number") {
      balanceEl.append(formatPoints(snapshot.balance));
    } else {
      balanceEl.append(t("points.balanceUnknown"));
    }
    if (snapshot.availableClaimId) {
      const claimBtn = document.createElement("button");
      claimBtn.type = "button";
      claimBtn.className = "btn btn-primary points-claim-btn";
      claimBtn.textContent = claiming ? t("points.claim.claiming") : t("points.claim");
      claimBtn.disabled = claiming;
      claimBtn.addEventListener("click", () => {
        void claim();
      });
      balanceEl.append(document.createTextNode(" "), claimBtn);
    }
    scheduleCooldownRefresh(snapshot);
    if (snapshot.rewards.length === 0) {
      paintEmpty("points.empty.noRewards");
      return;
    }
    const list = document.createElement("div");
    list.className = "points-rewards";
    const rewards = snapshot.rewards
      .slice()
      .sort((a, b) => a.cost - b.cost || a.title.localeCompare(b.title));
    for (const reward of rewards) {
      list.append(rewardCard(snapshot, reward));
    }
    view.append(list);
  };

  const paintReloginState = (): void => {
    const empty = document.createElement("div");
    empty.className = "points-empty";
    const text = document.createElement("p");
    text.textContent = t("points.empty.relogin");
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "btn btn-primary";
    cta.textContent = t("auth.signin");
    cta.addEventListener("click", () => {
      close();
      startLogin();
    });
    empty.append(text, cta);
    view.append(empty);
  };

  const scheduleCooldownRefresh = (snapshot: ChannelPointsSnapshot): void => {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const reward of snapshot.rewards) {
      if (!reward.cooldownExpiresAt) {
        continue;
      }
      const ms = Date.parse(reward.cooldownExpiresAt);
      if (Number.isFinite(ms) && ms > now) {
        next = Math.min(next, ms);
      }
    }
    if (!Number.isFinite(next)) {
      return;
    }
    cooldownTimer = window.setTimeout(() => {
      paintButton();
      if (!modal.hidden) {
        paintModal(last);
      }
    }, Math.max(250, next - now + 50));
  };

  const paintLoginState = (): void => {
    const empty = document.createElement("div");
    empty.className = "points-empty";
    const text = document.createElement("p");
    text.textContent = t("points.empty.login");
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "btn btn-primary";
    cta.textContent = t("auth.signin");
    cta.addEventListener("click", () => {
      close();
      startLogin();
    });
    empty.append(text, cta);
    view.append(empty);
  };

  const paintEmpty = (key: MessageKey): void => {
    const empty = document.createElement("p");
    empty.className = "points-empty";
    empty.textContent = t(key);
    view.append(empty);
  };

  const paintError = (message: string): void => {
    view.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "points-empty points-error";
    empty.textContent = message;
    view.append(empty);
  };

  const rewardCard = (snapshot: ChannelPointsSnapshot, reward: ChannelPointReward): HTMLElement => {
    const card = document.createElement("article");
    card.className = "points-reward";
    if (reward.backgroundColor) {
      card.style.setProperty("--reward-color", reward.backgroundColor);
    }
    const head = document.createElement("div");
    head.className = "points-reward-head";
    if (reward.imageUrl) {
      const img = document.createElement("img");
      img.src = reward.imageUrl;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      head.append(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "points-reward-ph";
      ph.append(iconEl("points", 18));
      head.append(ph);
    }
    const titleBox = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = reward.title;
    const cost = document.createElement("p");
    cost.textContent = t("points.reward.cost", { points: formatPoints(reward.cost) });
    titleBox.append(h, cost);
    head.append(titleBox);
    const prompt = document.createElement("p");
    prompt.className = "points-reward-prompt";
    prompt.textContent = reward.prompt?.trim() || t("points.reward.noPrompt");
    const text = reward.isUserInputRequired ? document.createElement("textarea") : null;
    if (text) {
      text.maxLength = TEXT_LIMIT;
      text.rows = 2;
      text.placeholder = t("points.reward.inputPlaceholder");
      text.spellcheck = true;
    }
    const reason = disabledReason(snapshot, reward);
    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn btn-primary";
    action.textContent = redeeming === reward.id ? t("points.reward.redeeming") : t("points.reward.redeem");
    action.disabled = Boolean(reason) || Boolean(redeeming);
    action.title = reason ? t(reason) : "";
    action.addEventListener("click", () => {
      void redeem(reward, text);
    });
    const meta = document.createElement("p");
    meta.className = "points-reward-meta";
    meta.textContent = rewardMeta(reward, reason);
    card.append(head, prompt);
    if (text) {
      card.append(text);
    }
    card.append(action, meta);
    return card;
  };

  button.addEventListener("click", () => {
    if (!getAuth().login) {
      startLogin();
      return;
    }
    open();
  });
  refreshBtn.addEventListener("click", () => {
    void refresh(true);
  });
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  const onResize = (): void => {
    if (!modal.hidden) {
      paintModal(last);
    }
  };
  const onVisible = (): void => {
    if (document.visibilityState === "visible") {
      void refresh(false);
    } else {
      schedule();
    }
  };
  window.addEventListener("resize", onResize);
  document.addEventListener("visibilitychange", onVisible);

  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "points-dialog");
  paintButton();
  void refresh(false);

  return {
    refresh: () => {
      void refresh(false);
    },
    syncAuth: () => {
      seq += 1;
      last = null;
      redeeming = "";
      claiming = false;
      window.clearTimeout(timer);
      paintButton();
      if (!modal.hidden) {
        paintModal(last);
      }
      void refresh(false);
    },
    onChannelChanged: () => {
      seq += 1;
      last = null;
      redeeming = "";
      claiming = false;
      paintButton();
      if (!modal.hidden) {
        paintModal(null);
      }
      void refresh(false);
    },
    relabel,
    stop: () => {
      window.clearTimeout(timer);
      window.clearTimeout(cooldownTimer);
      seq += 1;
      redeeming = "";
      claiming = false;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
      trap.deactivate();
    },
  };
}

function disabledReason(
  snapshot: ChannelPointsSnapshot,
  reward: ChannelPointReward,
): MessageKey | null {
  if (!reward.isEnabled || reward.isPaused || !reward.isInStock) {
    return "points.reward.unavailable";
  }
  if (typeof snapshot.balance !== "number") {
    return "points.reward.balanceUnknown";
  }
  if (snapshot.balance < reward.cost) {
    return "points.reward.notEnough";
  }
  if (reward.isSubOnly && !snapshot.isSubscribed) {
    return "points.reward.subOnly";
  }
  if (
    typeof reward.maxPerStream === "number" &&
    typeof reward.redemptionsRedeemedCurrentStream === "number" &&
    reward.redemptionsRedeemedCurrentStream >= reward.maxPerStream
  ) {
    return "points.reward.unavailable";
  }
  if (cooldownActive(reward.cooldownExpiresAt)) {
    return "points.reward.cooldown";
  }
  return null;
}

function cooldownActive(raw: string | null | undefined): boolean {
  if (!raw) {
    return false;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > Date.now();
}

function rewardMeta(reward: ChannelPointReward, reason: MessageKey | null): string {
  if (reason) {
    return t(reason);
  }
  const bits: string[] = [];
  if (reward.isSubOnly) {
    bits.push(t("points.reward.subOnly"));
  }
  if (reward.maxPerStream) {
    bits.push(t("points.reward.maxPerStream", { count: reward.maxPerStream }));
  }
  if (reward.maxPerUserPerStream) {
    bits.push(t("points.reward.maxPerUser", { count: reward.maxPerUserPerStream }));
  }
  if (reward.globalCooldownSeconds) {
    bits.push(t("points.reward.globalCooldown", { seconds: reward.globalCooldownSeconds }));
  }
  return bits.join(" · ");
}

function formatPoints(value: number): string {
  const locale = getLocale() === "ru" ? "ru-RU" : "en-US";
  return new Intl.NumberFormat(locale).format(Math.max(0, Math.floor(value)));
}

function errorText(err: unknown, fallback: MessageKey): string {
  if (typeof err === "string" && err.trim()) {
    return err;
  }
  const shaped = formatInvokeError(err, "status.error");
  if (shaped !== t("status.error")) {
    return shaped;
  }
  return t(fallback);
}

function redeemErrorText(code: string | null | undefined): string {
  const key = code ? `points.redeem.error.${code}` : "";
  const translated = key ? t(key) : "";
  return translated && translated !== key ? translated : t("points.error.redeem");
}

function emptyBinding(): {
  refresh: () => void;
  syncAuth: () => void;
  onChannelChanged: () => void;
  relabel: () => void;
  stop: () => void;
} {
  return {
    refresh: () => undefined,
    syncAuth: () => undefined,
    onChannelChanged: () => undefined,
    relabel: () => undefined,
    stop: () => undefined,
  };
}
