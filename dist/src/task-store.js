import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export class TaskStore {
    file;
    db;
    constructor(file) {
        this.file = file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec(`
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
        cancel_note TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        task_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        msg_type TEXT,
        created_at TEXT,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (task_id, message_id),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
    `);
    }
    close() { this.db.close(); }
    createOrGet(task) {
        const existing = this.get(task.taskId);
        if (existing)
            return { task: existing, created: false };
        const now = task.createdAt ?? new Date().toISOString();
        this.db.prepare(`INSERT INTO tasks (task_id, message_id, objective, workspace, state, created_at, updated_at, last_message_id, report_json, cancel_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(task.taskId, task.messageId, task.objective, task.workspace ?? null, task.state, now, now, task.lastMessageId ?? task.messageId, task.report ? JSON.stringify(task.report) : null, task.cancelNote ?? null);
        return { task: this.get(task.taskId), created: true };
    }
    get(taskId) {
        const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
        return row ? rowToTask(row) : undefined;
    }
    update(taskId, patch) {
        const current = this.get(taskId);
        if (!current)
            throw new Error(`Unknown task: ${taskId}`);
        const updatedAt = new Date().toISOString();
        this.db.prepare(`UPDATE tasks SET state = ?, updated_at = ?, last_message_id = ?, report_json = ?, cancel_note = ? WHERE task_id = ?`).run(patch.state ?? current.state, updatedAt, patch.lastMessageId ?? current.lastMessageId ?? null, patch.report === undefined ? (current.report ? JSON.stringify(current.report) : null) : JSON.stringify(patch.report), patch.cancelNote ?? current.cancelNote ?? null, taskId);
        return this.get(taskId);
    }
    addMessages(taskId, messages) {
        const statement = this.db.prepare(`INSERT OR IGNORE INTO messages (task_id, message_id, role, content_json, msg_type, created_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
        let inserted = 0;
        for (const message of messages) {
            const result = statement.run(taskId, message.message_id, message.role, JSON.stringify(message.content ?? []), message.msg_type ?? null, message.created_at ?? null, JSON.stringify(message));
            if (Number(result.changes) > 0)
                inserted += 1;
        }
        return inserted;
    }
    listMessages(taskId, limit = 100) {
        const rows = this.db.prepare("SELECT raw_json FROM messages WHERE task_id = ? ORDER BY rowid ASC LIMIT ?").all(taskId, Math.min(Math.max(limit, 1), 500));
        return rows.map((row) => JSON.parse(row.raw_json));
    }
}
function rowToTask(row) {
    return {
        taskId: String(row.task_id),
        messageId: String(row.message_id),
        objective: String(row.objective),
        workspace: row.workspace == null ? undefined : String(row.workspace),
        state: String(row.state),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        lastMessageId: row.last_message_id == null ? undefined : String(row.last_message_id),
        report: row.report_json ? JSON.parse(String(row.report_json)) : undefined,
        cancelNote: row.cancel_note == null ? undefined : String(row.cancel_note),
    };
}
//# sourceMappingURL=task-store.js.map