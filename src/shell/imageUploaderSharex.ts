/**
 * ShareX / Chatterino image uploader settings import-export.
 * Logic aligned with Chatterino util/ImageUploader (MIT); reimplementation, not a port.
 */

export type ImageUploaderFields = {
  url: string;
  formField: string;
  link: string;
  deletionLink: string;
  headers: string;
};

export type ImportedImageUploader = {
  url: string;
  formField: string;
  link: string;
  deletionLink: string | null;
  headers: string | null;
  enabled: true;
};

export type ShareXExportObject = {
  Version: string;
  Name: string;
  RequestMethod: string;
  RequestURL: string;
  Body: string;
  FileFormName: string;
  URL: string;
  DeletionURL: string;
  Headers?: Record<string, string>;
};

/** Convert ShareX `{json:...}` tokens to Chatterino `{path}` form. */
export function parseShareXUrl(url: string): string {
  if (url.length === 0 || url.toLowerCase() === "{response}") {
    return "";
  }

  const tokenRegex = /\{json:([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}*/gi;
  const arrayRegex = /\[(\d+)\]/g;

  let out = "";
  let last = 0;
  let changed = false;
  let match: RegExpExecArray | null;
  tokenRegex.lastIndex = 0;
  while ((match = tokenRegex.exec(url)) !== null) {
    out += url.slice(last, match.index);
    let inner = match[1]!.trim();
    const pipeIndex = inner.lastIndexOf("|");
    if (pipeIndex !== -1) {
      inner = inner.slice(pipeIndex + 1).trim();
    }
    inner = inner.replace(arrayRegex, ".$1");
    out += `{${inner}}`;
    last = match.index + match[0].length;
    changed = true;
  }
  out += url.slice(last);
  return changed ? out : url;
}

function headersObjectFromLine(headers: string): Record<string, string> | undefined {
  const trimmed = headers.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const obj: Record<string, string> = {};
  for (const line of trimmed.split(";")) {
    if (line.length === 0) {
      continue;
    }
    const parts = line.split(":").filter((p) => p.length > 0);
    if (parts.length >= 2) {
      const key = parts[0]!.trim();
      const value = parts.slice(1).join(":").trim();
      obj[key] = value;
    }
  }
  return Object.keys(obj).length > 0 ? obj : undefined;
}

function headersLineFromObject(headersObj: Record<string, unknown>): string {
  const lines: string[] = [];
  const keys = Object.keys(headersObj).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const value = headersObj[key];
    if (typeof value === "string") {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join(";");
}

export function exportImageUploaderSettings(fields: ImageUploaderFields): ShareXExportObject {
  const settingsObj: ShareXExportObject = {
    Version: "1.0.0",
    Name: "Chatterino Image Uploader Settings",
    RequestMethod: "POST",
    RequestURL: fields.url,
    Body: "MultipartFormData",
    FileFormName: fields.formField,
    URL: fields.link,
    DeletionURL: fields.deletionLink,
  };
  const headersObj = headersObjectFromLine(fields.headers);
  if (headersObj) {
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(headersObj).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = headersObj[key]!;
    }
    settingsObj.Headers = sorted;
  }
  return settingsObj;
}

export function validateImportJson(clipboardText: string):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string } {
  const text = clipboardText.trim();
  if (text.length === 0) {
    return { ok: false, error: "Clipboard must not be empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "Clipboard did not contain valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "JSON must be an object" };
  }
  const settingsObj = parsed as Record<string, unknown>;
  if (!("Version" in settingsObj)) {
    return { ok: false, error: "JSON must contain the 'Version' key" };
  }
  if (!("RequestURL" in settingsObj)) {
    return { ok: false, error: "JSON must contain the 'RequestURL' key" };
  }
  if (typeof settingsObj.RequestURL !== "string") {
    return { ok: false, error: "RequestURL must be a string" };
  }
  return { ok: true, value: settingsObj };
}

export function importImageUploaderSettings(
  settingsObj: Record<string, unknown>,
): ImportedImageUploader | null {
  const requestUrl = settingsObj.RequestURL;
  const fileFormName = settingsObj.FileFormName;
  const urlField = settingsObj.URL;
  if (
    typeof requestUrl !== "string" ||
    typeof fileFormName !== "string" ||
    typeof urlField !== "string"
  ) {
    return null;
  }

  let deletionLink: string | null = null;
  if (typeof settingsObj.DeletionURL === "string") {
    deletionLink = parseShareXUrl(settingsObj.DeletionURL);
  }

  let headers: string | null = null;
  if (
    settingsObj.Headers !== null &&
    typeof settingsObj.Headers === "object" &&
    !Array.isArray(settingsObj.Headers)
  ) {
    const line = headersLineFromObject(settingsObj.Headers as Record<string, unknown>);
    if (line.length > 0) {
      headers = line;
    }
  }

  return {
    url: requestUrl,
    formField: fileFormName,
    link: parseShareXUrl(urlField),
    deletionLink,
    headers,
    enabled: true,
  };
}
