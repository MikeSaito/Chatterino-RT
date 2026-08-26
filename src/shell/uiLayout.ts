/** Shell chrome: Extended (TV + sidebar) or Classic (Chatterino-like tabs). */

export type UiLayout = "Extended" | "Classic";

export function parseUiLayout(raw: unknown): UiLayout {
  return String(raw ?? "") === "Classic" ? "Classic" : "Extended";
}

export function applyUiLayout(
  app: HTMLElement,
  mode: UiLayout,
  opts?: {
    settingsBtn?: HTMLButtonElement | null;
    channelList?: HTMLUListElement | null;
  },
): void {
  app.dataset.uiLayout = mode === "Classic" ? "classic" : "extended";
  if (opts?.settingsBtn) {
    opts.settingsBtn.textContent = mode === "Classic" ? "…" : "Настройки";
    opts.settingsBtn.title = "Settings";
  }
  if (opts?.channelList) {
    opts.channelList.setAttribute("role", mode === "Classic" ? "tablist" : "list");
  }
}
