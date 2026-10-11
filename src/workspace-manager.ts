import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { NativeDesktopRpcTrigger } from "./native-desktop-trigger.js";
import { readServiceRegistration, registeredServiceConfig } from "./persistent-service.js";
import { installService } from "./service-cli.js";
import { WorkspaceWorkers, readWorkspaceWorkers } from "./workspace-workers.js";
import { readDesktopSession } from "./desktop-runtime.js";

export function workerRegistration(config: Config) {
  const file = config.serviceConfigFile??path.join(path.dirname(config.dbFile),"persistent-service.json");
  const registration = readServiceRegistration(file);
  if(registration && path.resolve(registration.dbFile)!==path.resolve(config.dbFile))throw new Error("The persistent service uses another task database; fix the bridge configuration before connecting projects");
  return registration;
}
export async function ensureWorkspace(config: Config, input: {workspace:string;sessionId?:string;title?:string}) {
  if(config.backend!=="desktop-queue")throw new Error("Automatic native workspaces require desktop-queue");
  const registration=workerRegistration(config);
  const bound=registration?registeredServiceConfig(config,registration):config;
  const workers=new WorkspaceWorkers(bound);
  const trigger=new NativeDesktopRpcTrigger(bound,registration?.cdpPort??18491);
  try {
    if(registration)workers.seed(registration);
    const result=await workers.ensure(input,trigger);
    if(!registration) {
      const projectDir=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      installService({config,projectDir,workspace:result.worker.workspace,sessionId:result.worker.sessionId,cdpPort:18491});
    }
    return {ok:true,...result,workspace:result.worker.workspace,sessionId:result.worker.sessionId,next:"Pass this workspace to send_task; the persistent service routes and wakes its native WorkBuddy session automatically."};
  } finally {workers.close();trigger.close();}
}
export function listWorkspaces(config: Config) {
  const registration=workerRegistration(config);
  const bound=registration?registeredServiceConfig(config,registration):config;
  return readWorkspaceWorkers(bound,registration).map(worker=>({...worker,desktopRegistered:readDesktopSession(bound.workbuddyConfigDir,worker.sessionId).registered}));
}
