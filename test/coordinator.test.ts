import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskStore, type StoredTask } from "../src/task-store.js";
import { WorkBuddyClient, type LocalMessage } from "../src/workbuddy-client.js";
import { RunJournal, type RunSnapshot } from "../src/run-journal.js";

class FakeClient extends WorkBuddyClient {
  readonly sent: Array<Parameters<WorkBuddyClient["sendMessage"]>> = [];
  readonly snapshots = new Map<string, RunSnapshot>();
  readonly receivedCursors: Array<string | undefined> = [];
  readonly cancelled: string[] = [];
  batches: LocalMessage[][] = [];
  sendError?: Error;
  private readPause?: { entered: () => void; result: Promise<LocalMessage[]> };
  override async sendMessage(...args: Parameters<WorkBuddyClient["sendMessage"]>) {
    this.sent.push(args);
    if (this.sendError) throw this.sendError;
    const [, , , sessionId, options] = args;
    const attemptId = options!.attemptId!;
    this.snapshots.set(attemptId, { attemptId, taskId: options!.taskId!, status: "queued", sessionId, updatedAt: new Date().toISOString() });
    return { messageId: attemptId, raw: { code: 0, data: { message_id: attemptId } } };
  }
  override async messages(options: { afterMessageId?: string; limit?: number } = {}) {
    this.receivedCursors.push(options.afterMessageId);
    const pause = this.readPause;
    if (pause) { this.readPause = undefined; pause.entered(); return pause.result; }
    return this.batches.shift() ?? [];
  }
  override runSnapshot(attemptId: string) { return this.snapshots.get(attemptId); }
  override cancel(messageId: string) { this.cancelled.push(messageId); return true; }
  pauseNextRead(): { entered: Promise<void>; resume: (messages: LocalMessage[]) => void } {
    let entered!: () => void;
    let resume!: (messages: LocalMessage[]) => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const result = new Promise<LocalMessage[]>((resolve) => { resume = resolve; });
    this.readPause = { entered, result };
    return { entered: enteredPromise, resume };
  }
}

function fixture(t: { after: (fn: () => void) => void }): { dir: string; config: Config; store: TaskStore; client: FakeClient; coordinator: TaskCoordinator } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-coordinator-"));
  const config: Config = { ...loadConfig(), backend: "desktop-acp", dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"), tokenFile: path.join(dir, "unused-credentials.json"), workbuddyConfigDir: path.join(dir, "fake-workbuddy") };
  const store = new TaskStore(config.dbFile);
  const client = new FakeClient(config);
  const coordinator = new TaskCoordinator(config, store, client);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, store, client, coordinator };
}

function event(task: StoredTask, seq: number, text: string, metadata: Record<string, unknown> = {}): LocalMessage {
  return { message_id: `${task.attemptId}:${seq}`, role: metadata.type === "result" ? "assistant" : "system", content: [text], metadata: { attemptId: task.attemptId, eventSeq: seq, sessionId: "fixed-session", runtimeSource: "desktop_interactive", ...metadata } };
}
function finish(client: FakeClient, task: StoredTask, text = "TASK_STATUS: completed\nARTIFACTS:\n- output.mp4\nCOMMANDS_RUN:\n- render video\nTEST_RESULT: render succeeded") {
  client.snapshots.set(task.attemptId!, { attemptId: task.attemptId!, taskId: task.taskId, status: "needs_review", sessionId: "fixed-session", updatedAt: new Date().toISOString() });
  client.batches.push([event(task, 2, text, { type: "result", status: "needs_review", artifacts: ["output.mp4"] })]);
}

async function send(coordinator: TaskCoordinator, workspace: string, taskId = "video") {
  return coordinator.send({ taskId, objective: "make a video", workspace, sessionId: "fixed-session", constraints: ["keep the approved script", "use WorkBuddy tools"], acceptanceCommands: ["inspect the exported media"] });
}

test("idempotent parallel sends reserve one task and dispatch exactly one desktop prompt", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  const results = await Promise.all([send(coordinator, dir), send(coordinator, dir)]);
  assert.equal(client.sent.length, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(store.listAttempts("video").length, 1);
  assert.equal(store.get("video")?.state, "queued");
  const duplicate = await coordinator.send({ taskId: "video", objective: "different duplicate", workspace: dir });
  assert.equal(duplicate.created, false);
  assert.equal(client.sent.length, 1);
  assert.equal(store.get("video")?.objective, "make a video");
});

test("refuses overlapping rework while WorkBuddy is running or waiting for permission", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  await assert.rejects(() => coordinator.continue({ taskId: "video", feedback: "change timing" }), /active worker/);
  const task = store.get("video")!;
  client.snapshots.set(task.attemptId!, { attemptId: task.attemptId!, taskId: task.taskId, status: "working", waitingInput: true, updatedAt: new Date().toISOString() });
  client.batches.push([event(task, 1, "Approve this render tool", { type: "input_request", status: "waiting_input" })]);
  await assert.rejects(() => coordinator.continue({ taskId: "video", feedback: "run again" }), /waiting for input/);
  assert.equal(client.sent.length, 1);
  assert.equal(store.get("video")?.state, "blocked");
  assert.match(store.get("video")?.blockingReason ?? "", /Approve this render tool/);
});

test("streams progress and final results separately and requires independent evidence for acceptance", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const task = store.get("video")!;
  client.batches.push([event(task, 1, "WorkBuddy called the render tool", { type: "tool_call", status: "working" })]);
  assert.equal((await coordinator.sync("video")).state, "working");
  assert.equal(store.get("video")?.report, undefined);
  finish(client, task);
  const result = await coordinator.sync("video");
  assert.equal(result.state, "needs_review");
  assert.equal(result.sessionId, "fixed-session");
  assert.equal(result.runtimeSource, "desktop_interactive");
  assert.deepEqual(result.artifacts, ["output.mp4"]);
  assert.equal(store.listMessages("video").length, 2);
  await assert.rejects(() => coordinator.accept("video", "looks good", []), /concrete evidence/);
  await assert.rejects(() => coordinator.accept("video", "looks good", ["  "]), /concrete evidence/);
  assert.equal(store.get("video")?.state, "needs_review");
  const artifact = path.join(dir, "output.mp4");
  fs.writeFileSync(artifact, "fake test artifact, not a real video");
  const accepted = await coordinator.accept("video", "Media inspected by the reviewer", ["Independent check: file exists and has expected test bytes"], [artifact]);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.evidence?.length, 2);
  assert.ok(accepted.evidence?.some((value) => value.includes(artifact)));
  assert.equal(store.listAttempts("video")[0]?.state, "accepted");
});

test("keeps the verified desktop session, objective, original constraints and acceptance checks across rework", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const first = store.get("video")!;
  finish(client, first);
  await coordinator.sync("video");
  await coordinator.continue({ taskId: "video", feedback: "Correct the subtitle timing only", acceptanceCommands: ["check subtitle timing"] });
  const second = store.get("video")!;
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(second.attempt, 2);
  assert.equal(second.sessionId, "fixed-session");
  assert.deepEqual(second.constraints, ["keep the approved script", "use WorkBuddy tools"]);
  assert.deepEqual(second.acceptanceCommands, ["inspect the exported media", "check subtitle timing"]);
  assert.equal(client.sent[1]?.[3], "fixed-session");
  assert.equal(client.sent[1]?.[4]?.sessionMode, "existing");
  const prompt = client.sent[1]?.[0] ?? "";
  for (const value of [first.objective, ...first.constraints!, ...second.acceptanceCommands!, "Correct the subtitle timing only"]) assert.ok(prompt.includes(value));
  assert.equal(second.report, undefined);
  assert.deepEqual(second.artifacts, []);
  client.batches.push([event(first, 99, "Stale first-round completion", { type: "result", status: "needs_review", artifacts: ["stale.mp4"] }), event(second, 1, "Second round tool call", { type: "tool_call", status: "working" })]);
  const synced = await coordinator.sync("video");
  assert.equal(synced.state, "working");
  assert.equal(synced.lastEventSeq, 1);
  assert.equal(synced.report, undefined);
  assert.deepEqual(synced.artifacts, []);
  assert.equal(store.listMessages("video").length, 1);
  assert.equal(store.listMessages("video", 100, first.attemptId).length, 2);
});

test("concurrent rework dispatches one prompt and cannot add rejected requirements to its running attempt", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  finish(client, store.get("video")!);
  await coordinator.sync("video");
  const results = await Promise.allSettled([
    coordinator.continue({ taskId: "video", feedback: "first rework", acceptanceCommands: ["first rework check"] }),
    coordinator.continue({ taskId: "video", feedback: "second overlapping rework", acceptanceCommands: ["rejected second check"] }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(client.sent.length, 2);
  assert.deepEqual(store.get("video")?.acceptanceCommands, ["inspect the exported media", "first rework check"]);
});

test("a cancellation during an in-flight poll cannot be overwritten by its late terminal result", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const task = store.get("video")!;
  const paused = client.pauseNextRead();
  const polling = coordinator.sync("video");
  await paused.entered;
  const cancellation = coordinator.cancel("video", "Stop while the operator inspects desktop execution");
  assert.equal(cancellation.remoteStopped, false);
  assert.equal(cancellation.task.state, "cancelled");
  assert.deepEqual(client.cancelled, [task.messageId]);
  paused.resume([event(task, 1, "TASK_STATUS: completed\nLate result", { type: "result", status: "needs_review" })]);
  assert.equal((await polling).state, "cancelled");
  assert.equal(store.get("video")?.state, "cancelled");
  await assert.rejects(() => coordinator.continue({ taskId: "video", feedback: "restart" }), /Cancelled tasks/);
});

test("a stale result cannot turn an accepted task back into review or replace its evidence", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const task = store.get("video")!;
  finish(client, task);
  await coordinator.sync("video");
  const paused = client.pauseNextRead();
  const polling = coordinator.sync("video");
  await paused.entered;
  await coordinator.accept("video", "checked", ["Independent artifact inspection passed"]);
  paused.resume([event(task, 3, "TASK_STATUS: completed\nRepeated old result", { type: "result", status: "needs_review" })]);
  assert.equal((await polling).state, "accepted");
  assert.deepEqual(store.get("video")?.evidence, ["Independent artifact inspection passed"]);
});

test("blocks a failed dispatch and rejects acceptance from unverified hidden backends", async (t) => {
  const { dir, config, store, client, coordinator } = fixture(t);
  client.sendError = new Error("No visible desktop session available");
  const result = await send(coordinator, dir);
  assert.equal(result.ok, false);
  assert.equal(result.task?.state, "blocked");
  assert.match(result.task?.blockingReason ?? "", /No visible desktop session/);
  assert.equal(store.listAttempts("video").length, 1);
  await assert.rejects(() => coordinator.accept("video", "accept failed task", ["some evidence"]), /finish the turn/);
  const hidden = new TaskCoordinator({ ...config, backend: "gateway" }, store, client);
  await assert.rejects(() => hidden.send({ objective: "test" }), /requires WORKBUDDY_BACKEND=desktop-queue or desktop-acp/);
});

test("an acceptance decision cannot overwrite a rework reserved by another MCP process", async (t) => {
  const { dir, config, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const originalAttempt = store.get("video")!;
  finish(client, originalAttempt);
  await coordinator.sync("video");
  const otherProcessStore = new TaskStore(config.dbFile);
  t.after(() => otherProcessStore.close());
  const reservedId = RunJournal.newId();
  const updateAttempt = store.updateAttempt.bind(store);
  store.updateAttempt = (taskId, attemptId, patch, options) => {
    if (patch.state === "accepted") otherProcessStore.beginAttempt(taskId, { attemptId: reservedId, messageId: reservedId });
    return updateAttempt(taskId, attemptId, patch, options);
  };
  await assert.rejects(() => coordinator.accept("video", "accept the old output", ["Old attempt was inspected"]), /changed|active|attempt|acceptance/i);
  const current = store.get("video")!;
  assert.equal(current.attemptId, reservedId);
  assert.equal(current.state, "queued");
  assert.deepEqual(current.evidence, []);
  assert.equal(store.listAttempts("video")[0]?.state, "needs_review");
});
