/** Map Tauri ApiError `{ code, message, params }` to localized UI text. */

import { t } from "./index.ts";

export type InvokeErrorShape = {
  code?: unknown;
  message?: unknown;
  params?: unknown;
};

function paramsRecord(
  raw: unknown,
): Record<string, string | number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number") {
      out[k] = v;
    } else if (v != null) {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Prefer catalog `t(code, params)` when `code` is a known message key;
 * otherwise English `message` from Rust; otherwise `fallbackKey`.
 */
export function formatInvokeError(
  err: unknown,
  fallbackKey: "status.error" | "status.bootError" = "status.error",
): string {
  if (typeof err === "string" && err.trim()) {
    const raw = err.trim();
    const code = raw.split(":")[0]!.trim();
    if (code.startsWith("error.")) {
      const translated = t(code);
      if (translated !== code) {
        const detail = raw.slice(code.length).replace(/^:\s*/, "");
        return detail ? `${translated}: ${detail}` : translated;
      }
    }
    return raw;
  }
  if (!err || typeof err !== "object") {
    return t(fallbackKey);
  }
  const rec = err as InvokeErrorShape;
  const code = typeof rec.code === "string" ? rec.code : "";
  const message = typeof rec.message === "string" ? rec.message : "";
  const params = paramsRecord(rec.params);

  if (code.startsWith("error.")) {
    const translated = t(code, params);
    if (translated !== code) {
      // Catalog hit without filled params would leave `{name}` — use EN message.
      if (!/\{\w+\}/.test(translated)) {
        return translated;
      }
      if (message.trim()) {
        return message;
      }
      return translated;
    }
  }

  if (message.trim()) {
    return message;
  }
  return t(fallbackKey);
}
