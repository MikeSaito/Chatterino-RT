import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename } from "node:path";

export type ReleaseManifest = { version: string; platforms: Record<string, { url: string; signature: string }> };
export function checkReleaseManifest(manifest: ReleaseManifest, version: string, assets: Map<string, Uint8Array>, releaseUrls: Map<string, string> = new Map()): string {
  assert.equal(manifest.version.replace(/^v/, ""), version, "manifest version differs from release");
  assert.ok(manifest.platforms && typeof manifest.platforms === "object", "missing platforms");
  for (const entry of Object.values(manifest.platforms)) {
    assert.equal(new URL(entry.url).protocol, "https:", "updater URL must use HTTPS");
    assert.ok(typeof entry.signature === "string" && entry.signature.trim(), "missing signature");
  }
  const entry = manifest.platforms["windows-x86_64"];
  assert.ok(entry, "missing Windows x64 update");
  const filename = releaseUrls.get(entry.url) ?? decodeURIComponent(basename(new URL(entry.url).pathname));
  assert.ok(filename.endsWith(".exe"), "Windows updater must reference the NSIS installer");
  assert.ok(assets.has(filename), "updater installer is absent from release assets");
  const signature = assets.get(`${filename}.sig`);
  assert.ok(signature, "installer signature file missing");
  assert.equal(new TextDecoder().decode(signature).trim(), entry.signature.trim(), "manifest and signature file differ");
  return filename;
}
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
