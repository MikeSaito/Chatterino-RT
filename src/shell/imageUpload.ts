/** Composer paste → Rust image_upload (External tools Image Uploader). */

import { invoke } from "@tauri-apps/api/core";

export type ImageUploadKnobs = {
  enabled: boolean;
  askBefore: boolean;
};

export type ImageUploadResult = {
  link: string;
  deletionLink: string;
};

const MIME_TO_FORMAT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
};

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

export function parseImageUploadKnobs(
  knobs: Record<string, boolean | string | number | null | undefined>,
): ImageUploadKnobs {
  return {
    enabled: knobs["external.imageUploaderEnabled"] === true,
    askBefore: knobs["misc.askOnImageUpload"] !== false,
  };
}

export function imageFromClipboard(
  clipboard: DataTransfer | null,
): { blob: Blob; format: string } | null {
  if (!clipboard) {
    return null;
  }
  for (const type of Object.keys(MIME_TO_FORMAT)) {
    const item = clipboard.items
      ? Array.from(clipboard.items).find((i) => i.type === type)
      : null;
    if (item) {
      const blob = item.getAsFile();
      if (blob && blob.size > 0) {
        return { blob, format: MIME_TO_FORMAT[type]! };
      }
    }
  }
  for (const type of Object.keys(MIME_TO_FORMAT)) {
    const file = clipboard.files
      ? Array.from(clipboard.files).find((f) => f.type === type)
      : null;
    if (file && file.size > 0) {
      return { blob: file, format: MIME_TO_FORMAT[type]! };
    }
  }
  return null;
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

export function bindImageUploadPaste(opts: {
  input: HTMLTextAreaElement;
  getKnobs: () => ImageUploadKnobs;
  getChannel: () => string;
  onError: (message: string) => void;
}): () => void {
  let busy = false;
  const onPaste = (ev: ClipboardEvent): void => {
    const knobs = opts.getKnobs();
    if (!knobs.enabled || busy) {
      return;
    }
    const hit = imageFromClipboard(ev.clipboardData);
    if (!hit) {
      return;
    }
    if (hit.blob.size > 10 * 1024 * 1024) {
      ev.preventDefault();
      opts.onError("Image is too large (max 10 MiB).");
      return;
    }
    const channel = opts.getChannel().trim();
    if (!channel) {
      ev.preventDefault();
      opts.onError("нет активного канала");
      return;
    }
    ev.preventDefault();
    busy = true;
    if (knobs.askBefore) {
      const ok = window.confirm("Upload image from clipboard?");
      if (!ok) {
        busy = false;
        return;
      }
    }
    void (async () => {
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
        busy = false;
      }
    })();
  };
  opts.input.addEventListener("paste", onPaste);
  return () => {
    opts.input.removeEventListener("paste", onPaste);
  };
}
