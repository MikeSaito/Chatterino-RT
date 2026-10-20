import assert from "node:assert/strict";
import { checkReleaseManifest, sha256 } from "../scripts/releaseArtifact.ts";
const assets=new Map([["app.exe",new Uint8Array([1,2,3])],["app.exe.sig",new TextEncoder().encode("signature\n")]]);
const manifest={version:"1.2.3",platforms:{"windows-x86_64":{url:"https://example.com/app.exe",signature:"signature"}}};
assert.equal(checkReleaseManifest(manifest,"1.2.3",assets),"app.exe");
assert.throws(()=>checkReleaseManifest(manifest,"1.2.4",assets));
assert.throws(()=>checkReleaseManifest({...manifest,platforms:{}},"1.2.3",assets));
assert.throws(()=>checkReleaseManifest({...manifest,platforms:{"windows-x86_64":{...manifest.platforms["windows-x86_64"],signature:"wrong"}}},"1.2.3",assets));
assert.throws(()=>checkReleaseManifest(manifest,"1.2.3",new Map()));
assert.equal(sha256(new Uint8Array()),"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
console.log("release artifact tests ok");

assert.equal(checkReleaseManifest({...manifest,platforms:{"windows-x86_64":{...manifest.platforms["windows-x86_64"],url:"https://api.github.com/repos/o/r/releases/assets/42"}}},"1.2.3",assets,new Map([["https://api.github.com/repos/o/r/releases/assets/42","app.exe"]])),"app.exe");
