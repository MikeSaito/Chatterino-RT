/** One-click moderation timeout popup for the message-row clock icon. */

import { t } from "../i18n/index.ts";
import type { ModActionBtn } from "./modActions";
import {
  expandModAction,
  MOD_GUTTER_BAN_ACTION,
  MOD_GUTTER_DELETE_ACTION,
  MOD_GUTTER_TIMEOUT_ACTION,
} from "./modActions";
import type { TimeoutButton } from "./timeoutButtons";
import { moderationSlashCommand } from "./timeoutButtons";

export type ModTimeoutPopupTarget = {
  login: string;
  msgId: string;
  channel: string;
  clientX: number;
  clientY: number;
};

export type ModTimeoutPopupAction =
  | { kind: "command"; text: string }
  | { kind: "settings" };

export type ModTimeoutPopupOpts = {
  host: HTMLElement;
  getTimeoutButtons: () => TimeoutButton[];
  getModActions: () => ModActionBtn[];
  onAction: (action: ModTimeoutPopupAction) => void;
};

const BUILTIN = new Set([
  MOD_GUTTER_BAN_ACTION.trim().toLowerCase(),
  MOD_GUTTER_DELETE_ACTION.trim().toLowerCase(),
  MOD_GUTTER_TIMEOUT_ACTION.trim().toLowerCase(),
]);

export function bindModTimeoutPopup(opts: ModTimeoutPopupOpts): {
  open: (target: ModTimeoutPopupTarget) => void;
  hide: () => void;
  isOpen: () => boolean;
} {
  const { host, getTimeoutButtons, getModActions, onAction } = opts;
  host.hidden = true;
  host.setAttribute("role", "menu");
  host.classList.add("mod-timeout-popup");

  let open = false;
  let target: ModTimeoutPopupTarget | null = null;

  const hide = (): void => {
    open = false;
    target = null;
    host.hidden = true;
    host.replaceChildren();
  };

  const fireCommand = (text: string): void => {
    hide();
    onAction({ kind: "command", text });
  };

  const paint = (): void => {
    if (!target) {
      return;
    }
    const login = target.login.trim().toLowerCase();
    const msgId = target.msgId.trim();
    host.replaceChildren();

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.role = "menuitem";
    deleteBtn.className = "mod-timeout-popup__btn";
    deleteBtn.textContent = t("chat.mod.deleteFull");
    deleteBtn.title = t("chat.mod.deleteFull");
    deleteBtn.addEventListener("click", () => {
      if (!msgId) {
        return;
      }
      fireCommand(`/delete ${msgId}`);
    });
    host.append(deleteBtn);

    for (const btnDef of getTimeoutButtons()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.role = "menuitem";
      btn.className = "mod-timeout-popup__btn";
      btn.textContent = btnDef.label;
      btn.title = t("usercard.timeout.title", { n: String(btnDef.seconds) });
      btn.addEventListener("click", () => {
        const text = moderationSlashCommand("timeout", login, btnDef.seconds);
        if (!text) {
          return;
        }
        fireCommand(text);
      });
      host.append(btn);
    }

    const extras = getModActions().filter(
      (a) => !BUILTIN.has(a.action.trim().toLowerCase()),
    );
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.role = "menuitem";
    moreBtn.className = "mod-timeout-popup__btn mod-timeout-popup__more";
    moreBtn.textContent = "…";
    moreBtn.title = t("chat.mod.more");
    moreBtn.setAttribute("aria-label", t("chat.mod.more"));
    moreBtn.addEventListener("click", () => {
      if (extras.length === 0) {
        hide();
        onAction({ kind: "settings" });
        return;
      }
      const submenu = document.createElement("div");
      submenu.className = "mod-timeout-popup__submenu";
      submenu.setAttribute("role", "menu");
      for (const extra of extras) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.role = "menuitem";
        btn.className = "mod-timeout-popup__btn";
        btn.textContent = extra.label;
        btn.title = extra.action;
        btn.addEventListener("click", () => {
          const text = expandModAction(extra.action, {
            userName: login,
            msgId,
            channel: target?.channel ?? "",
          });
          if (!text) {
            return;
          }
          fireCommand(text);
        });
        submenu.append(btn);
      }
      moreBtn.replaceWith(submenu);
      position(host, target!.clientX, target!.clientY);
    });
    host.append(moreBtn);

    host.hidden = false;
    open = true;
    position(host, target.clientX, target.clientY);
  };

  const show = (next: ModTimeoutPopupTarget): void => {
    target = next;
    paint();
  };

  document.addEventListener("pointerdown", (ev) => {
    if (!open) {
      return;
    }
    if (host.contains(ev.target as Node)) {
      return;
    }
    hide();
  });
  document.addEventListener("keydown", (ev) => {
    if (open && ev.key === "Escape") {
      hide();
    }
  });

  return {
    open: show,
    hide,
    isOpen: () => open,
  };
}

function position(el: HTMLElement, clientX: number, clientY: number): void {
  const pad = 8;
  const w = el.offsetWidth || 280;
  const h = el.offsetHeight || 40;
  const maxX = Math.max(pad, window.innerWidth - w - pad);
  const maxY = Math.max(pad, window.innerHeight - h - pad);
  el.style.left = `${Math.min(maxX, Math.max(pad, clientX))}px`;
  el.style.top = `${Math.min(maxY, Math.max(pad, clientY + 4))}px`;
}
