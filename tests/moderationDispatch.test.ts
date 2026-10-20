import assert from "node:assert/strict";
import { createModerationDispatch } from "../src/shell/moderationDispatch.ts";
let finish!:()=>void;const calls:{command:string;args:Record<string,unknown>}[]=[];
const dispatcher=createModerationDispatch({invoke:(command,args)=>{calls.push({command,args});return new Promise<void>(resolve=>{finish=resolve;});},normalizeChannel:name=>name.trim()||null,error:error=>{throw error;},alive:()=>true});
const sending=dispatcher.send("/ban viewer","alpha");await dispatcher.automod("allow","held","beta");assert.equal(calls.length,1);assert.equal(calls[0].args.channel,"alpha");finish();await sending;
const moderating=dispatcher.automod("allow","held","beta");assert.equal(calls[1].args.channel,"beta");finish();await moderating;dispatcher.dispose();await dispatcher.send("text","alpha");assert.equal(calls.length,2);
console.log("moderation dispatch tests ok");
