/** Windows PowerShell must not inherit PowerShell 7's incompatible module paths. */
export const windowsPowerShellEnv = () => {
  const env={...process.env};
  for(const key of Object.keys(env)) if(key.toLowerCase()==="psmodulepath") delete env[key];
  return env;
};
export const powershellArgs = ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass"];
