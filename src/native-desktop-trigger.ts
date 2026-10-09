import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import type { NativeDesktopTrigger } from "./persistent-service.js";

// The renderer forwards requests into the desktop's existing local daemon.
// No UI controls, account tokens, CLI host or model are created by this code.
export const RENDERER_BRIDGE = String.raw`(async function(){
  if(globalThis.__codexNativeQueueBridgeV1) return true;
  const mc=new MessageChannel(), pending=new Map(), markers=new Map(), outgoing=new Map();
  let sequence=0, openResolve, closed=false;
  const opened=new Promise(resolve=>openResolve=resolve);
  const marker=(sid,id)=>{if(typeof id==='string'&&/^wake-run-[a-f0-9-]{36}$/.test(id)){if(!markers.has(sid))markers.set(sid,new Set());markers.get(sid).add(id);}};
  mc.port1.onmessage=event=>{
    const frame=event.data;
    if(frame.kind==='open'){openResolve();return;}
    if(frame.kind==='close'){closed=true;for(const q of pending.values()){clearTimeout(q.timer);q.reject(Error('Native desktop transport closed'));}pending.clear();return;}
    if(frame.kind!=='message')return;
    let message=frame.json;try{message??=JSON.parse(frame.text);}catch{return;}
    if(message.type==='event'&&typeof message.channel==='string'&&message.channel.startsWith('session:event:')){
      const data=message.result||{},update=data.update||{},sid=data.sessionId||message.channel.slice(14);
      if(update.sessionUpdate==='user_message_chunk'){
        const meta=(data._meta||{})['codebuddy.ai']||{};
        for(const key of ['requestId','userMessageId','messageRequestId'])marker(sid,meta[key]);
        const content=Array.isArray(update.content)?update.content:[update.content];
        for(const item of content){if(item?.type==='text'&&typeof item.text==='string'){const match=item.text.match(/\[CODEX_QUEUE_WAKE (wake-run-[a-f0-9-]{36})\]/);if(match)marker(sid,match[1]);}}
      }
      return;
    }
    const q=pending.get(message.id);if(!q)return;pending.delete(message.id);clearTimeout(q.timer);
    if(message.type==='error')q.reject(Error(typeof message.error?.message==='string'?message.error.message:'Native RPC failed'));
    else q.resolve(message.result);
  };
  mc.port1.start();
  window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[mc.port2]);
  let openTimer;try{await Promise.race([opened,new Promise((_,reject)=>openTimer=setTimeout(()=>reject(Error('Native port open timed out')),10000))]);}finally{clearTimeout(openTimer);}
  const rpc=(channel,args,timeout=15000)=>new Promise((resolve,reject)=>{
    if(closed){reject(Error('Native desktop transport closed'));return;}
    const id='codex-native-'+(++sequence);
    const timer=timeout?setTimeout(()=>{pending.delete(id);reject(Error('Native RPC timed out: '+channel));},timeout):undefined;
    pending.set(id,{resolve,reject,timer});mc.port1.postMessage({kind:'message',json:{id,type:'request',channel,args}});
  });
  const inspect=async sid=>{
    const active=await rpc('daemon:getActiveSessions',[]);
    if(!Array.isArray(active))throw Error('Incompatible native activity response');
    const session=await rpc('session:get',[sid]);
    if(!session||!session.cwd)throw Error('Native worker session was not found');
    const waiting=session.pendingInputKind||(session.pendingPermissions?.length)||(session.pendingQuestions?.length)||(session.pendingElicitations?.length);
    if(waiting)return {state:'waiting_input',workspace:session.cwd,reason:'WorkBuddy requires native permission or input'};
    if(outgoing.has(sid)||active.some(s=>(s.sessionId||s.id)===sid||s.cwd===session.cwd)||session.isProcessing||session.stopRequested||session.hasActiveTeamMembers||session.hasActiveToolCalls)return {state:'busy',workspace:session.cwd,reason:'Native WorkBuddy session is active'};
    if(!['completed','failed','cancelled','idle','stopped'].includes(session.status))return {state:'busy',workspace:session.cwd,reason:'Native state is not confirmed idle: '+String(session.status)};
    return {state:'idle',workspace:session.cwd};
  };
  const findWake=async(sid,wakeId)=>{
    if(markers.get(sid)?.has(wakeId))return true;
    const session=await rpc('session:get',[sid]);
    await rpc('session:load',[sid,{cwd:session?.cwd,forceRendererHistoryReplay:true}]);
    return markers.get(sid)?.has(wakeId)===true;
  };
  const wakeIdle=async(sid,wakeId,prompt)=>{
    if(markers.get(sid)?.has(wakeId))return {accepted:true,receipt:wakeId};
    const state=await inspect(sid);
    if(state.state!=='idle'||outgoing.has(sid))return {accepted:false};
    // Lock before sending. Native sendMessage has no independent busy rejection.
    const operation={wakeId,error:undefined};outgoing.set(sid,operation);
    const meta={'codebuddy.ai':{requestId:wakeId,userMessageId:wakeId,messageRequestId:wakeId,emitSyntheticUserPromptLive:true}};
    rpc('session:sendMessage',[sid,[{type:'text',text:prompt}],meta],0).then(()=>outgoing.delete(sid),error=>{operation.error=error.message;outgoing.delete(sid);});
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      if(markers.get(sid)?.has(wakeId))return {accepted:true,receipt:wakeId};
      if(operation.error)throw Error(operation.error);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Native submission receipt is uncertain; do not automatically replay');
  };
  globalThis.__codexNativeQueueBridgeV1={inspect,findWake,wakeIdle};
  return true;
})()`;

interface CdpResponse { id?: number; error?: {message?: string}; result?: { result?: {value?: unknown}; exceptionDetails?: {text?: string;exception?: {description?: string}} } }

export interface NativeDesktopProcessControl {
  run(file: string, args: string[], timeoutMs: number): string;
  launch(executable: string, cdpPort: number): void;
  pause(milliseconds: number): Promise<void>;
}

const DEFAULT_PROCESS_CONTROL: NativeDesktopProcessControl = {
  run: (file,args,timeoutMs) => execFileSync(file,args,{encoding:"utf8",timeout:timeoutMs}),
  launch(executable,cdpPort) {
    const child=spawn(executable,[],{detached:true,stdio:"ignore",env:{...process.env,WORKBUDDY_REMOTE_DEBUGGING_PORT:String(cdpPort)}});
    child.on("error",()=>undefined);child.unref();
  },
  pause: milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds)),
};

function noProcessMatch(error: unknown): boolean {
  const failure=error as {status?:number;stdout?:unknown};
  return failure?.status===1&&String(failure.stdout??"").trim()==="";
}

export class NativeDesktopRpcTrigger implements NativeDesktopTrigger {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private connection?: Promise<void>;
  constructor(private readonly config: Config, readonly cdpPort: number, private readonly autoLaunch = true, private readonly processControl: NativeDesktopProcessControl = DEFAULT_PROCESS_CONTROL) {
    if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) throw new Error("Invalid native desktop CDP port");
  }

  private portState(): "absent" | "native" | "foreign" | "unavailable" {
    let output:string;
    try {
      output = this.processControl.run("/usr/sbin/lsof", ["-nP", `-iTCP:${this.cdpPort}`, "-sTCP:LISTEN", "-Fp"], 3000);
    } catch(error) { return noProcessMatch(error)?"absent":"unavailable"; }
    const pids = [...output.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1]));
    if(pids.length===0)return output.trim()===""?"absent":"unavailable";
    try {
      return pids.length === 1 && this.processControl.run("/bin/ps", ["-p", String(pids[0]), "-o", "comm="], 3000).trim() === path.resolve(this.config.cliElectronPath) ? "native" : "foreign";
    } catch {return "unavailable";}
  }

  private ownerIsNative(): boolean {
    return this.portState()==="native";
  }

  private nativePids(): number[] {
    const executable=path.resolve(this.config.cliElectronPath);
    const output = this.processControl.run("/bin/ps", ["-axo", "pid=,command="], 3000);
    return output.split("\n").flatMap(line => {const match=line.trim().match(/^(\d+)\s+(.+)$/);const command=match?.[2]??"";return match && (command===executable||command.startsWith(executable+" --"))&&!/--type=|--stdio|cli\/bin|sidecar-entry|daemon-app-server/.test(command) ? [Number(match[1])] : [];});
  }

  private rootPidExists(pid:number): boolean {
    try {return this.processControl.run("/bin/ps",["-p",String(pid),"-o","pid="],3000).trim()===String(pid);}
    catch(error){if(noProcessMatch(error))return false;throw error;}
  }

  private canEnablePortWithoutInterruptingWork(): boolean {
    let db:DatabaseSync|undefined;
    try {
      // Initial setup can be sent from a desktop without debugging enabled.
      // Wait for its configuration turn (and every other native task) to finish
      // before the one-time graceful restart needed for the startup setting.
      db=new DatabaseSync(path.join(this.config.workbuddyConfigDir,"workbuddy.db"),{readOnly:true});
      const rows=db.prepare("SELECT status FROM sessions WHERE deleted_at IS NULL").all();
      return rows.length>0&&rows.every(row=>['completed','failed','cancelled','idle','stopped','archived','terminated','error'].includes(String(row.status).trim().toLowerCase()));
    } catch {return false;} finally {db?.close();}
  }

  private async discover(): Promise<string> {
    const portState=this.portState();
    if(portState==="foreign"||portState==="unavailable")throw new Error("Registered local port is occupied by another process or its owner cannot be verified; WorkBuddy was left running");
    if (portState!=="native") {
      if (!this.autoLaunch) throw new Error("Native desktop is offline");
      const running=this.nativePids();
      if (running.length) {
        if(running.length!==1||!this.canEnablePortWithoutInterruptingWork())throw new Error("Waiting for native WorkBuddy tasks to finish before enabling its persistent local port");
        const rootPid=running[0]!;
        const current=this.nativePids();
        if(current.length!==1||current[0]!==rootPid||this.portState()!=="absent")throw new Error("Native WorkBuddy changed during setup; no restart was requested");
        // WorkBuddy's SIGTERM handler calls process.exit directly. The native
        // application quit event runs its ordinary before-quit teardown instead.
        this.processControl.run("/usr/bin/osascript",["-e",'tell application id "com.tencent.workbuddy.mac" to quit'],15000);
        for(let retry=0;retry<40&&this.rootPidExists(rootPid);retry++)await this.processControl.pause(250);
        if(this.rootPidExists(rootPid))throw new Error("Native WorkBuddy did not finish its graceful setup restart");
        if(this.nativePids().length)throw new Error("Another WorkBuddy root appeared during setup; no replacement was launched");
      }
      if(this.portState()!=="absent")throw new Error("Registered local port changed during setup; no replacement was launched");
      if (!fs.statSync(this.config.cliElectronPath).isFile()) throw new Error("WorkBuddy desktop executable is missing");
      this.processControl.launch(this.config.cliElectronPath,this.cdpPort);
      for (let retry=0;retry<60&&!this.ownerIsNative();retry++) await this.processControl.pause(250);
      if (!this.ownerIsNative()) throw new Error("Native WorkBuddy local RPC port did not become available");
    }
    const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`, {signal:AbortSignal.timeout(4000)});
    const targets = await response.json() as Array<{type?:string;url?:string;webSocketDebuggerUrl?:string}>;
    const executableRoot = path.resolve(this.config.cliElectronPath,"../../Resources/app.asar");
    const target = targets.find(item => item.type === "page" && item.url?.startsWith(`file://${executableRoot}/`) && !item.url.includes("splash") && item.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("WorkBuddy main renderer is not ready");
    const url = new URL(target.webSocketDebuggerUrl);
    if (!['127.0.0.1','localhost'].includes(url.hostname) || Number(url.port) !== this.cdpPort || url.protocol !== 'ws:') throw new Error("Native debugger target is not the registered loopback endpoint");
    return target.webSocketDebuggerUrl;
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connection) return this.connection;
    const connecting = (async () => {
      const socket = new WebSocket(await this.discover()); this.socket = socket;
      socket.addEventListener("message", event => {
        let frame:CdpResponse;try{frame=JSON.parse(String(event.data)) as CdpResponse;}catch{return;}
        if (!frame.id) return;
        const request=this.pending.get(frame.id);if(!request)return;this.pending.delete(frame.id);clearTimeout(request.timer);
        const exception=frame.result?.exceptionDetails;
        if(frame.error||exception)request.reject(new Error(frame.error?.message??exception?.exception?.description??exception?.text??"Native RPC evaluation failed"));
        else request.resolve(frame.result?.result?.value);
      });
      socket.addEventListener("close", () => {if(this.socket===socket)this.socket=undefined;for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error("Native desktop disconnected; submission outcome may be uncertain"));}this.pending.clear();});
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Native CDP connection timed out")),5000);socket.addEventListener("open",()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener("error",()=>{clearTimeout(timer);reject(new Error("Native CDP connection failed"));},{once:true});});
      await this.evaluateConnected(RENDERER_BRIDGE);
    })();
    this.connection=connecting;
    try { await connecting; } finally { if(this.connection===connecting)this.connection=undefined; }
  }

  private evaluateConnected(expression: string): Promise<unknown> {
    const socket=this.socket;if(socket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error("Native desktop socket is closed"));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("Native evaluation timed out; never replay an uncertain submission"));},22000);this.pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression,awaitPromise:true,returnByValue:true}}));});
  }

  private async call(method: "inspect"|"findWake"|"wakeIdle", args: string[]): Promise<unknown> {
    await this.connect();
    return this.evaluateConnected(`globalThis.__codexNativeQueueBridgeV1.${method}(...${JSON.stringify(args)})`);
  }
  async inspect(sessionId: string): ReturnType<NativeDesktopTrigger["inspect"]> {
    try { return await this.call("inspect",[sessionId]) as Awaited<ReturnType<NativeDesktopTrigger["inspect"]>>; }
    catch(error){return {state:"offline",reason:error instanceof Error?error.message:String(error)};}
  }
  async findWake(sessionId: string, wakeId: string): Promise<boolean> {return await this.call("findWake",[sessionId,wakeId])===true;}
  async wakeIdle(sessionId: string, wakeId: string, prompt: string): ReturnType<NativeDesktopTrigger["wakeIdle"]> {
    if(!/^wake-run-[a-f0-9-]{36}$/.test(wakeId)||!prompt.startsWith(`[CODEX_QUEUE_WAKE ${wakeId}]`))throw new Error("Wake identity must match its queue marker");
    return await this.call("wakeIdle",[sessionId,wakeId,prompt]) as Awaited<ReturnType<NativeDesktopTrigger["wakeIdle"]>>;
  }
  close(): void { this.socket?.close();this.socket=undefined; }
}

export function createNativeDesktopTrigger(config: Config, options: {cdpPort:number}): NativeDesktopRpcTrigger {
  return new NativeDesktopRpcTrigger(config,options.cdpPort);
}
