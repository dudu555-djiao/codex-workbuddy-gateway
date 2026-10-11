import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DeepSeekEvent } from "./deepseek-client.js";

export type DeepSeekTaskState = "queued" | "working" | "blocked" | "failed" | "cancelled" | "needs_review" | "accepted";
export interface DeepSeekTask {
  taskId: string; objective: string; hostId: string; sessionId: string; workspace?: string;
  constraints: string[]; acceptanceCommands: string[]; state: DeepSeekTaskState;
  attemptId: string; attempt: number; requestId: string; turnId?: string;
  runOpen: boolean; dispatchState: "reserved" | "accepted" | "uncertain" | "rejected";
  createdAt: string; updatedAt: string; deadlineAt: string; lastEventSeq: number;
  lastProgress?: string; report?: string; artifacts: string[]; evidence: string[];
  blockingReason?: string; blockingKind?: "transport" | "dispatch_unknown" | "deadline" | "waiting_input" | "cancel_requested" | "executor";
  syncError?: string; eventPageLimit?: number; cancelRequested?: boolean; cancelNote?: string; cancelledAt?: string;
  reviewNote?: string; reviewedAt?: string;
}
export interface DeepSeekAttempt extends DeepSeekTask { feedback?: string; }
export class DeepSeekStore {
  private readonly db: DatabaseSync;
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS deepseek_tasks(task_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, run_open INTEGER NOT NULL, updated_at TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS deepseek_session ON deepseek_tasks(host_id,session_id,run_open);
      CREATE TABLE IF NOT EXISTS deepseek_attempts(attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deepseek_events(attempt_id TEXT NOT NULL, seq INTEGER NOT NULL, raw_json TEXT NOT NULL, PRIMARY KEY(attempt_id,seq));`);
  }
  close() { this.db.close(); }
  get(taskId: string): DeepSeekTask | undefined {
    const row = this.db.prepare("SELECT snapshot FROM deepseek_tasks WHERE task_id=?").get(taskId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as DeepSeekTask : undefined;
  }
  list(limit = 20): DeepSeekTask[] {
    return (this.db.prepare("SELECT snapshot FROM deepseek_tasks ORDER BY updated_at DESC,task_id LIMIT ?").all(Math.max(1, Math.min(100, limit))) as { snapshot: string }[]).map((row) => JSON.parse(row.snapshot) as DeepSeekTask);
  }
  attempts(taskId: string): DeepSeekAttempt[] {
    return (this.db.prepare("SELECT snapshot FROM deepseek_attempts WHERE task_id=? ORDER BY attempt").all(taskId) as { snapshot: string }[]).map((row) => JSON.parse(row.snapshot) as DeepSeekAttempt);
  }
  events(attemptId: string, limit = 100): DeepSeekEvent[] {
    return (this.db.prepare("SELECT raw_json FROM (SELECT seq,raw_json FROM deepseek_events WHERE attempt_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq").all(attemptId, Math.max(1, Math.min(500, limit))) as { raw_json: string }[]).map((row) => JSON.parse(row.raw_json) as DeepSeekEvent);
  }
  /** Identity and session lock commit before the remote prompt can be sent. */
  reserve(task: DeepSeekTask, feedback?: string): { created: boolean; task: DeepSeekTask } {
    return this.transaction(() => {
      const current = this.get(task.taskId);
      if (current && task.attempt === 1) return { created: false, task: current };
      if (current && (current.runOpen || current.attempt + 1 !== task.attempt)) throw new Error("Task changed or still has an unconfirmed active run; synchronize before rework");
      if (current && (current.hostId !== task.hostId || current.sessionId !== task.sessionId)) throw new Error("Rework cannot change the bound Harness session");
      const conflict = this.db.prepare("SELECT task_id FROM deepseek_tasks WHERE host_id=? AND session_id=? AND run_open=1 AND task_id<>?").get(task.hostId, task.sessionId, task.taskId) as { task_id: string } | undefined;
      if (conflict) throw new Error(`Harness session already has active task ${conflict.task_id}`);
      if (this.db.prepare("SELECT attempt_id FROM deepseek_attempts WHERE attempt_id=?").get(task.attemptId)) throw new Error("Attempt identity already exists");
      this.write(task, feedback);
      return { created: true, task };
    });
  }
  update(taskId: string, attemptId: string, patch: Partial<DeepSeekTask>, options: { expectedOpen?: boolean; expectedDispatchStates?: DeepSeekTask["dispatchState"][] } = {}): DeepSeekTask {
    return this.transaction(() => {
      const task = this.require(taskId);
      if (task.attemptId !== attemptId || task.state === "accepted" || (options.expectedOpen !== undefined && task.runOpen !== options.expectedOpen) || (options.expectedDispatchStates && !options.expectedDispatchStates.includes(task.dispatchState))) return task;
      const next = { ...task, ...patch, taskId: task.taskId, attemptId: task.attemptId, attempt: task.attempt, requestId: task.requestId, hostId: task.hostId, sessionId: task.sessionId, updatedAt: new Date().toISOString() };
      this.write(next); return next;
    });
  }
  /** Store raw envelopes locally; only matching request AND turn may update a task. */
  applyEvents(taskId: string, attemptId: string, events: DeepSeekEvent[], cursor: number): DeepSeekTask {
    return this.transaction(() => {
      let task = this.require(taskId);
      if (task.attemptId !== attemptId) return task;
      for (const event of events) {
        if (!Number.isSafeInteger(event.seq) || event.seq < 0) continue;
        const exists = this.db.prepare("SELECT seq FROM deepseek_events WHERE attempt_id=? AND seq=?").get(attemptId, event.seq);
        if (exists) continue;
        this.db.prepare("INSERT INTO deepseek_events(attempt_id,seq,raw_json) VALUES(?,?,?)").run(attemptId, event.seq, JSON.stringify(event));
        if (event.requestId !== task.requestId || (task.turnId && event.turnId && event.turnId !== task.turnId) || !task.runOpen) continue;
        task = { ...task, turnId: task.turnId ?? (event.type === "accepted" ? undefined : event.turnId), dispatchState: "accepted", lastProgress: event.text ?? task.lastProgress };
        if (event.type === "started" || event.type === "accepted" || event.type === "progress") {
          // Telemetry and parallel tool output may arrive while a question is still
          // pending. Only a new native step proves that execution has resumed.
          if (task.cancelRequested) {
            task.state = "blocked"; task.blockingKind = "cancel_requested";
            task.blockingReason = "Cancellation requested; awaiting confirmed stop";
          } else if (task.blockingKind !== "waiting_input" || event.rawType === "step/start") {
            task.state = "working"; task.blockingReason = undefined; task.blockingKind = undefined;
          }
        } else if (event.type === "waiting_input") {
          task.state = "blocked";
          task.blockingReason = task.cancelRequested ? "Cancellation requested; awaiting confirmed stop" : event.text ?? "Harness is waiting for user input";
          task.blockingKind = task.cancelRequested ? "cancel_requested" : "waiting_input";
        } else if (event.type === "completed") {
          task.runOpen = false; task.report = event.text ?? "";
          const declared = task.report.match(/^TASK_STATUS:\s*(blocked|failed|cancelled)\s*$/im)?.[1];
          task.state = declared === "blocked" || declared === "failed" || declared === "cancelled" ? declared : "needs_review";
          task.artifacts = [...new Set([...(task.artifacts ?? []), ...(event.artifacts ?? [])])]; task.blockingReason = task.state === "needs_review" ? undefined : task.report; task.blockingKind = task.state === "needs_review" ? undefined : "executor";
        } else if (event.type === "failed" || event.type === "cancelled") {
          task.state = event.type; task.runOpen = false; task.report = event.text ?? task.lastProgress;
          task.blockingReason = event.error ?? event.text; task.blockingKind = "executor"; if (event.type === "cancelled") task.cancelledAt = new Date().toISOString();
        }
      }
      task.lastEventSeq = Math.max(task.lastEventSeq, Number.isSafeInteger(cursor) ? cursor : -1, ...events.map((event) => Number.isSafeInteger(event.seq) ? event.seq : -1));
      task.updatedAt = new Date().toISOString(); this.write(task); return task;
    });
  }
  /** An empty successful page still proves transport recovered, without bypassing input/cancel/deadline blockers. */
  syncSucceeded(taskId: string, attemptId: string, eventPageLimit: number): DeepSeekTask {
    return this.transaction(() => {
      const task = this.require(taskId); if (task.attemptId !== attemptId) return task;
      const next = { ...task, syncError: undefined, eventPageLimit, updatedAt: new Date().toISOString() };
      if (next.runOpen && next.blockingKind === "transport") {
        next.state = next.cancelRequested ? "blocked" : next.dispatchState === "accepted" ? "working" : "queued";
        next.blockingKind = next.cancelRequested ? "cancel_requested" : undefined;
        next.blockingReason = next.cancelRequested ? "Cancellation requested; awaiting confirmed stop" : undefined;
      }
      this.write(next); return next;
    });
  }
  syncFailed(taskId: string, attemptId: string, message: string): DeepSeekTask {
    return this.transaction(() => {
      const task = this.require(taskId); if (task.attemptId !== attemptId || !task.runOpen) return task;
      const next = { ...task, syncError: message, updatedAt: new Date().toISOString() };
      // Preserve an existing permission, dispatch-unknown, cancellation or deadline blocker.
      if (!next.blockingKind || next.blockingKind === "transport") { next.state = "blocked"; next.blockingKind = "transport"; next.blockingReason = message; }
      this.write(next); return next;
    });
  }
  accept(taskId: string, attemptId: string, note: string, evidence: string[], artifacts: string[]): DeepSeekTask {
    return this.transaction(() => {
      const task = this.require(taskId);
      if (task.attemptId !== attemptId || task.state !== "needs_review" || task.runOpen) throw new Error("Task changed during review or has not completed");
      const next: DeepSeekTask = { ...task, state: "accepted", reviewNote: note, reviewedAt: new Date().toISOString(), evidence, artifacts: [...new Set([...task.artifacts, ...artifacts])], updatedAt: new Date().toISOString() };
      this.write(next); return next;
    });
  }
  private require(taskId: string) { const task = this.get(taskId); if (!task) throw new Error(`Unknown DeepSeek task: ${taskId}`); return task; }
  private write(task: DeepSeekTask, feedback?: string) {
    const existing = this.db.prepare("SELECT snapshot FROM deepseek_attempts WHERE attempt_id=?").get(task.attemptId) as { snapshot: string } | undefined;
    const prior = existing ? JSON.parse(existing.snapshot) as DeepSeekAttempt : undefined;
    this.db.prepare("INSERT INTO deepseek_tasks(task_id,host_id,session_id,run_open,updated_at,snapshot) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET host_id=excluded.host_id,session_id=excluded.session_id,run_open=excluded.run_open,updated_at=excluded.updated_at,snapshot=excluded.snapshot").run(task.taskId, task.hostId, task.sessionId, Number(task.runOpen), task.updatedAt, JSON.stringify(task));
    this.db.prepare("INSERT INTO deepseek_attempts(attempt_id,task_id,attempt,snapshot) VALUES(?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET snapshot=excluded.snapshot").run(task.attemptId, task.taskId, task.attempt, JSON.stringify({ ...task, feedback: feedback ?? prior?.feedback }));
  }
  private transaction<T>(action: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const value = action(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
}
