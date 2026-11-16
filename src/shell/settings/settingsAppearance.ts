import { clampChatFontSize, cssFontFamily, qtWeightToCss, sanitizeFontFamily } from "../../chat/chatFont";
import { applyResolvedTheme, resolveThemePreset } from "../theme";
import type { AppSettings } from "./settingsApply";

export function applySettingsAppearance(root: HTMLElement, data?: AppSettings): void {
  const knobs = data?.knobs;
  const preset = resolveThemePreset({
    theme: String(knobs?.["appearance.theme"] ?? "Dark"),
    darkSystem: String(knobs?.["appearance.darkSystemTheme"] ?? "Dark"),
    lightSystem: String(knobs?.["appearance.lightSystemTheme"] ?? "Light"),
  });
  if (root.dataset.theme !== preset) {
    applyResolvedTheme(preset, root);
  }
  const preview = root.querySelector<HTMLElement>(".settings-chat-preview");
  if (!preview || !data) {
    return;
  }
  const family = sanitizeFontFamily(String(knobs?.["appearance.chatFontFamily"] ?? "Segoe UI"));
  const size = clampChatFontSize(Number(knobs?.["appearance.chatFontSize"] ?? 10));
  const weight = qtWeightToCss(Number(knobs?.["appearance.chatFontWeight"] ?? 50));
  preview.style.setProperty("--preview-font-family", cssFontFamily(family));
  preview.style.setProperty("--preview-font-size", `${size * data.fontScale}px`);
  preview.style.setProperty("--preview-font-weight", String(weight));
  preview.classList.toggle("hide-timestamps", !data.showTimestamps);
  preview.classList.toggle("alternate-messages", knobs?.["appearance.alternateMessages"] === true);
}
