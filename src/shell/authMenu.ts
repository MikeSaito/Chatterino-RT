/** Account chip dropdown (switch account / settings / logout). */

export type AuthMenuAction =
  | { kind: "select"; login: string }
  | { kind: "settings" }
  | { kind: "logout" };

export function bindAuthMenu(opts: {
  chip: HTMLButtonElement;
  menu: HTMLMenuElement;
  getAccounts: () => { login: string; current: boolean }[];
  canLogout: () => boolean;
  onAction: (action: AuthMenuAction) => void;
}): { hide: () => void; dispose: () => void } {
  const { chip, menu, getAccounts, canLogout, onAction } = opts;
  const pad = 8;
  let disposed = false;

  const hide = (): void => {
    menu.hidden = true;
    chip.setAttribute("aria-expanded", "false");
  };

  const paint = (): void => {
    menu.replaceChildren();
    for (const row of getAccounts()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.action = "select";
      btn.dataset.login = row.login;
      btn.textContent = row.current ? `${row.login} ✓` : row.login;
      btn.disabled = row.current;
      menu.appendChild(btn);
    }
    if (menu.childElementCount > 0) {
      const sep = document.createElement("hr");
      menu.appendChild(sep);
    }
    const settings = document.createElement("button");
    settings.type = "button";
    settings.dataset.action = "settings";
    settings.textContent = "Настройки";
    menu.appendChild(settings);
    if (canLogout()) {
      const logout = document.createElement("button");
      logout.type = "button";
      logout.dataset.action = "logout";
      logout.textContent = "Выйти";
      logout.className = "auth-menu-danger";
      menu.appendChild(logout);
    }
  };

  const show = (): void => {
    if (disposed || chip.hidden) {
      return;
    }
    paint();
    menu.hidden = false;
    chip.setAttribute("aria-expanded", "true");
    const rect = chip.getBoundingClientRect();
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

  const onChipClick = (ev: MouseEvent): void => {
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
    const action = t.dataset.action;
    if (!action || t.disabled) {
      return;
    }
    hide();
    if (action === "logout") {
      onAction({ kind: "logout" });
      return;
    }
    if (action === "settings") {
      onAction({ kind: "settings" });
      return;
    }
    if (action === "select") {
      const login = t.dataset.login?.trim();
      if (login) {
        onAction({ kind: "select", login });
      }
    }
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (menu.hidden) {
      return;
    }
    const t = ev.target;
    if (!(t instanceof Node)) {
      return;
    }
    if (menu.contains(t) || chip.contains(t)) {
      return;
    }
    hide();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && !menu.hidden) {
      hide();
    }
  };

  chip.addEventListener("click", onChipClick);
  menu.addEventListener("click", onMenuClick);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown);

  return {
    hide,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      hide();
      chip.removeEventListener("click", onChipClick);
      menu.removeEventListener("click", onMenuClick);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    },
  };
}
