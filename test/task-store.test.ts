import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";

test("persists task identity, idempotency, messages, and state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-gateway-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  const first = store.createOrGet({ taskId: "task-1", messageId: "msg-1", objective: "demo", state: "working" });
  const second = store.createOrGet({ taskId: "task-1", messageId: "msg-2", objective: "duplicate", state: "working" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.task.messageId, "msg-1");
  assert.equal(store.addMessages("task-1", [{ message_id: "msg-2", role: "assistant", content: ["done"] }]), 1);
  assert.equal(store.addMessages("task-1", [{ message_id: "msg-2", role: "assistant", content: ["done"] }]), 0);
  const updated = store.update("task-1", { state: "completed", lastMessageId: "msg-2" });
  assert.equal(updated.state, "completed");
  assert.equal(store.listMessages("task-1")[0]?.message_id, "msg-2");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("supports a rework attempt and a separate Codex acceptance record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-review-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  store.createOrGet({ taskId: "review-1", messageId: "run-1", objective: "demo", state: "completed", lastMessageId: "run-1" });

  const rework = store.update("review-1", {
    messageId: "run-2",
    lastMessageId: "run-2",
    state: "working",
    report: null,
    reviewNote: null,
    reviewedAt: null,
  });
  assert.equal(rework.messageId, "run-2");
  assert.equal(rework.lastMessageId, "run-2");
  assert.equal(rework.report, undefined);
  assert.equal(rework.reviewNote, undefined);

  const accepted = store.update("review-1", {
    state: "accepted",
    reviewNote: "Diff and tests checked by Codex.",
    reviewedAt: "2026-10-07T00:00:00.000Z",
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.reviewNote, "Diff and tests checked by Codex.");
  assert.equal(accepted.reviewedAt, "2026-10-07T00:00:00.000Z");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("migrates legacy task and message tables without losing history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-migration-"));
  const file = path.join(dir, "tasks.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, objective TEXT NOT NULL, workspace TEXT,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_id TEXT,
      report_json TEXT, cancel_note TEXT
    );
    CREATE TABLE messages (
      task_id TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL,
      msg_type TEXT, created_at TEXT, raw_json TEXT NOT NULL, PRIMARY KEY(task_id, message_id)
    );
    INSERT INTO tasks VALUES ('old', 'old-run', 'original objective', '/project', 'completed', '2026-10-01', '2026-10-02', 'old-result', NULL, 'old note');
  `);
  legacy.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run("old", "old-result", "assistant", '["old work"]', "text", "2026-10-02", JSON.stringify({ message_id: "old-result", role: "assistant", content: ["old work"] }));
  legacy.close();
  let store = new TaskStore(file);
  assert.equal(store.get("old")?.objective, "original objective");
  assert.equal(store.get("old")?.cancelNote, "old note");
  assert.equal(store.listMessages("old")[0]?.content[0], "old work");
  store.update("old", { constraints: ["keep original audio"], acceptanceCommands: ["check media"], sessionId: "session-old" });
  store.beginAttempt("old", { attemptId: "migrated-attempt", messageId: "new-run" });
  assert.equal(store.listMessages("old").length, 0);
  assert.equal(store.listMessages("old", 100, "")[0]?.message_id, "old-result");
  store.close();
  store = new TaskStore(file);
  assert.deepEqual(store.get("old")?.constraints, ["keep original audio"]);
  assert.equal(store.get("old")?.sessionId, "session-old");
  assert.equal(store.listAttempts("old").length, 1);
  assert.equal(store.listMessages("old", 100, "").length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reserves a single durable attempt across two MCP stores and survives restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-reservation-"));
  const file = path.join(dir, "tasks.sqlite");
  let first = new TaskStore(file);
  const second = new TaskStore(file);
  first.createOrGet({ taskId: "active", messageId: "pending", objective: "video", state: "queued", constraints: ["do not change script"], acceptanceCommands: ["ffprobe output.mp4"] });
  first.beginAttempt("active", { attemptId: "attempt-1", messageId: "durable-attempt-1", sessionId: "desktop-session", runtimeSource: "workbuddy-interactive" });
  assert.throws(() => second.beginAttempt("active", { attemptId: "attempt-2", messageId: "durable-attempt-2" }), /active attempt/);
  first.updateAttempt("active", "attempt-1", { state: "working", lastEventSeq: 8, artifacts: ["output.mp4"], evidence: ["tool completed render"], blockingReason: null });
  first.close();
  first = new TaskStore(file);
  const restored = first.get("active")!;
  assert.equal(restored.sessionId, "desktop-session");
  assert.equal(restored.runtimeSource, "workbuddy-interactive");
  assert.equal(restored.lastEventSeq, 8);
  assert.deepEqual(restored.constraints, ["do not change script"]);
  assert.deepEqual(first.listTasks({ states: ["queued", "working"] }).map((task) => task.taskId), ["active"]);
  assert.throws(() => first.beginAttempt("active", { attemptId: "attempt-3", messageId: "durable-attempt-3" }), /active attempt/);
  assert.equal(first.listAttempts("active")[0]?.state, "working");
  first.close();
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isolates rework evidence and messages while keeping the original session and historical attempt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-attempts-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  store.createOrGet({ taskId: "video", messageId: "pending", objective: "make video", state: "queued", constraints: ["original constraints"], acceptanceCommands: ["original checks"] });
  store.beginAttempt("video", { attemptId: "round-1", messageId: "run-1", sessionId: "bound-session", runtimeSource: "interactive" });
  store.addMessages("video", [{ message_id: "same-result-id", role: "assistant", content: ["first result"], metadata: { attemptId: "round-1", eventSeq: 1 } }]);
  store.updateAttempt("video", "round-1", { state: "needs_review", lastEventSeq: 12, artifacts: ["first.mp4"], evidence: ["first render"], report: { filesChanged: ["first.mp4"], commandsRun: ["render first"], rawText: "first result" } });
  store.update("video", { reviewNote: "needs work", reviewedAt: "2026-10-08" });
  const next = store.beginAttempt("video", { attemptId: "round-2", messageId: "run-2" });
  assert.equal(next.attempt, 2);
  assert.equal(next.sessionId, "bound-session");
  assert.equal(next.report, undefined);
  assert.equal(next.reviewNote, undefined);
  assert.equal(next.lastEventSeq, 0);
  assert.deepEqual(next.artifacts, []);
  assert.deepEqual(next.evidence, []);
  assert.deepEqual(next.constraints, ["original constraints"]);
  assert.deepEqual(next.acceptanceCommands, ["original checks"]);
  assert.equal(store.listMessages("video").length, 0);
  assert.equal(store.updateAttempt("video", "round-1", { state: "failed", lastEventSeq: 99, artifacts: ["stale.mp4"] }).applied, false);
  assert.equal(store.addMessages("video", [{ message_id: "same-result-id", role: "assistant", content: ["second result"], metadata: { attemptId: "round-2", eventSeq: 1 } }]), 1);
  assert.equal(store.addMessages("video", [{ message_id: "same-result-id", role: "assistant", content: ["second result"], metadata: { attemptId: "round-2", eventSeq: 1 } }]), 0);
  assert.equal(store.listMessages("video")[0]?.content[0], "second result");
  assert.equal(store.listMessages("video", 100, "round-1")[0]?.content[0], "first result");
  store.updateAttempt("video", "round-2", { state: "working", lastEventSeq: 5 });
  assert.equal(store.updateAttempt("video", "round-2", { lastEventSeq: 3, state: "blocked" }).applied, false);
  assert.equal(store.get("video")?.state, "working");
  assert.deepEqual(store.listAttempts("video").map((attempt) => [attempt.attempt, attempt.artifacts]), [[1, ["first.mp4"]], [2, []]]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("keeps the terminal event visible after a long progress stream", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-events-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  store.createOrGet({ taskId: "long", messageId: "pending", objective: "long task", state: "queued" });
  store.beginAttempt("long", { attemptId: "long-attempt", messageId: "long-run" });
  store.addMessages("long", Array.from({ length: 601 }, (_, index) => ({ message_id: `event-${index + 1}`, role: "assistant", content: [index === 600 ? "final result" : "progress"], metadata: { attemptId: "long-attempt", eventSeq: index + 1 } })));
  const messages = store.listMessages("long", 500);
  assert.equal(messages.length, 500);
  assert.equal(messages[0]?.message_id, "event-102");
  assert.equal(messages.at(-1)?.content[0], "final result");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("protects Codex terminal decisions and atomically checks acceptance state", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-terminal-"));
  const store = new TaskStore(path.join(dir, "private-data", "tasks.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(fs.statSync(path.dirname(store.file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  store.createOrGet({ taskId: "terminal", messageId: "pending", objective: "verify", state: "queued", acceptanceCommands: ["original check"] });
  store.beginAttempt("terminal", { attemptId: "first", messageId: "first-run" });
  assert.equal(store.updateAttempt("terminal", "first", { state: "accepted" }, { expectedStates: ["needs_review", "completed"] }).applied, false);
  store.updateAttempt("terminal", "first", { state: "needs_review" });
  assert.equal(store.updateAttempt("terminal", "first", { state: "accepted", evidence: ["verified artifact"] }, { expectedStates: ["needs_review"] }).applied, true);
  assert.equal(store.updateAttempt("terminal", "first", { state: "needs_review", evidence: [] }).applied, false);
  assert.deepEqual(store.get("terminal")?.evidence, ["verified artifact"]);
  store.beginAttempt("terminal", { attemptId: "second", messageId: "second-run", acceptanceCommands: ["original check", "extra check"] });
  assert.deepEqual(store.get("terminal")?.acceptanceCommands, ["original check", "extra check"]);
  assert.throws(() => store.beginAttempt("terminal", { attemptId: "third", messageId: "third-run", acceptanceCommands: ["rejected parallel requirement"] }), /active attempt/);
  assert.deepEqual(store.get("terminal")?.acceptanceCommands, ["original check", "extra check"]);
  store.update("terminal", { state: "cancelled" });
  assert.equal(store.updateAttempt("terminal", "second", { state: "needs_review" }).applied, false);
  assert.equal(store.get("terminal")?.state, "cancelled");
});
