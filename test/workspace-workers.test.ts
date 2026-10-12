import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { WorkspaceWorkers, readWorkspaceWorkers, type NativeWorkerCreator } from "../src/workspace-workers.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal, writePrivateJson } from "../src/run-journal.js";
import { pumpWorkspaceWorkers, type ServiceRegistration } from "../src/persistent-service.js";

function fixture(t: {after(fn:()=>void):void}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbuddy-project-routing-'));
  const a=path.join(dir,'Project A'),b=path.join(dir,'项目 B');fs.mkdirSync(a);fs.mkdirSync(b);
  const config:Config={...loadConfig(),backend:'desktop-queue',dbFile:path.join(dir,'tasks.sqlite'),runsDir:path.join(dir,'runs'),workbuddyConfigDir:dir,serviceConfigFile:path.join(dir,'persistent-service.json')};
  const native=new DatabaseSync(path.join(dir,'workbuddy.db'));
  native.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)');
  const register=(id:string,workspace:string)=>native.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,0,NULL)').run(id,workspace);
  const registry=new WorkspaceWorkers(config);
  const calls:Array<{id:string;workspace:string}>=[];
  const creator:NativeWorkerCreator={async createWorker(workspace,sessionId){calls.push({id:sessionId,workspace});register(sessionId,workspace);return{sessionId,workspace};}};
  t.after(()=>{registry.close();native.close();fs.rmSync(dir,{recursive:true,force:true});});
  return{dir,a,b,config,native,register,registry,calls,creator};
}

test('independent projects create separate native sessions; reuse survives registry reconnect',async t=>{
  const f=fixture(t);
  const a=await f.registry.ensure({workspace:f.a},f.creator),b=await f.registry.ensure({workspace:f.b},f.creator);
  assert.equal(a.created,true);assert.equal(b.created,true);assert.notEqual(a.worker.sessionId,b.worker.sessionId);
  const reconnect=new WorkspaceWorkers(f.config);
  try {const reused=await reconnect.ensure({workspace:f.a},f.creator);assert.equal(reused.created,false);assert.equal(reused.worker.sessionId,a.worker.sessionId);}finally{reconnect.close();}
  assert.equal(f.calls.length,2);
});

test('selection retains the old worker for already queued tasks and rejects a different native directory',async t=>{
  const f=fixture(t),a=await f.registry.ensure({workspace:f.a},f.creator);
  f.register('selected-existing',f.a);f.register('wrong-directory',f.b);
  const selected=await f.registry.ensure({workspace:f.a,sessionId:'selected-existing'},f.creator);
  assert.equal(selected.worker.sessionId,'selected-existing');assert.equal(selected.created,false);
  assert.equal(f.registry.list().find(w=>w.sessionId===a.worker.sessionId)?.selected,false);
  assert.equal(f.registry.list().find(w=>w.sessionId===a.worker.sessionId)?.state,'ready');
  await assert.rejects(()=>f.registry.ensure({workspace:f.a,sessionId:'wrong-directory'},f.creator),/differs/);
  assert.equal(f.registry.selected(f.a)?.sessionId,'selected-existing');
});

test('two clients preparing one workspace cannot create duplicate sessions',async t=>{
  const f=fixture(t);let resume!:()=>void;
  const gate=new Promise<void>(resolve=>{resume=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const creating=f.registry.ensure({workspace:f.a},{async createWorker(workspace,sessionId){entered();await gate;return f.creator.createWorker(workspace,sessionId);}});
  await started;
  const other=new WorkspaceWorkers(f.config);
  try {await assert.rejects(()=>other.ensure({workspace:f.a},f.creator),/in progress or uncertain/);}finally{other.close();}
  resume();await creating;assert.equal(f.calls.length,1);
});

test('an uncertain native submission is never recreated; an eventual native record can be reconciled',async t=>{
  const f=fixture(t);let id='';let calls=0;
  await assert.rejects(()=>f.registry.ensure({workspace:f.a},{async createWorker(workspace,sessionId){id=sessionId;calls++;throw Error('connection lost after submission');}}),/connection lost/);
  assert.equal(f.registry.selected(f.a)?.state,'uncertain');
  await assert.rejects(()=>f.registry.ensure({workspace:f.a},f.creator),/uncertain/);
  assert.equal(f.calls.length,0);assert.equal(calls,1);
  f.register(id,f.a);const reconciled=await f.registry.ensure({workspace:f.a},f.creator);
  assert.equal(reconciled.created,false);assert.equal(reconciled.worker.sessionId,id);assert.equal(reconciled.worker.state,'ready');
});

test('a newer explicit selection is not overwritten when an older creation completes',async t=>{
  const f=fixture(t);
  await assert.rejects(()=>f.registry.ensure({workspace:f.a},{async createWorker(workspace,sessionId){
    f.register('new-choice',workspace);await f.registry.ensure({workspace,sessionId:'new-choice'},f.creator);
    return f.creator.createWorker(workspace,sessionId);
  }}),/selection changed/);
  assert.equal(f.registry.selected(f.a)?.sessionId,'new-choice');assert.equal(f.registry.list().length,2);
});

test('read-only discovery does not create a registry or alter its selection',t=>{
  const f=fixture(t),isolated={...f.config,runsDir:path.join(f.dir,'uncreated')};
  assert.deepEqual(readWorkspaceWorkers(isolated),[]);assert.equal(fs.existsSync(isolated.runsDir),false);
  f.registry.seed({workspace:f.a,sessionId:'legacy'});f.register('other',f.a);f.registry.select(f.a,'other');
  const discovered=readWorkspaceWorkers(f.config,{workspace:f.a,sessionId:'legacy'});
  assert.equal(discovered.find(w=>w.sessionId==='other')?.selected,true);assert.equal(discovered.find(w=>w.sessionId==='legacy')?.selected,false);
});

test('one service wakes two project queues while preserving the legacy default and same-session rework',async t=>{
  const f=fixture(t);f.register('legacy',f.a);
  const a=await f.registry.ensure({workspace:f.a,sessionId:'legacy'},f.creator),b=await f.registry.ensure({workspace:f.b},f.creator);
  const registration:ServiceRegistration={version:1,sessionId:'legacy',workspace:f.a,projectDir:f.dir,nodeBin:process.execPath,cdpPort:18491,dbFile:f.config.dbFile,runsDir:f.config.runsDir!,workbuddyConfigDir:f.dir,cliElectronPath:f.config.cliElectronPath};
  writePrivateJson(f.config.serviceConfigFile!,registration);
  const store=new TaskStore(f.config.dbFile);t.after(()=>store.close());
  const resolver=async (_:Config,input:{workspace:string;sessionId?:string;title?:string})=>{const result=await f.registry.ensure(input,f.creator);return{ok:true,...result,workspace:result.worker.workspace,sessionId:result.worker.sessionId,next:''};};
  const coordinator=new TaskCoordinator(f.config,store,new WorkBuddyClient(f.config),resolver);
  await coordinator.send({taskId:'task-a',objective:'project A',workspace:f.a});
  await coordinator.send({taskId:'task-b',objective:'project B',workspace:f.b});
  assert.equal(store.get('task-a')?.sessionId,a.worker.sessionId);assert.equal(store.get('task-b')?.sessionId,b.worker.sessionId);
  const wakes:string[]=[];
  const trigger={async inspect(sessionId:string){return{state:'idle' as const,workspace:sessionId===a.worker.sessionId?f.a:f.b};},async wakeIdle(sessionId:string){wakes.push(sessionId);return{accepted:true};}};
  const pumped=await pumpWorkspaceWorkers(f.config,registration,trigger,store);
  assert.equal(pumped.workers.length,2);assert.deepEqual(new Set(wakes),new Set([a.worker.sessionId,b.worker.sessionId]));
  const queue=new DesktopQueue(f.config,()=>({desktopPid:process.pid}));
  const claim=await queue.claim(b.worker.sessionId,0);assert.equal(claim.status,'task');if(claim.status!=='task')throw Error('missing claim');
  assert.equal(claim.taskId,'task-b');assert.equal(claim.workspace,f.b);
  queue.report({...claim,status:'completed',text:'TASK_STATUS: completed\nTEST_RESULT: fixture',artifacts:[]});await coordinator.sync('task-b');
  await coordinator.continue({taskId:'task-b',feedback:'project B revision'});
  assert.equal(store.get('task-b')?.sessionId,b.worker.sessionId);assert.equal(store.get('task-b')?.workspace,f.b);
  const journal=new RunJournal(f.config.runsDir!,store.get('task-b')!.attemptId!);assert.match(journal.request().prompt,/project B revision/);
  assert.equal(JSON.parse(fs.readFileSync(f.config.serviceConfigFile!,'utf8')).sessionId,'legacy');
});

test('duplicate IDs never reconfigure a workspace; explicit models are persisted for native wake',async t=>{
  const f=fixture(t),store=new TaskStore(f.config.dbFile);t.after(()=>store.close());let resolved=0;
  const coordinator=new TaskCoordinator(f.config,store,new WorkBuddyClient(f.config),async(_,input)=>{
    resolved++;const result=await f.registry.ensure(input,f.creator);
    return {ok:true,...result,workspace:result.worker.workspace,sessionId:result.worker.sessionId,next:''};
  });
  store.createOrGet({taskId:'already',messageId:'existing',objective:'old',state:'queued'});
  const duplicate=await coordinator.send({taskId:'already',objective:'new',workspace:f.b,model:'chosen'});assert.equal(duplicate.created,false);assert.equal(resolved,0);
  const sent=await coordinator.send({objective:'model task',workspace:f.b,model:'chosen'});
  assert.equal(sent.ok,true);assert.equal(resolved,1);
  const request=new RunJournal(f.config.runsDir!,sent.task!.attemptId!).request();assert.equal(request.model,'chosen');assert.equal(request.sessionId,f.registry.selected(f.b)!.sessionId);
});

test('failed model selection does not replace an existing workspace binding',async t=>{
  const f=fixture(t);f.register('old',f.a);f.register('new',f.a);
  await f.registry.ensure({workspace:f.a,sessionId:'old'},f.creator);
  const native={...f.creator,async setModel(){throw Error('unavailable model');}};
  await assert.rejects(()=>f.registry.ensure({workspace:f.a,sessionId:'new',model:'bad'},native),/unavailable model/);
  assert.equal(f.registry.selected(f.a)?.sessionId,'old');
  const selected=await f.registry.ensure({workspace:f.a,sessionId:'new',model:'chosen'},{...f.creator,async setModel(sessionId,model){return {sessionId,model};}});
  assert.equal(selected.worker.sessionId,'new');assert.equal(selected.model,'chosen');assert.equal(f.registry.list().length,2);
});

test('slow model configuration cannot overwrite a newer project binding',async t=>{
  const f=fixture(t);f.register('old',f.a);f.register('new',f.a);
  await f.registry.ensure({workspace:f.a,sessionId:'old'},f.creator);
  let resume!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>resume=r);
  const slow=f.registry.ensure({workspace:f.a,model:'fast'},{...f.creator,async setModel(sessionId,model){entered();await gate;return{sessionId,model};}});
  await started;await f.registry.ensure({workspace:f.a,sessionId:'new'},f.creator);resume();
  await assert.rejects(()=>slow,/selection changed/);assert.equal(f.registry.selected(f.a)?.sessionId,'new');
});
