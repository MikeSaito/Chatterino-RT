/** Composer chrome knobs: empty visibility, length, overflow, pulse. */

export const MAX_CHAT_CHARS = 500;

export type MessageOverflow = "Highlight" | "Prevent" | "Allow";

export function parseMessageOverflow(raw: unknown): MessageOverflow {
  const s = String(raw ?? "Highlight");
  if (s === "Prevent" || s === "Allow" || s === "Highlight") {
    return s;
  }
  return "Highlight";
}

export type ComposerChromeOpts = {
  showEmptyInput: boolean;
  showMessageLength: boolean;
  overflow: MessageOverflow;
  pulseOnSelf: boolean;
};

export function defaultComposerChrome(): ComposerChromeOpts {
  return {
    showEmptyInput: true,
    showMessageLength: false,
    overflow: "Highlight",
    pulseOnSelf: false,
  };
}

export function bindComposerChrome(opts: {
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  lengthEl: HTMLElement;
  replyBar: HTMLElement;
  getOpts: () => ComposerChromeOpts;
}): {
  sync: () => void;
  pulse: () => void;
} {
  const { form, input, lengthEl, replyBar, getOpts } = opts;

  const sync = (): void => {
    const cfg = getOpts();
    const text = input.value;
    const empty = text.length === 0;
    const hideComposer = !cfg.showEmptyInput && empty && replyBar.hidden;
    form.hidden = hideComposer;
    form.classList.toggle("is-hidden-empty", hideComposer);
    if (hideComposer && document.activeElement === input) {
      input.blur();
    }

    if (cfg.overflow === "Prevent") {
      input.maxLength = MAX_CHAT_CHARS;
    } else {
      input.removeAttribute("maxlength");
    }

    const count = [...text].length;
    const over = count > MAX_CHAT_CHARS;
    lengthEl.hidden = !cfg.showMessageLength || empty;
    lengthEl.textContent = String(count);
    lengthEl.classList.toggle("is-over", over);
    form.classList.toggle("is-overflow", cfg.overflow === "Highlight" && over);
  };

  const pulse = (): void => {
    if (!getOpts().pulseOnSelf) {
      return;
    }
    input.classList.remove("is-self-pulse");
    // restart animation
    void input.offsetWidth;
    input.classList.add("is-self-pulse");
  };

  input.addEventListener("animationend", (ev) => {
    if (ev.animationName === "composer-self-pulse") {
      input.classList.remove("is-self-pulse");
    }
  });

  return { sync, pulse };
}
