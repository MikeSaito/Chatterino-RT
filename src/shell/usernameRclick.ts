/** Username RMB action from Chatterino behaviour knobs. */

export type UsernameRclickAction = "Mention" | "Reply" | "Ignore";
export type UsernameRclickModifier = "Shift" | "Control" | "Alt" | "Meta";

export function parseUsernameRclickAction(raw: unknown): UsernameRclickAction {
  const s = String(raw ?? "Mention");
  if (s === "Reply" || s === "Ignore" || s === "Mention") {
    return s;
  }
  return "Mention";
}

export function parseUsernameRclickModifier(raw: unknown): UsernameRclickModifier {
  const s = String(raw ?? "Shift");
  if (s === "Control" || s === "Alt" || s === "Meta" || s === "Shift") {
    return s;
  }
  return "Shift";
}

export type ModifierKeys = {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

export function modifierHeld(
  modifier: UsernameRclickModifier,
  keys: ModifierKeys,
): boolean {
  switch (modifier) {
    case "Shift":
      return keys.shiftKey && !keys.ctrlKey && !keys.altKey && !keys.metaKey;
    case "Control":
      return keys.ctrlKey && !keys.shiftKey && !keys.altKey && !keys.metaKey;
    case "Alt":
      return keys.altKey && !keys.shiftKey && !keys.ctrlKey && !keys.metaKey;
    case "Meta":
      return keys.metaKey && !keys.shiftKey && !keys.ctrlKey && !keys.altKey;
    default:
      return false;
  }
}

/** Author-nick path (canReply): pick primary or modifier behavior. */
export function resolveUsernameRightClick(opts: {
  behavior: UsernameRclickAction;
  modBehavior: UsernameRclickAction;
  modifier: UsernameRclickModifier;
  keys: ModifierKeys;
}): UsernameRclickAction {
  if (modifierHeld(opts.modifier, opts.keys)) {
    return opts.modBehavior;
  }
  return opts.behavior;
}
