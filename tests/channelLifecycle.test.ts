import assert from "node:assert/strict";
import { createChannelLifecycle } from "../src/shell/channelLifecycle.ts";
const calls:string[]=[];let finish!:(value:string)=>void;
const controller=createChannelLifecycle({ipc:{join:(name)=>{calls.push(`join:${name}`);return new Promise(resolve=>{finish=resolve;});},leave:async name=>{calls.push(`leave:${name}`);return null;},syncActive:async()=>{},active:()=>"alpha"},setBusy:()=>{},beforeJoin:()=>{},beforeLeave:()=>{},mounted:name=>{calls.push(`mount:${name}`);},backgroundJoined:()=>{},left:name=>{calls.push(`left:${name}`);},cleared:()=>{},invalidName:()=>{},error:error=>{throw error;}});
const joining=controller.join("#Alpha");await controller.leave("alpha");assert.deepEqual(calls,["join:alpha"]);finish("alpha");await joining;await Promise.resolve();assert.deepEqual(calls,["join:alpha","mount:alpha","leave:alpha","left:alpha"]);
const pending=controller.join("beta");controller.dispose();finish("beta");await pending;assert.ok(!calls.includes("mount:beta"));
console.log("channel lifecycle tests ok");
