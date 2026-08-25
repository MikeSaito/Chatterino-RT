/** Composer paste/drop → Rust image_upload (External tools Image Uploader). */

import { invoke } from "@tauri-apps/api/core";

export type ImageUploadKnobs = {
  enabled: boolean;
  askBefore: boolean;
};

export type ImageUploadResult = {
  link: string;
  deletionLink: string;
};

export type ImageHit = {
  blob: Blob;
  format: string;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_TO_FORMAT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
};

export function parseImageUploadKnobs(
  knobs: Record<string, boolean | string | number | null | undefined>,
): ImageUploadKnobs {
  return {
    enabled: knobs["external.imageUploaderEnabled"] === true,
    askBefore: knobs["misc.askOnImageUpload"] !== false,
  };
}

/** Map filename extension to upload format (when File.type is empty). */
export function formatFromFileName(name: string): string | null {
  const lower = name.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  const ext = lower.slice(dot + 1);
  if (ext === "png") {
    return "png";
  }
  if (ext === "jpg" || ext === "jpeg") {
    return "jpeg";
  }
  if (ext === "gif") {
    return "gif";
  }
  return null;
}

export function formatFromMime(mime: string): string | null {
  return MIME_TO_FORMAT[mime.trim().toLowerCase()] ?? null;
}

function formatForFile(file: File): string | null {
  const mime = file.type.trim();
  if (mime) {
    return formatFromMime(mime);
  }
  return formatFromFileName(file.name);
}

/** dragover-safe: no getAsFile (null in protected mode). */
export function dataTransferLooksLikeImage(dt: DataTransfer | null): boolean {
  if (!dt) {
    return false;
  }
  if (dt.types) {
    for (const t of Array.from(dt.types)) {
      if (formatFromMime(t)) {
        return true;
      }
      if (t === "Files") {
        // May be image files; allow drop target. Final filter on drop.
        return true;
      }
    }
  }
  if (dt.items && dt.items.length > 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") {
        continue;
      }
      if (formatFromMime(item.type)) {
        return true;
      }
      // Empty type + file kind: likely OS file drag; accept for dragover.
      if (!item.type.trim()) {
        return true;
      }
    }
  }
  return false;
}

/** First png/jpeg/gif from clipboard items or file list. */
export function imageFromDataTransfer(
  dt: DataTransfer | null,
): ImageHit | null {
  if (!dt) {
    return null;
  }
  if (dt.items && dt.items.length > 0) {
    for (const type of Object.keys(MIME_TO_FORMAT)) {
      const item = Array.from(dt.items).find((i) => i.type === type);
      if (!item) {
        continue;
      }
      const blob = item.getAsFile();
      if (blob && blob.size > 0) {
        return { blob, format: MIME_TO_FORMAT[type]! };
      }
    }
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") {
        continue;
      }
      const file = item.getAsFile();
      if (!file || file.size <= 0) {
        continue;
      }
      const format = formatForFile(file);
      if (format) {
        return { blob: file, format };
      }
    }
  }
  if (dt.files && dt.files.length > 0) {
    for (const file of Array.from(dt.files)) {
      if (file.size <= 0) {
        continue;
      }
      const format = formatForFile(file);
      if (format) {
        return { blob: file, format };
      }
    }
  }
  return null;
}

/** @deprecated alias — use imageFromDataTransfer */
export function imageFromClipboard(
  clipboard: DataTransfer | null,
): ImageHit | null {
  return imageFromDataTransfer(clipboard);
}

export function dataTransferHasImage(dt: DataTransfer | null): boolean {
  return imageFromDataTransfer(dt) != null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const comma = dataUrl.indexOf(",");
      if (comma < 0) {
        reject(new Error("Invalid image data"));
        return;
      }
      resolve(dataUrl.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export function insertAtCursor(
  input: HTMLTextAreaElement,
  text: string,
): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  input.value = `${before}${text}${after}`;
  const caret = before.length + text.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

type BindOpts = {
  input: HTMLTextAreaElement;
  getKnobs: () => ImageUploadKnobs;
  getChannel: () => string;
  onError: (message: string) => void;
};

async function runUpload(
  hit: ImageHit,
  opts: BindOpts,
  confirmLabel: string,
  setBusy: (v: boolean) => void,
  isBusy: () => boolean,
): Promise<boolean> {
  if (isBusy()) {
    return false;
  }
  const knobs = opts.getKnobs();
  if (!knobs.enabled) {
    return false;
  }
  if (hit.blob.size > MAX_IMAGE_BYTES) {
    opts.onError("Image is too large (max 10 MiB).");
    return true;
  }
  const channel = opts.getChannel().trim();
  if (!channel) {
    opts.onError("нет активного канала");
    return true;
  }
  setBusy(true);
  if (knobs.askBefore) {
    const ok = window.confirm(confirmLabel);
    if (!ok) {
      setBusy(false);
      return true;
    }
  }
  try {
    const bytesBase64 = await blobToBase64(hit.blob);
    const result = await invoke<ImageUploadResult>("image_upload", {
      channel,
      bytesBase64,
      format: hit.format,
    });
    const link = (result.link || "").trim();
    if (link) {
      insertAtCursor(opts.input, `${link} `);
      opts.input.focus();
    }
  } catch (err) {
    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
    opts.onError(message || "Image upload failed");
  } finally {
    setBusy(false);
  }
  return true;
}

/** Paste + drop of a single png/jpeg/gif onto the composer. */
export function bindImageUpload(opts: BindOpts): () => void {
  let busy = false;
  const setBusy = (v: boolean): void => {
    busy = v;
  };
  const isBusy = (): boolean => busy;

  const onPaste = (ev: ClipboardEvent): void => {
    const knobs = opts.getKnobs();
    if (!knobs.enabled) {
      return;
    }
    const hit = imageFromDataTransfer(ev.clipboardData);
    if (!hit) {
      return;
    }
    ev.preventDefault();
    if (busy) {
      return;
    }
    void runUpload(
      hit,
      opts,
      "Upload image from clipboard?",
      setBusy,
      isBusy,
    );
  };

  const onDragOver = (ev: DragEvent): void => {
    const knobs = opts.getKnobs();
    if (!knobs.enabled) {
      return;
    }
    if (!dataTransferLooksLikeImage(ev.dataTransfer)) {
      return;
    }
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (ev: DragEvent): void => {
    const knobs = opts.getKnobs();
    if (!knobs.enabled) {
      return;
    }
    const hit = imageFromDataTransfer(ev.dataTransfer);
    if (!hit) {
      return;
    }
    ev.preventDefault();
    if (busy) {
      return;
    }
    void runUpload(hit, opts, "Upload dropped image?", setBusy, isBusy);
  };

  opts.input.addEventListener("paste", onPaste);
  opts.input.addEventListener("dragover", onDragOver);
  opts.input.addEventListener("drop", onDrop);
  return () => {
    opts.input.removeEventListener("paste", onPaste);
    opts.input.removeEventListener("dragover", onDragOver);
    opts.input.removeEventListener("drop", onDrop);
  };
}

/** @deprecated use bindImageUpload */
export const bindImageUploadPaste = bindImageUpload;
