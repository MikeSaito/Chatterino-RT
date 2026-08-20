import { decode } from "@msgpack/msgpack";
import type { ChatBatch } from "./types";

export function decodeBatch(raw: unknown): ChatBatch | null {
  let bytes: Uint8Array | null = null;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) {
    bytes = Uint8Array.from(raw);
  }
  if (!bytes) {
    return null;
  }
  try {
    const value = decode(bytes);
    if (!value || typeof value !== "object") {
      return null;
    }
    const batch = value as ChatBatch;
    if (typeof batch.channelId !== "string" || typeof batch.seq !== "number") {
      return null;
    }
    if (!Array.isArray(batch.events)) {
      return null;
    }
    return batch;
  } catch {
    return null;
  }
}
