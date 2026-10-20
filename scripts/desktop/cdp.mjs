import { createServer } from "node:net";
export const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
export async function freePort() {
 const server=createServer(); await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
 const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}
export async function connect(port) {
 const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(5000)});
 const targets=await response.json();
 const page=targets.find(t=>t.type==="page" && (t.url==="https://tauri.localhost/" || t.url==="https://tauri.localhost/index.html"));
 if(!page) throw new Error("Application main WebView not ready");
 const socket=new WebSocket(page.webSocketDebuggerUrl); let id=0; const pending=new Map(); const errors=[];
 socket.onmessage=event=>{const value=JSON.parse(event.data);if(value.id) {const entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);clearTimeout(entry.timer);value.error?entry.reject(new Error(JSON.stringify(value.error))):entry.resolve(value.result);}else if(value.method==="Runtime.exceptionThrown")errors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);};
 const fail=()=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error("Application WebView disconnected"));}pending.clear();};
 socket.onclose=fail;
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 const command=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;const timer=setTimeout(()=>{pending.delete(next);reject(new Error(`CDP timeout: ${method}`));},15000);pending.set(next,{resolve,reject,timer});socket.send(JSON.stringify({id:next,method,params}));});
 await command("Runtime.enable");
 const evaluate=async expression=>{const result=await command("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;};
 return {command,evaluate,errors,close:()=>socket.close()};
}
