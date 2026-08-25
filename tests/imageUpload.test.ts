import {
  formatFromFileName,
  formatFromMime,
  imageFromDataTransfer,
} from "../src/shell/imageUpload.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(formatFromFileName("shot.PNG") === "png", "png");
assert(formatFromFileName("a.jpeg") === "jpeg", "jpeg");
assert(formatFromFileName("a.jpg") === "jpeg", "jpg");
assert(formatFromFileName("x.gif") === "gif", "gif");
assert(formatFromFileName("x.webp") === null, "webp");
assert(formatFromFileName("noext") === null, "noext");

assert(formatFromMime("image/png") === "png", "mime png");
assert(formatFromMime("image/jpeg") === "jpeg", "mime jpeg");
assert(formatFromMime("text/plain") === null, "mime plain");

assert(imageFromDataTransfer(null) === null, "null dt");
assert(
  (await import("../src/shell/imageUpload.ts")).dataTransferLooksLikeImage(null) ===
    false,
  "looks null",
);

console.log("imageUpload tests ok");
