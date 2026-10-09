import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LocalMessage } from "./workbuddy-client.js";

export type TaskState = "queued" | "working" | "completed" | "blocked" | "failed" | "cancelled" | "needs_review" | "accepted";

export interface StoredTask {
  taskId: string;
  messageId: string;
  objective: string;
  workspace?: string;
  constraints?: string[];
  acceptanceCommands?: string[];
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  lastMessageId?: string;
  report?: TaskReport;
  cancelNote?: string;
  reviewNote?: string;
  reviewedAt?: string;
  sessionId?: string;
  /** A backend/source identifier. Credentials must never be stored here. */
  runtimeSource?: string;
  attemptId?: string;
  attempt?: number;
  lastEventSeq?: number;
  artifacts?: string[];
  evidence?: string[];
  blockingReason?: string;
}

export interface TaskReport {
  status?: string;
  filesChanged: string[];
  commandsRun: string[];
  testResult?: string;
  remainingProblems?: string;
  rawText: string;
}

type NullableTaskFields = "report" | "reviewNote" | "reviewedAt" | "sessionId" | "runtimeSource" | "attemptId" | "attempt" | "lastEventSeq" | "artifacts" | "evidence" | "blockingReason" | "constraints" | "acceptanceCommands" | "cancelNote";
export type TaskUpdate = Partial<Pick<StoredTask, "state" | "messageId" | "lastMessageId">> & {
  [Field in NullableTaskFields]?: StoredTask[Field] | null;
};

export interface AttemptReservation {
  attemptId: string;
  messageId: string;
  sessionId?: string;
  runtimeSource?: string;
  state?: "queued" | "working";
  acceptanceCommands?: string[];
}

export interface StoredAttempt {
  taskId: string;
  attemptId: string;
  attempt: number;
  messageId: string;
  sessionId?: string;
  runtimeSource?: string;
  state: TaskState;
  lastEventSeq: number;
  artifacts: string[];
  evidence: string[];
  report?: TaskReport;
  blockingReason?: string;
  reviewNote?: string;
  reviewedAt?: string;
  cancelNote?: string;
  createdAt: string;
  updatedAt: string;
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    // Preserve existing parent-folder permissions; the database itself holds
    // private task prompts and must be owner-only, including after migration.
    fs.chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        workspace TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_id TEXT,
        report_json TEXT,
        cancel_note TEXT,
        review_note TEXT,
        reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        msg_type TEXT,
        created_at TEXT,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (task_id, attempt_id, message_id),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS task_attempts (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS task_attempts_by_task ON task_attempts(task_id, attempt);
    `);
    // Preserve old task history; extend pre-review-loop databases in place.
    this.transaction(() => {
      const columns = new Set((this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name));
      for (const [name, type] of Object.entries({
        review_note: "TEXT", reviewed_at: "TEXT", constraints_json: "TEXT", acceptance_commands_json: "TEXT",
        session_id: "TEXT", runtime_source: "TEXT", attempt_id: "TEXT", attempt: "INTEGER", last_event_seq: "INTEGER",
        artifacts_json: "TEXT", evidence_json: "TEXT", blocking_reason: "TEXT",
      })) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      }
      const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      if (!messageColumns.some((column) => column.name === "attempt_id")) {
        this.db.exec(`
          ALTER TABLE messages RENAME TO legacy_messages;
          CREATE TABLE messages (
            task_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL DEFAULT '',
            message_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            msg_type TEXT,
            created_at TEXT,
            raw_json TEXT NOT NULL,
            PRIMARY KEY(task_id, attempt_id, message_id),
            FOREIGN KEY(task_id) REFERENCES tasks(task_id)
          );
          INSERT INTO messages (task_id, message_id, role, content_json, msg_type, created_at, raw_json)
            SELECT task_id, message_id, role, content_json, msg_type, created_at, raw_json FROM legacy_messages ORDER BY rowid;
          DROP TABLE legacy_messages;
        `);
      }
    });
  }

  close(): void { this.db.close(); }

  createOrGet(task: Omit<StoredTask, "createdAt" | "updatedAt"> & { createdAt?: string }): { task: StoredTask; created: boolean } {
    return this.transaction(() => {
      const existing = this.get(task.taskId);
      if (existing) return { task: existing, created: false };
      const now = task.createdAt ?? new Date().toISOString();
      this.db.prepare(`INSERT INTO tasks (task_id, message_id, objective, workspace, state, created_at, updated_at, last_message_id, report_json, cancel_note,
        review_note, reviewed_at, constraints_json, acceptance_commands_json, session_id, runtime_source, attempt_id, attempt, last_event_seq, artifacts_json, evidence_json, blocking_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        task.taskId, task.messageId, task.objective, task.workspace ?? null, task.state, now, now,
        task.lastMessageId ?? task.messageId, json(task.report), task.cancelNote ?? null,
        task.reviewNote ?? null, task.reviewedAt ?? null, json(task.constraints), json(task.acceptanceCommands),
        task.sessionId ?? null, task.runtimeSource ?? null, task.attemptId ?? null, task.attempt ?? null, task.lastEventSeq ?? null,
        json(task.artifacts), json(task.evidence), task.blockingReason ?? null,
      );
      const stored = this.get(task.taskId)!;
      this.saveAttempt(stored);
      return { task: stored, created: true };
    });
  }

  get(taskId: string): StoredTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(options: { state?: TaskState; states?: TaskState[]; limit?: number; offset?: number } = {}): StoredTask[] {
    const states = options.states ?? (options.state ? [options.state] : []);
    const rows = this.db.prepare(`SELECT * FROM tasks ${states.length ? `WHERE state IN (${states.map(() => "?").join(",")})` : ""}
      ORDER BY updated_at DESC, task_id ASC LIMIT ? OFFSET ?`).all(...states, boundedLimit(options.limit ?? 100), Math.max(0, Math.floor(options.offset ?? 0))) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  /** Reserve before spawning a worker, atomically across MCP processes. */
  beginAttempt(taskId: string, reservation: AttemptReservation): StoredTask {
    if (!reservation.attemptId || !reservation.messageId) throw new Error("Attempt and message identity are required");
    return this.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error(`Unknown task: ${taskId}`);
      if (current.state === "working" || (current.state === "queued" && current.attemptId)) {
        throw new Error(`Task ${taskId} already has an active attempt`);
      }
      if (this.db.prepare("SELECT attempt_id FROM task_attempts WHERE attempt_id = ?").get(reservation.attemptId)) {
        throw new Error(`Attempt identity already exists: ${reservation.attemptId}`);
      }
      const history = this.db.prepare("SELECT COALESCE(MAX(attempt), 0) AS last_attempt FROM task_attempts WHERE task_id = ?").get(taskId) as { last_attempt: number };
      return this.writeUpdate(current, {
        state: reservation.state ?? "queued", attemptId: reservation.attemptId, attempt: Math.max(current.attempt ?? 0, Number(history.last_attempt)) + 1,
        messageId: reservation.messageId, lastMessageId: reservation.messageId,
        // Rework keeps the bound conversation; never silently discover another.
        sessionId: reservation.sessionId ?? current.sessionId ?? null,
        runtimeSource: reservation.runtimeSource ?? current.runtimeSource ?? null,
        acceptanceCommands: reservation.acceptanceCommands === undefined ? current.acceptanceCommands : [...new Set([...(current.acceptanceCommands ?? []), ...reservation.acceptanceCommands])],
        lastEventSeq: 0, artifacts: [], evidence: [], report: null,
        blockingReason: null, reviewNote: null, reviewedAt: null, cancelNote: null,
      });
    });
  }

  update(taskId: string, patch: TaskUpdate): StoredTask {
    return this.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error(`Unknown task: ${taskId}`);
      return this.writeUpdate(current, patch);
    });
  }

  /** A late old worker cannot overwrite a newer rework attempt. */
  updateAttempt(taskId: string, attemptId: string, patch: Omit<TaskUpdate, "attemptId" | "attempt">, options: { expectedStates?: TaskState[]; preserveTerminal?: boolean } = {}): { task: StoredTask; applied: boolean } {
    return this.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error(`Unknown task: ${taskId}`);
      if (current.attemptId !== attemptId) return { task: current, applied: false };
      if (options.expectedStates && !options.expectedStates.includes(current.state)) return { task: current, applied: false };
      if (options.preserveTerminal !== false && (current.state === "accepted" || current.state === "cancelled") && patch.state !== undefined && patch.state !== current.state) {
        return { task: current, applied: false };
      }
      if (patch.lastEventSeq != null && patch.lastEventSeq < (current.lastEventSeq ?? 0)) return { task: current, applied: false };
      return { task: this.writeUpdate(current, patch), applied: true };
    });
  }

  listAttempts(taskId: string): StoredAttempt[] {
    const rows = this.db.prepare("SELECT snapshot_json FROM task_attempts WHERE task_id = ? ORDER BY attempt ASC").all(taskId) as Array<{ snapshot_json: string }>;
    return rows.map((row) => JSON.parse(row.snapshot_json) as StoredAttempt);
  }

  addMessages(taskId: string, messages: LocalMessage[]): number {
    const current = this.get(taskId);
    if (!current) throw new Error(`Unknown task: ${taskId}`);
    const statement = this.db.prepare(`INSERT OR IGNORE INTO messages (task_id, attempt_id, message_id, role, content_json, msg_type, created_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    return this.transaction(() => {
      let inserted = 0;
      for (const message of messages) {
        const attemptId = typeof message.metadata?.attemptId === "string" ? message.metadata.attemptId : current.attemptId ?? "";
        const result = statement.run(taskId, attemptId, message.message_id, message.role, JSON.stringify(message.content ?? []), message.msg_type ?? null, message.created_at ?? null, JSON.stringify(message));
        if (Number(result.changes) > 0) inserted += 1;
      }
      return inserted;
    });
  }

  /** Read recent events for the current attempt, with history explicitly selectable. */
  listMessages(taskId: string, limit = 100, attemptId?: string): LocalMessage[] {
    const selectedAttempt = attemptId ?? this.get(taskId)?.attemptId ?? "";
    const rows = this.db.prepare(`SELECT raw_json FROM (
      SELECT rowid AS message_order, raw_json FROM messages WHERE task_id = ? AND attempt_id = ? ORDER BY rowid DESC LIMIT ?
    ) ORDER BY message_order ASC`).all(taskId, selectedAttempt, boundedLimit(limit)) as Array<{ raw_json: string }>;
    return rows.map((row) => JSON.parse(row.raw_json) as LocalMessage);
  }

  private writeUpdate(current: StoredTask, patch: TaskUpdate): StoredTask {
    const merged = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: new Date().toISOString() };
    this.db.prepare(`UPDATE tasks SET state = ?, message_id = ?, updated_at = ?, last_message_id = ?, report_json = ?, cancel_note = ?, review_note = ?, reviewed_at = ?,
      constraints_json = ?, acceptance_commands_json = ?, session_id = ?, runtime_source = ?, attempt_id = ?, attempt = ?, last_event_seq = ?, artifacts_json = ?, evidence_json = ?, blocking_reason = ? WHERE task_id = ?`).run(
      merged.state, merged.messageId, merged.updatedAt, merged.lastMessageId ?? null, json(merged.report), merged.cancelNote ?? null,
      merged.reviewNote ?? null, merged.reviewedAt ?? null, json(merged.constraints), json(merged.acceptanceCommands), merged.sessionId ?? null,
      merged.runtimeSource ?? null, merged.attemptId ?? null, merged.attempt ?? null, merged.lastEventSeq ?? null,
      json(merged.artifacts), json(merged.evidence), merged.blockingReason ?? null, current.taskId,
    );
    const updated = this.get(current.taskId)!;
    this.saveAttempt(updated);
    return updated;
  }

  private saveAttempt(task: StoredTask): void {
    if (!task.attemptId) return;
    const prior = this.db.prepare("SELECT snapshot_json FROM task_attempts WHERE attempt_id = ?").get(task.attemptId) as { snapshot_json: string } | undefined;
    const priorAttempt = prior ? JSON.parse(prior.snapshot_json) as StoredAttempt : undefined;
    if (priorAttempt && priorAttempt.taskId !== task.taskId) throw new Error("Attempt identity belongs to another task");
    const snapshot: StoredAttempt = {
      taskId: task.taskId, attemptId: task.attemptId, attempt: task.attempt ?? 1, messageId: task.messageId,
      sessionId: task.sessionId, runtimeSource: task.runtimeSource, state: task.state, lastEventSeq: task.lastEventSeq ?? 0,
      artifacts: task.artifacts ?? [], evidence: task.evidence ?? [], report: task.report,
      blockingReason: task.blockingReason, reviewNote: task.reviewNote, reviewedAt: task.reviewedAt, cancelNote: task.cancelNote,
      createdAt: priorAttempt?.createdAt ?? task.updatedAt, updatedAt: task.updatedAt,
    };
    this.db.prepare(`INSERT INTO task_attempts (attempt_id, task_id, attempt, snapshot_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`).run(task.attemptId, task.taskId, snapshot.attempt, JSON.stringify(snapshot));
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function json(value: unknown): string | null { return value == null ? null : JSON.stringify(value); }
function boundedLimit(value: number): number { return Math.min(Math.max(Math.floor(value), 1), 500); }
function optionalText(value: unknown): string | undefined { return value == null ? undefined : String(value); }
function optionalNumber(value: unknown): number | undefined { return value == null ? undefined : Number(value); }
function parseJson<T>(value: unknown): T | undefined { return value == null ? undefined : JSON.parse(String(value)) as T; }

function rowToTask(row: Record<string, unknown>): StoredTask {
  return {
    taskId: String(row.task_id), messageId: String(row.message_id), objective: String(row.objective), workspace: optionalText(row.workspace),
    state: String(row.state) as TaskState, createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastMessageId: optionalText(row.last_message_id),
    report: parseJson<TaskReport>(row.report_json), cancelNote: optionalText(row.cancel_note), reviewNote: optionalText(row.review_note), reviewedAt: optionalText(row.reviewed_at),
    constraints: parseJson<string[]>(row.constraints_json), acceptanceCommands: parseJson<string[]>(row.acceptance_commands_json),
    sessionId: optionalText(row.session_id), runtimeSource: optionalText(row.runtime_source), attemptId: optionalText(row.attempt_id), attempt: optionalNumber(row.attempt),
    lastEventSeq: optionalNumber(row.last_event_seq), artifacts: parseJson<string[]>(row.artifacts_json), evidence: parseJson<string[]>(row.evidence_json), blockingReason: optionalText(row.blocking_reason),
  };
}
