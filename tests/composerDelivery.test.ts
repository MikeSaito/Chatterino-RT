import assert from "node:assert/strict";
import { completeComposerSend } from "../src/shell/composerDelivery.ts";
import { Workspace } from "../src/shell/workspace.ts";
import { SendStatus, type SendResult } from "../src/shell/sendStatus.ts";
for (const scenario of ["active", "switched", "edited", "closed", "disposed"] as const) {
 const workspace = new Workspace({getItem: () => null, setItem: () => {}}, () => 1, () => {});
 workspace.putDraft("alpha", {text:"original",reply:null,start:0,end:8});
 const draft = workspace.draft("alpha");
 let finish!: (value: SendResult) => void;
 const status = new SendStatus(() => new Promise(resolve => { finish=resolve; }), () => {});
 let accepted=0, saves=0, paints=0;
 const task = completeComposerSend("alpha",draft,{status,workspace,alive:()=>scenario!=="disposed",isClosed:()=>scenario==="closed",activeChannel:()=>scenario==="switched"?"beta":"alpha",saveDraft:()=>{saves++;if(scenario==="edited") workspace.putDraft("alpha",{text:"new",reply:null,start:0,end:3});},acceptedActive:()=>{accepted++;},paintStatus:()=>{paints++;},syncComposer:()=>{}});
 finish({status:"sent"}); await task;
 assert.equal(accepted,scenario==="active"?1:0);
 assert.equal(saves,scenario==="disposed"?0:1);
 assert.equal(paints,scenario==="disposed"?0:1);
 assert.equal(workspace.draft("alpha").text, scenario==="edited"?"new":scenario==="closed"||scenario==="disposed"?"original":"");
 if(scenario==="closed") assert.equal(status.get("alpha"),undefined);
}
console.log("composer delivery lifecycle tests ok");
