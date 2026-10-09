import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { LocalMessage } from "./workbuddy-client.js";

export type RunStatus = "queued" | "working" | "needs_review" | "blocked" | "failed" | "cancelled";
export interface RunRequest {
  attemptId: string;
  taskId: string;
  prompt: string;
  workspace?: string;
  sessionId?: string;
  model?: string;
  sessionMode?: "existing" | "new";
  timeoutSeconds: number;
}
export interface RunSnapshot {
  attemptId: string;
  taskId: string;
  status: RunStatus;
  pid?: number;
  driver?: "desktop-acp" | "desktop-queue";
  deadline?: string;
  sessionId?: string;
  runtimeSource?: string;
  text?: string;
  stopReason?: string;
  error?: string;
  waitingInput?: boolean;
  artifacts?: string[];
  updatedAt: string;
}
export interface RunEvent {
  seq: number;
  type: string;
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

const ATTEMPT_ID = /^run-[a-f0-9-]{36}$/;
const TERMINAL = new Set<RunStatus>(["needs_review", "blocked", "failed", "cancelled"]);

export function runsDirectory(config: Config): string {
  return config.runsDir ?? path.join(path.dirname(config.dbFile), "runs");
}

export function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}

export class RunJournal {
  readonly dir: string;
  private seq: number;
  constructor(readonly root: string, readonly attemptId: string) {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error("Invalid run journal identity");
    this.dir = path.join(root, attemptId);
    this.seq = this.events(0, Infinity).at(-1)?.seq ?? 0;
  }
  static newId(): string { return `run-${crypto.randomUUID()}`; }
  request(): RunRequest { return JSON.parse(fs.readFileSync(path.join(this.dir, "request.json"), "utf8")) as RunRequest; }
  snapshot(): RunSnapshot | undefined {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, "state.json"), "utf8")) as RunSnapshot; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  save(snapshot: RunSnapshot): void { writePrivateJson(path.join(this.dir, "state.json"), { ...snapshot, updatedAt: new Date().toISOString() }); }
  append(type: string, text: string, metadata?: Record<string, unknown>): RunEvent {
    // Queue helpers are separate processes. Refresh after acquiring the caller's
    // write lock so a previously constructed journal cannot reuse a sequence.
    this.seq = Math.max(this.seq, this.events(0, Infinity).at(-1)?.seq ?? 0);
    const event: RunEvent = { seq: ++this.seq, type, text, createdAt: new Date().toISOString(), metadata };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, "events.jsonl");
    if (fs.existsSync(file)) {
      const fd = fs.openSync(file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const tail = Buffer.alloc(1);
        if (size && fs.readSync(fd, tail, 0, 1, size - 1) && tail[0] !== 10) fs.appendFileSync(file, "\n");
      } finally { fs.closeSync(fd); }
    }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  }
  events(after = 0, limit = 100): RunEvent[] {
    let raw: string;
    try { raw = fs.readFileSync(path.join(this.dir, "events.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const out: RunEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event: RunEvent;
      try { event = JSON.parse(line) as RunEvent; } catch { continue; } // a writer may be appending its last frame
      if (event.seq > after) out.push(event);
      if (out.length >= limit) break;
    }
    return out;
  }
  cancel(): void { writePrivateJson(path.join(this.dir, "cancel.json"), { requestedAt: new Date().toISOString() }); }
  cancellationRequested(): boolean { return fs.existsSync(path.join(this.dir, "cancel.json")); }
  checkWorker(): void {
    const snapshot = this.snapshot();
    if (!snapshot || TERMINAL.has(snapshot.status)) return;
    if (snapshot.driver === "desktop-queue") return; // Native helpers report into the queue; there is no detached ACP worker.
    // Never replay a prompt after losing its worker. WorkBuddy may still have
    // performed side effects; the operator must inspect the original session.
    if (snapshot.status === "queued" && Date.now() - Date.parse(snapshot.updatedAt) < 10_000) return;
    if (snapshot.pid) { try { process.kill(snapshot.pid, 0); return; } catch {} }
    const error = "Bridge worker stopped before a terminal result. Inspect the original WorkBuddy session; the task was not automatically resent.";
    const updated: RunSnapshot = { ...snapshot, status: "blocked", error };
    this.save(updated);
    this.append("result", `TASK_STATUS: blocked\n${error}`, { status: "blocked", sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource });
  }
}

export class DurableRuns {
  readonly root: string;
  constructor(private readonly config: Config) { this.root = runsDirectory(config); }
  async start(request: RunRequest): Promise<void> {
    const script = fileURLToPath(new URL("./run-worker.js", import.meta.url));
    if (!fs.existsSync(script)) throw new Error("Run npm run build before starting a desktop task");
    const journal = new RunJournal(this.root, request.attemptId);
    if (fs.existsSync(path.join(journal.dir, "request.json"))) throw new Error("This run already exists; refusing duplicate dispatch");
    fs.mkdirSync(journal.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(journal.dir, "request.json"), JSON.stringify(request), { flag: "wx", mode: 0o600 });
    journal.save({ attemptId: request.attemptId, taskId: request.taskId, status: "queued", updatedAt: new Date().toISOString() });
    journal.append("status", "Task reserved; waiting for WorkBuddy desktop session binding.", { status: "queued" });
    const child = spawn(process.execPath, [script, this.root, request.attemptId], {
      cwd: process.cwd(), env: process.env, detached: true, stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }
  messages(cursor: string, limit = 100): LocalMessage[] {
    const [attemptId = "", sequence = "0"] = cursor.split(":");
    if (!ATTEMPT_ID.test(attemptId)) {
      return [{ message_id: `${cursor}:unrecoverable`, role: "assistant", content: ["TASK_STATUS: blocked\nThis legacy in-memory run cannot be recovered after restart. Inspect the old WorkBuddy conversation before starting a new task."], metadata: { type: "result", status: "blocked", source: "legacy-unrecoverable" } }];
    }
    const journal = new RunJournal(this.root, attemptId);
    journal.checkWorker();
    const snapshot = journal.snapshot();
    if (!snapshot) throw new Error("Run journal was not found; refusing to report an unverified completion");
    return journal.events(Number(sequence) || 0, limit).map((event) => ({
      message_id: `${attemptId}:${event.seq}`, role: event.type === "result" ? "assistant" : "system", content: [event.text], created_at: event.createdAt,
      metadata: { source: snapshot.driver === "desktop-queue" ? "workbuddy-desktop-queue" : "workbuddy-desktop-acp", attemptId, eventSeq: event.seq, type: event.type, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource, ...event.metadata },
    }));
  }
  cancel(attemptId: string): boolean {
    const id = attemptId.split(":")[0]!;
    if (!ATTEMPT_ID.test(id)) return false;
    const journal = new RunJournal(this.root, id);
    const snapshot = journal.snapshot();
    if (!snapshot || TERMINAL.has(snapshot.status)) return false;
    journal.cancel();
    return true;
  }
  respond(attemptId: string, decision: "allow_once" | "reject_once" | "cancel" | "submit", content?: Record<string, unknown>): void {
    const journal = new RunJournal(this.root, attemptId);
    const snapshot = journal.snapshot();
    if (!snapshot || !snapshot.waitingInput || TERMINAL.has(snapshot.status)) throw new Error("No active WorkBuddy input request for this attempt");
    const pending = JSON.parse(fs.readFileSync(path.join(journal.dir, "pending-input.json"), "utf8")) as { key: string; method?: string; options?: Array<{kind?: string; optionId?: string}> };
    if (!/^[a-f0-9]{64}$/.test(pending.key)) throw new Error("Invalid input request identity");
    if (pending.method === "elicitation/create" || pending.method === "_codebuddy.ai/question") {
      if (decision !== "submit" && decision !== "cancel") throw new Error("This WorkBuddy input request requires submit or cancel");
      if (decision === "submit" && !content) throw new Error("Provide form content for this WorkBuddy input request");
    } else if (pending.method === "session/request_permission" || pending.method === "requestPermission") {
      if (decision !== "cancel" && !pending.options?.some((option) => option.kind === decision && typeof option.optionId === "string")) throw new Error("This single-action permission choice was not offered by WorkBuddy");
    } else if (pending.method) throw new Error(`Unsupported WorkBuddy input request: ${pending.method}. Inspect its desktop conversation.`);
    const target = path.join(journal.dir, `input-${pending.key}.json`);
    fs.writeFileSync(target, JSON.stringify({ decision, content }), { flag: "wx", mode: 0o600 });
  }
}
