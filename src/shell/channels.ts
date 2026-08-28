import { setButtonIcon } from "./icons";

export type ChannelList = {
  hydrate: (recents: string[], open: string[], active: string) => void;
  remember: (login: string, makeActive?: boolean) => void;
  remove: (login: string) => void;
  syncOpen: (open: string[], active: string) => void;
  paint: (active: string) => void;
  joined: () => string[];
  setShowRecents: (show: boolean) => void;
};

export function bindChannelList(
  list: HTMLUListElement,
  onSelect: (login: string) => void,
  onLeave: (login: string) => void,
): ChannelList {
  const recents: string[] = [];
  const open = new Set<string>();
  let activeLogin = "";
  let showRecents = false;

  const paint = (active: string): void => {
    activeLogin = active;
    list.replaceChildren();
    const order = showRecents
      ? [
          ...[...open].sort((a, b) => a.localeCompare(b)),
          ...recents.filter((login) => !open.has(login)),
        ]
      : [...open];
    const seen = new Set<string>();
    for (const login of order) {
      if (seen.has(login)) {
        continue;
      }
      seen.add(login);
      const item = document.createElement("li");
      item.className = "channel-row";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = login === active ? "channel-item is-active" : "channel-item";
      btn.textContent = `#${login}`;
      btn.addEventListener("click", () => {
        onSelect(login);
      });
      item.appendChild(btn);
      if (open.has(login)) {
        const leave = document.createElement("button");
        leave.type = "button";
        leave.className = "channel-leave btn-icon";
        setButtonIcon(leave, "close", { size: 12, label: "Покинуть" });
        leave.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onLeave(login);
        });
        item.appendChild(leave);
      }
      list.appendChild(item);
    }
  };

  return {
    hydrate(nextRecents, nextOpen, active) {
      recents.length = 0;
      for (const login of nextRecents) {
        if (!recents.includes(login)) {
          recents.push(login);
        }
      }
      open.clear();
      for (const login of nextOpen) {
        open.add(login);
      }
      paint(active);
    },
    remember(login, makeActive = true) {
      open.add(login);
      const at = recents.indexOf(login);
      if (at >= 0) {
        recents.splice(at, 1);
      }
      recents.unshift(login);
      paint(makeActive ? login : activeLogin);
    },
    remove(login) {
      open.delete(login);
      const at = recents.indexOf(login);
      if (at >= 0) {
        recents.splice(at, 1);
      }
      paint(activeLogin === login ? "" : activeLogin);
    },
    syncOpen(nextOpen, active) {
      open.clear();
      for (const login of nextOpen) {
        open.add(login);
      }
      paint(active);
    },
    paint,
    joined: () => [...open],
    setShowRecents(show) {
      showRecents = show;
      paint(activeLogin);
    },
  };
}
