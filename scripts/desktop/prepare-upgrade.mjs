import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve,join } from "node:path";
import assert from "node:assert/strict";
const output=resolve("artifacts/validation-upgrade");mkdirSync(output,{recursive:true});
const cli=resolve("node_modules/@tauri-apps/cli/tauri.js"),key=join(output,"test-only.key");
function run(args,options={}){const r=spawnSync(process.execPath,[cli,...args],{windowsHide:true,...options});assert.equal(r.status,0,`Tauri command failed: ${args[0]}`);}
// Never print key-generation output; only this test app trusts this disposable key.
if(!existsSync(key))run(["signer","generate","--ci","--password","","--write-keys",key],{stdio:"pipe"});
const publicKey=readFileSync(`${key}.pub`,"utf8").trim();
const base=JSON.parse(readFileSync("src-tauri/tauri.validation.conf.json","utf8"));
for(const version of ["1.1.6","1.1.7"]) {
 const config={...base,version,plugins:{...base.plugins,updater:{...base.plugins.updater,pubkey:publicKey}}};
 const configFile=join(output,`config-${version}.json`);writeFileSync(configFile,JSON.stringify(config,null,2));
 run(["build","--features","validation","--config",configFile,"--debug"],{stdio:"inherit"});
 const installer=join(output,`validation-${version}.exe`);
 copyFileSync(resolve(`src-tauri/target/debug/bundle/nsis/Chatterino RT Validation_${version}_x64-setup.exe`),installer);
 if(version==="1.1.7")run(["signer","sign","--private-key-path",key,"--password","","--app-version",version,installer],{stdio:"pipe"});
}
console.log(`Validation upgrade packages prepared in ${output}`);
