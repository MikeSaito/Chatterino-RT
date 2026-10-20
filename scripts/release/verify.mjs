import { windowsPowerShellEnv, powershellArgs } from "../powershell.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { checkReleaseManifest, sha256 } from "../releaseArtifact.ts";

async function fetchRetry(url, options={}) {
 let last;
 for(let attempt=0;attempt<3;attempt++) {
  try { const response=await fetch(url,{...options,signal:AbortSignal.timeout(30000)}); if(response.ok || response.status<500 && response.status!==429) return response;last=new Error(`HTTP ${response.status}`); }
  catch(error){last=error;}
  await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
 }
 throw last;
}
const args = process.argv.slice(2);
const argument = name => { const i=args.indexOf(name); return i<0 ? undefined : args[i+1]; };
const tag = argument("--tag");
const publicCheck = args.includes("--public");
const directory = resolve(argument("--directory") ?? "artifacts/release-check");
const repo = process.env.GITHUB_REPOSITORY ?? "MikeSaito/Chatterino-RT";
if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !tag || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error("Usage: --tag vX.Y.Z [--public] [--directory path]");
mkdirSync(directory,{recursive:true});
const report = { tag, repository:repo, public:publicCheck, passed:false, files:[], error:null };
try {
 const headers = { Accept:"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28" };
 if (!publicCheck && process.env.GITHUB_TOKEN) headers.Authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
 const response = await fetchRetry(`https://api.github.com/repos/${repo}/releases/tags/${tag}`,{headers});
 if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
 const release = await response.json();
 assert.equal(release.tag_name,tag);
 if(publicCheck) assert.equal(release.draft,false,"release is still a draft");
 writeFileSync(join(directory,"release.json"),JSON.stringify(release,null,2)+"\n");
 const assets = new Map();
 const releaseUrls = new Map();
 for(const asset of release.assets) {
  if(!/\.(exe|msi|sig)$/.test(asset.name) && asset.name!=="latest.json") continue;
  assert.equal(basename(asset.name),asset.name,"invalid asset filename");
  assert.ok(!assets.has(asset.name),"duplicate release asset");
  const url = publicCheck ? asset.browser_download_url : asset.url;
  const parsed = new URL(url);
  assert.equal(parsed.protocol,"https:");
  assert.equal(parsed.hostname,publicCheck?"github.com":"api.github.com");
  const result = await fetchRetry(url,{headers: publicCheck ? {} : {...headers,Accept:"application/octet-stream"}});
  if(!result.ok) throw new Error(`Download failed for ${asset.name}: ${result.status}`);
  releaseUrls.set(asset.url,asset.name);
  releaseUrls.set(asset.browser_download_url,asset.name);
  const bytes = new Uint8Array(await result.arrayBuffer());
  assert.equal(bytes.length,asset.size,"download size differs from GitHub metadata");
  if(asset.digest)assert.equal(`sha256:${sha256(bytes)}`,asset.digest,"download checksum differs from GitHub metadata");
  assets.set(asset.name,bytes); writeFileSync(join(directory,asset.name),bytes);
 }
 assert.ok(assets.has("latest.json"),"latest.json missing");
 const manifest = JSON.parse(new TextDecoder().decode(assets.get("latest.json")));
 const installer = checkReleaseManifest(manifest,tag.slice(1),assets,releaseUrls);
 assert.equal(releaseUrls.get(manifest.platforms["windows-x86_64"].url),installer,"manifest points outside this release");
 for(const entry of Object.values(manifest.platforms)) {
  const referenced=releaseUrls.get(entry.url);
  assert.ok(referenced && assets.has(referenced),"platform points outside this release");
  assert.equal(entry.signature.trim(),new TextDecoder().decode(assets.get(`${referenced}.sig`)).trim(),"platform signature differs from release");
 }
 const verifier = spawnSync("cargo",["build","--manifest-path","src-tauri/Cargo.toml","--example","verify-updater","--locked"],{stdio:"inherit"});
 assert.equal(verifier.status,0,"cannot build updater signature verifier");
 for(const [name,bytes] of assets) {
  if(/\.(exe|msi)$/.test(name)) {
   assert.ok(assets.has(`${name}.sig`),`missing updater signature: ${name}`);
   const verified = spawnSync(resolve("src-tauri/target/debug/examples/verify-updater.exe"),[join(directory,name),join(directory,`${name}.sig`)],{stdio:"inherit"});
   assert.equal(verified.status,0,`invalid updater signature: ${name}`);
   const meta=spawnSync("powershell.exe",[...powershellArgs,"-File",resolve("scripts/release/metadata.ps1"),"-Path",join(directory,name)],{encoding:"utf8",env:windowsPowerShellEnv()});
   assert.equal(meta.status,0,meta.stderr);
   const metadata=JSON.parse(meta.stdout.replace(/^\uFEFF/,""));
   const numericVersion=tag.slice(1).split("-")[0];
   assert.ok(metadata.version===numericVersion || metadata.version===`${numericVersion}.0`,`${name}: embedded version ${metadata.version} differs from ${tag}`);
   assert.ok(["Valid","NotSigned"].includes(metadata.authenticode),`${name}: invalid Authenticode signature (${metadata.authenticode})`);
   report.files.push({name,sha256:sha256(bytes),...metadata});
  }
 }
 assert.ok(report.files.length>0,"no installer checked");
 if(process.env.CRT_REQUIRE_AUTHENTICODE==="true" || report.files.some(file=>file.authenticode==="Valid")) {
  assert.ok(report.files.every(file=>file.authenticode==="Valid"),"all installers must have valid Authenticode when code signing is enabled");
 }
 if(publicCheck && !release.prerelease) {
  const latest=await fetchRetry(`https://github.com/${repo}/releases/latest/download/latest.json`,{cache:"no-store"});
  assert.equal(latest.status,200,"public latest update URL unavailable");
  assert.deepEqual(await latest.json(),manifest,"public update endpoint differs from this release");
 }
 writeFileSync(join(directory,"SHA256SUMS.txt"),report.files.map(f=>`${f.sha256}  ${f.name}`).join("\n")+"\n");
 if(publicCheck) {
  const updateResponse=await fetchRetry(manifest.platforms["windows-x86_64"].url,{headers:{Accept:"application/octet-stream"}});
  assert.equal(updateResponse.status,200,"public updater artifact unavailable");
  report.updaterDownloadSha256=sha256(new Uint8Array(await updateResponse.arrayBuffer()));
  assert.equal(report.updaterDownloadSha256,sha256(assets.get(installer)),"public updater download differs from verified installer");
 }
 report.passed=true;
 console.log(`Verified ${report.files.length} installers for ${tag}`);
} catch(error) { report.error=String(error); process.exitCode=1; console.error(error); }
finally { writeFileSync(join(directory,"verification.json"),JSON.stringify(report,null,2)+"\n"); }
