import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { DesktopQueue, assertDesktopCaller } from "../src/desktop-queue.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { RunJournal } from "../src/run-journal.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-queue-unit-"));
  const config: Config = { ...loadConfig(), backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), workbuddyConfigDir: dir, runsDir: path.join(dir, "runs") };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run("unit-session", dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  const client = new WorkBuddyClient(config);
  const coordinator = new TaskCoordinator(config, store, client);
  // Unit fixture only. Production CLI always uses actual native process ancestry.
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (taskId = "unit-task") => coordinator.send({ taskId, objective: "Unit transport fixture", workspace: dir, sessionId: "unit-session", constraints: ["Keep original constraint"], timeoutSeconds: 120 });
  return { dir, config, store, client, coordinator, queue, send };
}

test("queue dispatch does not claim provenance; native claim/report survive reconnect and same-session rework", async (t) => {
  const f = fixture(t);
  await f.send();
  const initial = f.store.get("unit-task")!;
  assert.equal(initial.runtimeSource, undefined);
  const claim = await f.queue.claim("unit-session", 0);
  assert.equal(claim.status, "task");
  if (claim.status !== "task") throw new Error("Expected claim");
  const firstAttempt = claim.attemptId;
  assert.equal((await f.coordinator.sync("unit-task")).state, "working");
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "", artifacts: [] }), /empty report/);
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: unit fixture report", artifacts: [] });
  const restarted = new TaskCoordinator(f.config, f.store, new WorkBuddyClient(f.config));
  const result = await restarted.sync("unit-task");
  assert.equal(result.state, "needs_review");
  assert.equal(result.runtimeSource, "desktop_queue");
  await restarted.continue({ taskId: "unit-task", feedback: "Correct the third item" });
  const second = await f.queue.claim("unit-session", 0);
  if (second.status !== "task") throw new Error("Expected rework claim");
  assert.notEqual(second.attemptId, firstAttempt);
  assert.equal(second.sessionId, claim.sessionId);
  assert.match(second.prompt, /Keep original constraint/);
  assert.match(second.prompt, /Correct the third item/);
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "late old report", artifacts: [] }), /no longer active/);
  f.queue.report({ ...second, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: rework fixture report", artifacts: [] });
  assert.equal((await restarted.accept("unit-task", "Unit state-machine verification", ["Verified unit transport report and same session identity"])).state, "accepted");
});

test("queue rejects wrong leases, sessions, unsupported model changes and overlapping claims", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  assert.throws(() => f.queue.progress({ ...claim, leaseToken: "wrong", text: "x" }), /execution lease/);
  assert.throws(() => f.queue.progress({ ...claim, sessionId: "other", text: "x" }), /execution lease/);
  await f.send("second-task");
  await assert.rejects(() => f.queue.claim("unit-session", 0), /unfinished queue task/);
  const r = { attemptId: RunJournal.newId(), taskId: "unsupported", prompt: "x", timeoutSeconds: 10, sessionId: "unit-session" };
  assert.throws(() => f.queue.start({ ...r, model: "different" }), /desktop conversation/);
  assert.throws(() => f.queue.start({ ...r, sessionMode: "new" }), /dedicated native/);
  assert.throws(() => f.queue.start({ ...r, workspace: path.join(f.dir, "other") }), /workspace differs/);
});

test("queue cancellation is observed by native report; deadline blocks without resending", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  f.coordinator.cancel("unit-task");
  assert.equal(f.queue.progress({ ...claim, text: "Checking cancellation" }).cancellationRequested, true);
  assert.equal(f.queue.report({ ...claim, status: "completed", text: "Stopped", artifacts: [] }).status, "cancelled");
  await f.send("deadline-task");
  const task = f.store.get("deadline-task")!;
  const journal = new RunJournal(f.queue.root, task.attemptId!);
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  const blocked = await f.coordinator.sync("deadline-task");
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.blockingReason!, /no automatic resend/);
  assert.equal((await f.queue.claim("unit-session", 0)).status, "retry");
});

test("production worker rejects Codex-side invocation", (t) => {
  const f = fixture(t);
  assert.throws(() => assertDesktopCaller({ ...f.config, cliElectronPath: path.join(f.dir, "nonexistent-native-desktop") }), /real WorkBuddy desktop/);
});

test("active queue listeners are visible only during native claim wait", async (t) => {
  const f = fixture(t);
  const waiting = f.queue.claim("unit-session", 0.3);
  assert.equal(f.queue.listeners().length, 1);
  assert.equal((await f.client.health("unit-session")).ready, true);
  assert.equal((await waiting).status, "retry");
  assert.equal(f.queue.listeners().length, 0);
});

test("bootstrap instructions do not pretend to start a worker and preserve quoted installation paths", (t) => {
  const f = fixture(t);
  const prepared = f.queue.prepare("unit-session");
  assert.equal(prepared.started, false);
  assert.equal(prepared.workspace, f.dir);
  assert.match(prepared.prompt, /claim --session-id 'unit-session'/);
  assert.match(prepared.prompt, /立即再次运行 claim/);
  assert.throws(() => f.queue.prepare("missing-session"), /not registered/);
});

test("a rejected queue dispatch remains inspectable and can be corrected without losing its task", async (t) => {
  const f = fixture(t);
  const rejected = await f.coordinator.send({ taskId: "rejected-model", objective: "Fixture task", workspace: f.dir, sessionId: "unit-session", model: "unavailable-remote-selection" });
  assert.equal(rejected.ok, false);
  assert.equal((await f.coordinator.sync("rejected-model")).state, "blocked");
  await f.coordinator.continue({ taskId: "rejected-model", feedback: "Use the native desktop model already selected" });
  assert.equal((await f.queue.claim("unit-session", 0)).status, "task");
});
