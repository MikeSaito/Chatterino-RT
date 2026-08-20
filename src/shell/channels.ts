export type ChannelList = {
  remember: (login: string) => void;
  paint: (active: string) => void;
};

export function bindChannelList(
  list: HTMLUListElement,
  onSelect: (login: string) => void,
): ChannelList {
  const recents: string[] = [];

  const paint = (active: string): void => {
    list.replaceChildren();
    for (const login of recents) {
      const item = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = login === active ? "channel-item is-active" : "channel-item";
      btn.textContent = `#${login}`;
      btn.addEventListener("click", () => {
        onSelect(login);
      });
      item.appendChild(btn);
      list.appendChild(item);
    }
  };

  return {
    remember(login: string) {
      const at = recents.indexOf(login);
      if (at >= 0) {
        recents.splice(at, 1);
      }
      recents.unshift(login);
      paint(login);
    },
    paint,
  };
}
