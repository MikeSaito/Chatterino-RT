import { encode } from "@msgpack/msgpack";
import { decodeBatch } from "../src/chat/batchDecode.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Bytes from Rust encode_batch (rmp_serde::to_vec_named) of a notice batch.
const RUST_FIXTURE_HEX =
  "84a96368616e6e656c4964a3787163a373657103a764726f7070656401a66576656e74739184a46b696e64a66e6f74696365a26964a16eab74696d657374616d704d730ca474657874a26f6b";

{
  const batch = decodeBatch(hexToBytes(RUST_FIXTURE_HEX));
  assert(batch !== null, "fixture decode");
  assert(batch.channelId === "xqc", `channelId ${batch.channelId}`);
  assert(batch.seq === 3, `seq ${batch.seq}`);
  assert(batch.dropped === 1, `dropped ${batch.dropped}`);
  assert(batch.events.length === 1, "events len");
  assert(batch.events[0].kind === "notice", `kind ${batch.events[0].kind}`);
}

{
  const bytes = hexToBytes(RUST_FIXTURE_HEX);
  const asArray = Array.from(bytes);
  const batch = decodeBatch(asArray);
  assert(batch !== null && batch.channelId === "xqc", "number[] decode");
}

{
  assert(decodeBatch(null) === null, "null");
  assert(decodeBatch({}) === null, "object");
  assert(decodeBatch(new Uint8Array([0xff])) === null, "bad bytes");
}

{
  const packed = encode({
    channelId: "xqc",
    seq: Number.NaN,
    dropped: 0,
    events: [],
  });
  assert(decodeBatch(packed) === null, "nan seq");
  const packedInf = encode({
    channelId: "xqc",
    seq: 1,
    dropped: Number.POSITIVE_INFINITY,
    events: [],
  });
  assert(decodeBatch(packedInf) === null, "inf dropped");
}

console.log("batch decode tests ok");
