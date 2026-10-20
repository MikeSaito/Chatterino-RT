import { normalizeChannelInput } from "./channelName.ts";
import type { ChatIpc } from "../chat/ipc";
type Operation = {kind:"join"|"leave"|"sync";name:string;focus?:boolean};
export function createChannelLifecycle(deps: {
  ipc: Pick<ChatIpc,"join"|"leave"|"syncActive"|"active">;
  setBusy: (busy:boolean)=>void;
  beforeJoin: ()=>void;
  beforeLeave: ()=>void;
  mounted: (channel:string)=>void;
  backgroundJoined: (channel:string)=>void;
  left: (channel:string,next:string|null,wasActive:boolean)=>void;
  cleared: ()=>void;
  invalidName: ()=>void;
  error: (error:unknown)=>void;
}) {
  let busy=false,disposed=false;
  const queue:Operation[]=[];
  async function run(op:Operation):Promise<void> {
    if(disposed)return;
    if(busy){queue.push(op);return;}
    busy=true;deps.setBusy(true);
    try {
      if(op.kind==="join") {
        deps.beforeJoin();
        const joined=await deps.ipc.join(op.name,op.focus!==false);
        if(disposed)return;
        if(op.focus!==false)deps.mounted(joined);else deps.backgroundJoined(joined);
      } else if(op.kind==="leave") {
        deps.beforeLeave();
        const wasActive=deps.ipc.active()===op.name;
        const next=await deps.ipc.leave(op.name);
        if(!disposed)deps.left(op.name,next,wasActive);
      } else {
        await deps.ipc.syncActive(op.name||null);
        if(!disposed){if(op.name)deps.mounted(op.name);else deps.cleared();}
      }
    }catch(error){if(!disposed)deps.error(error);}
    finally {
      busy=false;
      if(!disposed){deps.setBusy(false);const next=queue.shift();if(next)void run(next);}
    }
  }
  return {
    get busy(){return busy;},
    join(raw:string,focus=true){const name=normalizeChannelInput(raw);if(!name){if(!disposed)deps.invalidName();return Promise.resolve();}return run({kind:"join",name,focus});},
    leave(raw:string){const name=raw.trim();return name?run({kind:"leave",name}):Promise.resolve();},
    sync(name:string){return run({kind:"sync",name});},
    dispose(){disposed=true;queue.length=0;},
  };
}
