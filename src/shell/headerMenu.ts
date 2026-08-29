/** Dropdown next to settings (Chatterino SplitHeader kebab). */

import { t, type MessageKey } from "../i18n";

export type HeaderMenuAction =
  | "search"
  | "open-browser"
  | "open-streamlink"
  | "open-custom-player"
  | "reconnect"
  | "leave";

type HeaderMenuItem = {
  action: HeaderMenuAction;
  labelKey: MessageKey;
  needsChannel: boolean;
  needsCustomScheme?: boolean;
};

const ITEMS: HeaderMenuItem[] = [
  { action: "search", labelKey: "header.menu.search", needsChannel: false },
  { action: "open-browser", labelKey: "header.menu.openBrowser", needsChannel: true },
  { action: "open-streamlink", labelKey: "header.menu.openStreamlink", needsChannel: true },
  {
    action: "open-custom-player",
    labelKey: "header.menu.openCustomPlayer",
    needsChannel: true,
    needsCustomScheme: true,
  },
  { action: "reconnect", labelKey: "header.menu.reconnect", needsChannel: true },
  { action: "leave", labelKey: "header.menu.leave", needsChannel: true },
];

export function bindHeaderMenu(opts: {
  button: HTMLButtonElement;
  menu: HTMLMenuElement;
  getChannel: () => string;
  hasCustomPlayer: () => boolean;
  onAction: (action: HeaderMenuAction) => void;
}): { hide: () => void; dispose: () => void; relabel: () => void } {
  const { button, menu, getChannel, hasCustomPlayer, onAction } = opts;
  const pad = 8;
  let disposed = false;

  const hide = (): void => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  const relabel = (): void => {
    for (const item of ITEMS) {
      const btn = menu.querySelector<HTMLButtonElement>(
        `button[data-action="${item.action}"]`,
      );
      if (btn) {
        btn.textContent = t(item.labelKey);
      }
    }
  };

  const paintItems = (): void => {
    const hasChannel = Boolean(getChannel().trim());
    const schemeOk = hasCustomPlayer();
    for (const btn of menu.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      const action = btn.dataset.action as HeaderMenuAction | undefined;
      const spec = ITEMS.find((i) => i.action === action);
      if (!spec) {
        continue;
      }
      btn.textContent = t(spec.labelKey);
      if (spec.needsCustomScheme) {
        btn.hidden = !schemeOk;
      } else {
        btn.hidden = false;
      }
      btn.disabled = Boolean(spec.needsChannel && !hasChannel);
    }
  };

  const show = (): void => {
    if (disposed) {
      return;
    }
    paintItems();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = rect.right - menuRect.width;
    left = Math.min(
      Math.max(pad, left),
      window.innerWidth - menuRect.width - pad,
    );
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight - pad) {
      top = Math.max(pad, rect.top - menuRect.height - 4);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  menu.replaceChildren();
  for (const item of ITEMS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.dataset.action = item.action;
    btn.textContent = t(item.labelKey);
    menu.appendChild(btn);
  }

  const onButtonClick = (ev: MouseEvent): void => {
    ev.stopPropagation();
    if (menu.hidden) {
      show();
    } else {
      hide();
    }
  };

  const onMenuClick = (ev: MouseEvent): void => {
    const t = ev.target;
    if (!(t instanceof HTMLButtonElement)) {
      return;
    }
    const action = t.dataset.action as HeaderMenuAction | undefined;
    if (!action || t.disabled || t.hidden) {
      return;
    }
    hide();
    onAction(action);
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (menu.hidden) {
      return;
    }
    const t = ev.target;
    if (!(t instanceof Node)) {
      return;
    }
    if (menu.contains(t) || button.contains(t)) {
      return;
    }
    hide();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && !menu.hidden) {
      hide();
    }
  };

  const onResize = (): void => {
    if (!menu.hidden) {
      hide();
    }
  };

  button.addEventListener("click", onButtonClick);
  menu.addEventListener("click", onMenuClick);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);

  return {
    hide,
    relabel,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      hide();
      button.removeEventListener("click", onButtonClick);
      menu.removeEventListener("click", onMenuClick);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    },
  };
}
