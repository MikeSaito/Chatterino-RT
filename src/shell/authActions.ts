import type { AuthInfo } from "../chat/types";
export type AuthOperation = "idle" | "start" | "import" | "logout";
export function createAuthActions(deps: {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  alive: () => boolean;
  auth: () => AuthInfo;
  apply: (info: AuthInfo) => void;
  refresh: (message?: string) => Promise<void>;
  formatError: (error: unknown) => string;
  reportError: (message: string) => void;
  paste: Pick<HTMLInputElement, "value">;
  disable: (operation: Exclude<AuthOperation,"idle">) => void;
  clearClipboard: () => Promise<void>;
}) {
  let operation: AuthOperation="idle";
  let generation=0;
  let disposed=false;
  const alive=(expected: number)=>!disposed && deps.alive() && generation===expected;
  async function run(next: Exclude<AuthOperation,"idle">) {
    if(disposed || !deps.alive()) return;
    const expected=++generation;
    operation=next;deps.disable(next);
    try {
      await deps.invoke(`auth_${next}`,next==="import"?{blob:deps.paste.value}:undefined);
      if(!alive(expected))return;
      if(next==="import") {deps.paste.value="";try {await deps.clearClipboard();}catch{/* Clipboard access is optional. */}}
      if(alive(expected))await deps.refresh();
    } catch(error) {
      if(!alive(expected))return;
      if(next==="logout")deps.reportError(deps.formatError(error));
      try {await deps.refresh(next==="logout"?undefined:deps.formatError(error));}
      catch {if(alive(expected) && next!=="logout")deps.apply({...deps.auth(),message:deps.formatError(error)});}
    } finally {
      if(alive(expected)){operation="idle";deps.apply(deps.auth());}
    }
  }
  return {get operation(){return operation;},start:()=>run("start"),import:()=>run("import"),logout:()=>run("logout"),dispose:()=>{disposed=true;generation++;}};
}
