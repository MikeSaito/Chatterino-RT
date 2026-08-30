import {
  dataTransferLooksLikeImage,
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
assert(dataTransferLooksLikeImage(null) === false, "looks null");

{
  const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", {
    type: "image/png",
  });
  const dt = {
    types: ["Files", "image/png"],
    items: [
      {
        kind: "file",
        type: "image/png",
        getAsFile: () => file,
      },
    ],
    files: [file],
  } as unknown as DataTransfer;
  assert(dataTransferLooksLikeImage(dt) === true, "looks png");
  const hit = imageFromDataTransfer(dt);
  assert(hit !== null, "hit from png dt");
  assert(hit!.format === "png", `format ${hit!.format}`);
  assert(hit!.blob.size === 4, "blob size");
}

{
  const file = new File([new Uint8Array([9])], "note.txt", {
    type: "text/plain",
  });
  const dt = {
    types: ["Files"],
    items: [{ kind: "file", type: "text/plain", getAsFile: () => file }],
    files: [file],
  } as unknown as DataTransfer;
  assert(dataTransferLooksLikeImage(dt) === true, "Files type allows dragover");
  assert(imageFromDataTransfer(dt) === null, "plain file not image hit");
}

console.log("imageUpload tests ok");
