/** Pure attrs for a channel tab button (role=tab). */
export function channelTabAttrs(
  login: string,
  active: string,
): { role: "tab"; ariaSelected: "true" | "false"; className: string } {
  const on = login === active;
  return {
    role: "tab",
    ariaSelected: on ? "true" : "false",
    className: on ? "channel-item is-active" : "channel-item",
  };
}
