import assert from "node:assert/strict";
import { bodyIndexAt, inside, type BodyHitRow } from "../src/chat/rowHitTest.ts";
const row:BodyHitRow={systemCloudBounds:null,body:{y:0},replyRows:1,wrapLineHeights:[20,40],wrapLines:[{start:0,end:3},{start:3,end:6}],bodyIndent:5,bodyContIndent:2,bodyRaw:"abcdef",spansRaw:[]};
const options={lineHeight:20,fontSize:16,bodyHeight:()=>60,wrapOptions:()=>({measureAdvance:(s:string)=>s.length})};
assert.equal(bodyIndexAt(row,6,21,options),1);assert.equal(bodyIndexAt(row,3,65,options),4);
assert.equal(bodyIndexAt(row,1,65,options),null);assert.equal(bodyIndexAt(row,6,19,options),null);assert.equal(bodyIndexAt(row,6,80,options),null);
assert.equal(inside({x:1,y:2,w:3,h:4},4,3),false);assert.equal(inside({x:1,y:2,w:3,h:4},3,3),true);
console.log("row hit-test tests ok");
