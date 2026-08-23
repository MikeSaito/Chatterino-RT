/** Stock Chatterino context-menu web search helpers. */

export type SearchEngine = {
  url: string;
  name: string;
};

/** Preset → URL/name as stock GeneralPage. */
export function presetToEngine(preset: string): SearchEngine | null {
  switch (preset.trim()) {
    case "DuckDuckGo":
      return { url: "https://duckduckgo.com/?q=", name: "DuckDuckGo" };
    case "Bing":
      return { url: "https://www.bing.com/search?q=", name: "Bing" };
    case "Google":
      return { url: "https://www.google.com/search?q=", name: "Google" };
    default:
      return null;
  }
}

/** Same contract as Rust allowed_chat_url for opener. */
export function isAllowedHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /[\x00-\x1f\\]/.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (!parsed.hostname) {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Stock: searchEngineUrl + percentEncode(query).
 * Base must already be a stable http(s) URL with host; hostname must not
 * change after appending the encoded query (blocks host injection).
 */
export function buildWebSearchUrl(
  engineUrl: string,
  query: string,
): string | null {
  const base = engineUrl.trim();
  const q = query.trim();
  if (!base || !q || !isAllowedHttpUrl(base)) {
    return null;
  }
  let baseParsed: URL;
  try {
    baseParsed = new URL(base);
  } catch {
    return null;
  }
  const full = `${base}${encodeURIComponent(q)}`;
  let fullParsed: URL;
  try {
    fullParsed = new URL(full);
  } catch {
    return null;
  }
  if (
    fullParsed.protocol !== baseParsed.protocol ||
    fullParsed.hostname !== baseParsed.hostname ||
    fullParsed.username ||
    fullParsed.password
  ) {
    return null;
  }
  return fullParsed.href;
}

export function webSearchMenuLabel(engineName: string): string {
  const name = engineName.trim();
  return name ? `Search with ${name}` : "Search";
}
