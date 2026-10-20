import { canonical } from "./environment.mjs";
import { createServer } from "node:http";
import { windowsPowerShellEnv, powershellArgs } from "../powershell.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { connect, freePort, sleep } from "./cdp.mjs";
const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const profile=option("--profile")??"smoke";
assert.ok(["smoke","soak"].includes(profile));
const exe=resolve(option("--exe")??"src-tauri/target/release/tauri-app.exe");
assert.ok(existsSync(exe),"Build the validation app first, or supply --exe");
const output=resolve(option("--output")??`artifacts/desktop-${profile}-${Date.now()}.json`);
mkdirSync(resolve("artifacts"),{recursive:true});
const data=mkdtempSync(resolve("artifacts/validation-webview-"));
const port=await freePort();
const report={profile,exe,passed:false,build:option("--build")??createHash("sha256").update(readFileSync(exe)).digest("hex"),runs:[],error:null};
let processHandle,cdp;
const updateInstaller=option("--update-installer")?resolve(option("--update-installer")):null;
let updateServer,updateEndpoint,armed=false,updateDownloads=0;
if(updateInstaller) {
 assert.ok(existsSync(updateInstaller) && existsSync(`${updateInstaller}.sig`),"Signed validation update installer missing");
 const meta=spawnSync("powershell.exe",[...powershellArgs,"-File",resolve("scripts/release/metadata.ps1"),"-Path",updateInstaller],{encoding:"utf8",env:windowsPowerShellEnv(),windowsHide:true});
 assert.equal(meta.status,0,meta.stderr);report.update=JSON.parse(meta.stdout.replace(/^\uFEFF/,""));
 assert.equal(report.update.productName,"Chatterino RT Validation","Only validation packages may be used for the update test");
 updateServer=createServer((request,response)=>{
  if(request.url==="/installer.exe"){updateDownloads++;response.writeHead(200,{"Content-Type":"application/octet-stream"});response.end(readFileSync(updateInstaller));return;}
  if(request.url!=="/latest.json"){response.writeHead(404);response.end();return;}
  if(!armed){response.writeHead(204);response.end();return;}
  response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({version:report.update.version,platforms:{"windows-x86_64":{url:updateEndpoint.replace("latest.json","installer.exe"),signature:readFileSync(`${updateInstaller}.sig`,"utf8").trim()}}}));
 });
 await new Promise(resolve=>updateServer.listen(0,"127.0.0.1",resolve));
 updateEndpoint=`http://127.0.0.1:${updateServer.address().port}/latest.json`;
}
const invoke=(command,args={})=>cdp.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
async function launch() {
 processHandle=spawn(exe,[],{windowsHide:true,stdio:"ignore",env:{...process.env,...(updateEndpoint?{CHATTERINO_RT_UPDATER_ENDPOINT:updateEndpoint}:{}),WEBVIEW2_USER_DATA_FOLDER:data,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`}});
 let spawnError;processHandle.on("error",e=>{spawnError=e;});
 for(let i=0;i<120;i++) {
  if(spawnError)throw spawnError;
  if(processHandle.exitCode!==null)throw new Error(`Application exited (${processHandle.exitCode})`);
  try{cdp=await connect(port);break;}catch{await sleep(500);}
 }
 assert.ok(cdp,"WebView2 debugging endpoint not ready");
 for(let i=0;i<60;i++) {
  if(await cdp.evaluate("typeof window.__TAURI_INTERNALS__?.invoke==='function'"))break;
  await sleep(500);
 }
 if(!await cdp.evaluate("typeof window.__TAURI_INTERNALS__?.invoke==='function'")) {
  report.startup=await cdp.evaluate("({url:location.href,title:document.title,state:document.readyState,body:document.body?.innerText.slice(0,1000)})");
  throw new Error("Tauri initialization script missing: "+JSON.stringify(report.startup));
 }
 const sourceInfo=await invoke("validation_status");
 if(profile==="soak"){assert.equal(sourceInfo.releaseBuild,true,"Hardware baselines require a release validation build");assert.equal(sourceInfo.dirty,false,"Hardware baselines require committed source");}
 report.revision=sourceInfo.revision;report.dirty=sourceInfo.dirty; // Verify isolation before changing storage or UI.
 const debug=await cdp.evaluate("Boolean(window.__crt)");
 if(!debug){await cdp.evaluate("localStorage.setItem('crt-debug','1');location.reload();true");cdp.close();cdp=null;await sleep(1000);for(let i=0;i<60;i++){try{cdp=await connect(port);if(await cdp.evaluate("Boolean(window.__crt?.resources)"))break;cdp.close();cdp=null;}catch{}await sleep(500);}}
 assert.ok(cdp && await cdp.evaluate("Boolean(window.__crt?.resources)"),"renderer did not initialize");
}
async function quit() {
 if(cdp){try{await invoke("validation_quit");}catch{}cdp.close();cdp=null;}
 if(processHandle){for(let i=0;i<40 && processHandle.exitCode===null;i++)await sleep(100);if(processHandle.exitCode===null)processHandle.kill();processHandle=null;}
}
async function waitSource(seconds) {
 for(let i=0;i<(seconds+30)*2;i++) {if(processHandle.exitCode!==null)throw new Error("Application crashed");const status=await invoke("validation_status");if(!status.running)return status;await sleep(500);}
 throw new Error("Validation source did not finish");
}
function memory(fingerprint=false){const result=spawnSync("powershell.exe",[...powershellArgs,"-File",resolve("scripts/desktop/process-metrics.ps1"),"-RootPid",String(processHandle.pid),...(fingerprint?["-Fingerprint"]:[])],{encoding:"utf8",windowsHide:true,timeout:15000,env:windowsPowerShellEnv()});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.replace(/^\uFEFF/,""));}
async function joinChannel(){await cdp.evaluate(`(()=>{const input=document.querySelector('#channel-input');input.value='validation';document.querySelector('#join-form').requestSubmit();return true;})()`);for(let i=0;i<120;i++){if(await cdp.evaluate("!document.querySelector('#composer-input').disabled && document.querySelector('#channel-input').value==='validation'"))return;await sleep(250);}throw new Error("Real chat_join did not finish");}
async function load(rate,seconds,scrolling) {
 await cdp.evaluate("window.__crt.performance.start();true");
 const before=memory(); const samples=[before];
 if(scrolling)await cdp.evaluate("window.__validationScroll=setInterval(()=>{const r=window.__crt.ring;const s=r.scrollSnapshot();r.setDesired(s.current>20?s.current-10:s.bottom);},500);true");
 await invoke("validation_start",{rate,seconds,animated:true});
 let status;
 const deadline=Date.now()+(seconds+60)*1000;
 do{await sleep(1000);status=await invoke("validation_status");if(samples.length===1 || samples.length<Math.floor((Date.now()-(deadline-(seconds+60)*1000))/5000)+1)samples.push(memory());if(Date.now()>deadline)throw new Error("Source timeout");}while(status.running);
 await sleep(500);
 const final=await cdp.evaluate("(()=>{clearInterval(window.__validationScroll);return {performance:window.__crt.performance.stop(),resources:window.__crt.resources()};})()");
 samples.push(memory());
 assert.equal(status.generated,rate*seconds);assert.equal(status.failed,0);assert.equal(status.delivered,status.generated);assert.equal(final.performance.messages,status.generated,"messages lost after native IPC");assert.ok(final.resources.animatedSets>0,"animated fixture was not decoded");assert.equal(cdp.errors.length,0,cdp.errors.join("\n"));
 const environment=memory(true).environment;
 const display=await cdp.evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})");
 const environmentId=createHash("sha256").update(JSON.stringify(canonical({environment,display,settings:await invoke("settings_get"),fixture:createHash("sha256").update(readFileSync("src-tauri/fixtures/animated-emote.gif")).digest("hex"),profile}))).digest("hex");
 return {environment:environmentId,environmentDetails:{...environment,display},build:report.build,revision:report.revision,dirty:report.dirty,scenario:rate===50?"50-emotes":scrolling?"200-scroll-emotes":"200-emotes",generated:status.generated,processed:final.performance.messages,crashed:false,warmupSeconds:profile==="soak"?120:0,measurementSeconds:seconds,metrics:{processingP95Ms:final.performance.processing.p95Ms,frameP95Ms:final.performance.frames.p95Ms,longFrameRatio:final.performance.longFrames/Math.max(1,final.performance.frames.count),privateBytes:Math.max(...samples.map(s=>s.privateBytes)),memoryGrowthBytes:samples[samples.length-1].privateBytes-before.privateBytes},samples,renderer:final.resources,gpuBytes:null};
}
try {
 await launch();await joinChannel();
 const settings=await invoke("settings_get");settings.timestampFormat="hh:mm:ss";await invoke("settings_set",{settings});
 await cdp.evaluate("(()=>{const input=document.querySelector('#composer-input');input.value='validation draft Привет';input.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new Event('blur'));return true;})()");
 await quit();await launch();await joinChannel();
 assert.equal(await cdp.evaluate("document.querySelector('#composer-input').value"),"validation draft Привет","draft did not survive actual process restart");
 assert.equal((await invoke("settings_get")).timestampFormat,"hh:mm:ss","native settings did not survive restart");
 assert.ok((await invoke("session_get")).open.includes("validation"),"native session did not survive restart");
 const scenarios=profile==="soak"?[[50,false],[200,false],[200,true]]:[[50,false]];
 for(const [rate,scrolling]of scenarios){
  if(profile==="soak"){await invoke("validation_start",{rate,seconds:120,animated:true});await waitSource(120);}
  report.runs.push(await load(rate,profile==="soak"?1800:3,scrolling));
 }
 if(updateInstaller) {
  const current=await invoke("updater_status",{beta:false});
  assert.notEqual(current.currentVersion,report.update.version,"Update test requires two different installed versions");
  armed=true;
  const found=await invoke("updater_check",{beta:false});assert.equal(found.version,report.update.version);
  report.update.previousVersion=current.currentVersion;
  try{await invoke("updater_install",{expectedVersion:found.version});}catch(error){if(!String(error).includes("disconnected") && !String(error).includes("CDP timeout"))throw error;}
  cdp.close();cdp=null;
  for(let i=0;i<120;i++) {
   const meta=spawnSync("powershell.exe",[...powershellArgs,"-File",resolve("scripts/release/metadata.ps1"),"-Path",exe],{encoding:"utf8",env:windowsPowerShellEnv(),windowsHide:true});
   if(meta.status===0 && JSON.parse(meta.stdout.replace(/^\uFEFF/,"")).version===report.update.version)break;
   await sleep(500);
  }
  assert.ok(updateDownloads>0,"Updater did not fetch the local installer");
  try{cdp=await connect(port);}catch{}
  if(!cdp)await launch();
  for(let i=0;i<60;i++){try{if((await invoke("updater_status",{beta:false})).currentVersion===report.update.version)break;}catch{}await sleep(500);}
  assert.equal((await invoke("updater_status",{beta:false})).currentVersion,report.update.version);
  await joinChannel();
  assert.equal(await cdp.evaluate("document.querySelector('#composer-input').value"),"validation draft Привет","draft lost during installed update");
  assert.equal((await invoke("settings_get")).timestampFormat,"hh:mm:ss","settings lost during installed update");
  assert.ok((await invoke("session_get")).open.includes("validation"),"channels lost during installed update");
  report.update.passed=true;
 }
 report.passed=true;console.log(`Native ${profile} checks passed: ${report.runs.map(r=>r.scenario).join(', ')}`);
}catch(error){report.error=String(error);process.exitCode=1;console.error(error);}
finally{await quit();if(updateServer)await new Promise(resolve=>updateServer.close(resolve));writeFileSync(output,JSON.stringify(report,null,2)+"\n");console.log(`Report: ${output}`);}
