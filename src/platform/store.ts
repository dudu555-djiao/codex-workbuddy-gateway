import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HubError, type HubRun, type HubEvent } from "./contracts.js";

/** Platform records never replace provider-owned execution history. */
export class HubStore {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS hub_runs(id TEXT PRIMARY KEY, request_key TEXT UNIQUE, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_key TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,event_key));
      CREATE INDEX IF NOT EXISTS hub_events_run ON hub_events(run_id,id);`);
  }
  close() { this.db.close(); }
  get(id: string): HubRun | undefined {
    const row = this.db.prepare("SELECT body FROM hub_runs WHERE id=?").get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as HubRun : undefined;
  }
  byKey(key: string, fingerprint: string): HubRun | undefined {
    const row = this.db.prepare("SELECT body,fingerprint FROM hub_runs WHERE request_key=?").get(key) as { body: string; fingerprint: string } | undefined;
    if (row && row.fingerprint !== fingerprint) throw new HubError("IDEMPOTENCY_CONFLICT", "This idempotencyKey belongs to a different request", 409);
    return row ? JSON.parse(row.body) as HubRun : undefined;
  }
  create(run: HubRun, fingerprint: string): { run: HubRun; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = run.input.idempotencyKey ? this.byKey(run.input.idempotencyKey, fingerprint) : undefined;
      if (previous) { this.db.exec("COMMIT"); return { run: previous, created: false }; }
      this.db.prepare("INSERT INTO hub_runs VALUES(?,?,?,?)").run(run.id, run.input.idempotencyKey ?? null, fingerprint, JSON.stringify(run));
      this.stateEvent(run);
      this.db.exec("COMMIT"); return { run, created: true };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  list(limit = 100, offset = 0): HubRun[] {
    const rows = this.db.prepare("SELECT body FROM hub_runs ORDER BY rowid DESC LIMIT ? OFFSET ?").all(limit, offset) as Array<{ body: string }>;
    return rows.map(row => JSON.parse(row.body) as HubRun);
  }
  all(): HubRun[] {
    const rows = this.db.prepare("SELECT body FROM hub_runs ORDER BY rowid").all() as Array<{ body: string }>;
    return rows.map(row => JSON.parse(row.body) as HubRun);
  }
  save(run: HubRun): HubRun {
    const previous = this.get(run.id);
    if (JSON.stringify({ ...previous, updatedAt: "" }) === JSON.stringify({ ...run, updatedAt: "" })) return previous!;
    const next = { ...run, updatedAt: new Date().toISOString() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE hub_runs SET body=? WHERE id=?").run(JSON.stringify(next), run.id);
      this.stateEvent(next);
      this.db.exec("COMMIT"); return next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  event(runId: string, type: string, data: unknown, key?: string) {
    this.db.prepare("INSERT OR IGNORE INTO hub_events(run_id,event_key,type,data,created_at) VALUES(?,?,?,?,?)").run(runId, key ?? null, type, JSON.stringify(data), new Date().toISOString());
  }
  private stateEvent(run: HubRun) {
    this.event(run.id, "state", { id: run.id, status: run.status, review: run.review, round: run.round, holdsCapacity: run.holdsCapacity, attemptId: run.attemptId, sessionId: run.sessionId, runtimeSource: run.runtimeSource, error: run.error, lastPollError: run.lastPollError, resultAvailable: Boolean(run.result), updatedAt: run.updatedAt });
  }
  events(runId: string, after = 0, limit = 100): HubEvent[] {
    const rows = this.db.prepare("SELECT * FROM hub_events WHERE run_id=? AND id>? ORDER BY id LIMIT ?").all(runId, after, limit) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: Number(row.id), runId: String(row.run_id), type: String(row.type), data: JSON.parse(String(row.data)), createdAt: String(row.created_at) }));
  }
}
