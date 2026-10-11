import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import { readDesktopSession, waitForDesktopSession } from "./desktop-runtime.js";
import { runsDirectory } from "./run-journal.js";

export interface WorkspaceWorker {
  sessionId: string;
  workspace: string;
  state: "creating" | "ready" | "uncertain";
  selected: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export interface NativeWorkerCreator {
  createWorker(workspace: string, sessionId: string, title?: string): Promise<{sessionId: string; workspace: string}>;
}
type Row = Omit<WorkspaceWorker, "selected"> & { selected: number };
function decode(row: Row): WorkspaceWorker {return {...row,selected:row.selected===1,error:row.error??undefined};}

export function readWorkspaceWorkers(config: Config, fallback?: {workspace:string;sessionId:string}): WorkspaceWorker[] {
  const file=path.join(runsDirectory(config),"workspace-workers.sqlite");
  let workers: WorkspaceWorker[]=[];
  if(fs.existsSync(file)) {
    const db=new DatabaseSync(file,{readOnly:true});
    try {workers=(db.prepare("SELECT * FROM workers ORDER BY workspace, createdAt, sessionId").all() as unknown as Row[]).map(decode);} finally {db.close();}
  }
  if(fallback&&!workers.some(worker=>worker.sessionId===fallback.sessionId))workers.push({...fallback,workspace:path.resolve(fallback.workspace),state:'ready',selected:!workers.some(worker=>worker.workspace===path.resolve(fallback.workspace)&&worker.selected),createdAt:'',updatedAt:''});
  return workers;
}

/** This is our routing registry, never WorkBuddy's own database. */
export class WorkspaceWorkers {
  private readonly db: DatabaseSync;
  constructor(readonly config: Config) {
    const root = runsDirectory(config);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "workspace-workers.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workers(sessionId TEXT PRIMARY KEY, workspace TEXT NOT NULL, state TEXT NOT NULL,
        selected INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS selected_workspace ON workers(workspace) WHERE selected=1;`);
  }
  private decode(row: Row | undefined): WorkspaceWorker | undefined {
    return row ? decode(row) : undefined;
  }
  selected(workspace: string): WorkspaceWorker | undefined {
    return this.decode(this.db.prepare("SELECT * FROM workers WHERE workspace=? AND selected=1").get(path.resolve(workspace)) as Row | undefined);
  }
  list(): WorkspaceWorker[] {
    return (this.db.prepare("SELECT * FROM workers ORDER BY workspace, createdAt, sessionId").all() as unknown as Row[]).map(row => this.decode(row)!);
  }
  seed(worker: {sessionId: string; workspace: string}): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO workers VALUES (?, ?, 'ready', ?, ?, ?, NULL)").run(worker.sessionId, path.resolve(worker.workspace), this.selected(worker.workspace) ? 0 : 1, now, now);
  }
  select(workspace: string, sessionId: string): WorkspaceWorker {
    const existing = this.db.prepare("SELECT workspace FROM workers WHERE sessionId=?").get(sessionId);
    if(existing && existing.workspace !== workspace)throw new Error("This native session is already registered for another workspace");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workers SET selected=0 WHERE workspace=?").run(workspace);
      this.db.prepare(`INSERT INTO workers VALUES (?, ?, 'ready', 1, ?, ?, NULL)
        ON CONFLICT(sessionId) DO UPDATE SET state='ready', selected=1, updatedAt=excluded.updatedAt, error=NULL`).run(sessionId, workspace, now, now);
      this.db.exec("COMMIT");
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
    return this.selected(workspace)!;
  }
  private reserve(workspace: string): WorkspaceWorker {
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    try { this.db.prepare("INSERT INTO workers VALUES (?, ?, 'creating', 1, ?, ?, NULL)").run(sessionId, workspace, now, now); }
    catch { throw new Error("This workspace is already being prepared; retry ensure_workspace without creating another session"); }
    return this.selected(workspace)!;
  }
  private verify(worker: {workspace: string; sessionId: string}): boolean {
    const evidence = readDesktopSession(this.config.workbuddyConfigDir, worker.sessionId);
    if(evidence.registered && evidence.cwd && path.resolve(evidence.cwd)!==worker.workspace)throw new Error("Native session workspace differs from the requested project");
    return evidence.registered && Boolean(evidence.cwd);
  }
  async ensure(input: {workspace: string; sessionId?: string; title?: string}, native: NativeWorkerCreator): Promise<{created: boolean; worker: WorkspaceWorker}> {
    if(!path.isAbsolute(input.workspace)||!fs.statSync(input.workspace).isDirectory())throw new Error("workspace must be an existing absolute directory");
    const workspace = path.resolve(input.workspace);
    if(input.sessionId) {
      if(!this.verify({workspace,sessionId:input.sessionId}))throw new Error("The chosen WorkBuddy session is not registered; supply a real existing session or omit sessionId for native creation");
      return {created:false,worker:this.select(workspace,input.sessionId)};
    }
    const previous = this.selected(workspace);
    if(previous) {
      if(this.verify(previous))return {created:false,worker:this.select(workspace,previous.sessionId)};
      throw new Error(previous.state==='ready' ? "The registered WorkBuddy session was deleted or is unavailable; select another real session explicitly" : "Native creation is in progress or uncertain; inspect the reserved session before retrying. No second session was created");
    }
    const worker = this.reserve(workspace);
    try {
      const result = await native.createWorker(workspace,worker.sessionId,input.title??`执行：${path.basename(workspace)}`);
      if(result.sessionId!==worker.sessionId || path.resolve(result.workspace)!==workspace)throw new Error("Native creation returned another session or workspace; inspect the reserved identity, do not replay");
      const evidence = await waitForDesktopSession(this.config.workbuddyConfigDir,worker.sessionId);
      if(!evidence.registered||!this.verify(worker))throw new Error("Native creation returned but desktop history is not registered; inspect the reserved identity, do not replay");
      this.db.prepare("UPDATE workers SET state='ready',updatedAt=?,error=NULL WHERE sessionId=?").run(new Date().toISOString(),worker.sessionId);
      const selected=this.selected(workspace);
      if(selected?.sessionId!==worker.sessionId)throw new Error("Workspace selection changed while creating this session; its native record was retained without overriding the newer selection");
      return {created:true,worker:selected};
    } catch(error) {
      this.db.prepare("UPDATE workers SET state='uncertain',error=?,updatedAt=? WHERE sessionId=? AND state='creating'").run(error instanceof Error?error.message:String(error),new Date().toISOString(),worker.sessionId);
      throw error;
    }
  }
  close(): void { this.db.close(); }
}
