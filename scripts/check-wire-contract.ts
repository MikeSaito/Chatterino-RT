import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decodeBatch } from "../src/chat/batchDecode.ts";
import type { ChatBatch, ChatEvent } from "../src/chat/types.ts";
const output = mkdtempSync(join(tmpdir(), "crt-contract-"));
try {
 const result = spawnSync("cargo", ["test", "--lib", "--manifest-path", "src-tauri/Cargo.toml", "export_typescript_contract", "--", "--exact", "chat::batch::tests::export_typescript_contract"], { env: { ...process.env, CRT_CONTRACT_DIR: output }, stdio: "inherit" });
 assert.equal(result.status, 0, "Rust fixture export must pass");
 const expected = JSON.parse(readFileSync(join(output, "batch.json"), "utf8")) as ChatBatch;
 const golden = JSON.parse(readFileSync(new URL("../tests/fixtures/chat-batch.json", import.meta.url), "utf8")) as ChatBatch;
 assert.deepEqual(expected, golden, "Rust wire format changed: review and update both languages and the golden contract");
 const bytes = new Uint8Array(readFileSync(join(output, "batch.msgpack")));
 for (const raw of [bytes, bytes.buffer, Array.from(bytes), new DataView(bytes.buffer)]) assert.deepEqual(decodeBatch(raw), expected);
 const kinds: Record<ChatEvent["kind"], true> = { privmsg:true, clearchat:true, clearmsg:true, usernotice:true, roomstate:true, userstate:true, notice:true, automodHeld:true, automodStatus:true, lowTrustHeader:true, lowTrustMessage:true };
 assert.deepEqual([...new Set(expected.events.map(e => e.kind))].sort(), Object.keys(kinds).sort());
 const message = expected.events[0]; assert.equal(message.kind, "privmsg");
 if(message.kind === "privmsg") { assert.equal(message.text, "Привет 👋 日本語"); assert.equal(message.displayName, "Анна"); assert.equal(message.emoteSpans[0].emoteId, "25"); assert.equal(message.replyToId, undefined); }
 assert.equal(expected.events[expected.events.length - 1]?.kind, "roomstate");
 for (const raw of [bytes.slice(0, -1), new Uint8Array([0xc1]), null, {}, "bad"]) assert.equal(decodeBatch(raw), null);
 console.log("Rust/TypeScript wire contract ok");
} finally { rmSync(output, { recursive:true, force:true }); }
