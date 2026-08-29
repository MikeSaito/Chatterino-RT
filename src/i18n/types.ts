export type Locale = "en" | "ru";

export function parseLocale(raw: unknown): Locale {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "ru" || s === "ru-ru" || s === "russian") {
    return "ru";
  }
  return "en";
}
