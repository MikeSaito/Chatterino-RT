export function createModerationDispatch(deps: {
  invoke:(command:string,args:Record<string,unknown>)=>Promise<unknown>;
  normalizeChannel:(channel:string)=>string|null;
  error:(error:unknown)=>void;
  alive:()=>boolean;
}) {
  let busy=false,disposed=false;
  async function run(command:string,args:Record<string,unknown>):Promise<void> {
    if(busy || disposed || !deps.alive())return;
    busy=true;
    try{await deps.invoke(command,args);}catch(error){if(!disposed && deps.alive())deps.error(error);}finally{busy=false;}
  }
  return {
    send(text:string,rawChannel:string){const channel=deps.normalizeChannel(rawChannel);return channel?run("chat_send",{text,replyToId:null,channel}):Promise.resolve();},
    automod(action:string,messageId:string,rawChannel:string){const channel=deps.normalizeChannel(rawChannel);return channel?run("chat_automod_manage",{action,msgId:messageId,channel}):Promise.resolve();},
    dispose(){disposed=true;},
  };
}
