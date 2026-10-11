import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DeepSeekStore } from "../src/deepseek-store.js";
import { DeepSeekCoordinator } from "../src/deepseek-coordinator.js";
import { DeepSeekRpcError, type DeepSeekEvent, type DeepSeekTransport, type DeepSeekSession } from "../src/deepseek-client.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
class MockPlugin implements DeepSeekTransport {
  prompts: Array<{ hostId: string; sessionId: string; requestId: string; text: string }> = [];
  log: DeepSeekEvent[] = []; disconnect = false; losePromptReply = false; cancelCalls = 0; stopped = false;
  constructor(readonly workspace: string) {}
  resolveHostId(hostId = "host") { return hostId; }
  async health() { return { ready: true }; }
  async sessions() { return { sessions: [await this.session({ sessionId: "session" })] }; }
  async create() { return this.session({ sessionId: "new-session" }); }
  async session({ sessionId }: { hostId?: string; sessionId: string }): Promise<DeepSeekSession> { return { sessionId, workspace: this.workspace, busy: false }; }
  async prompt(input: { hostId: string; sessionId: string; requestId: string; text: string }) { this.prompts.push(input); if (this.losePromptReply) throw new Error("reply lost after acceptance"); return { accepted: true, requestId: input.requestId, turnId: `turn-${input.requestId}` }; }
  async events({ afterSeq, limit }: { hostId: string; sessionId: string; requestId: string; afterSeq: number; limit: number }) {
    if (this.disconnect) throw new Error("socket offline");
    const events = this.log.filter((event) => event.seq > afterSeq).slice(0, limit);
    return { events, cursor: events.at(-1)?.seq ?? afterSeq };
  }
  async cancel() { this.cancelCalls++; return { requested: true, stopped: this.stopped }; }
  emit(requestId: string, type: DeepSeekEvent["type"], text = "", turnId = `turn-${requestId}`) { this.log.push({ seq: this.log.length, requestId, turnId, type, text }); }
}
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-logic-"));
  const file = path.join(dir, "tasks.sqlite"); const store = new DeepSeekStore(file); const plugin = new MockPlugin(dir);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true })); cleanups.push(() => store.close());
  return { dir, file, store, plugin, coordinator: new DeepSeekCoordinator(store, plugin) };
}
test("taskId duplicate dispatches once and atomically locks a session across stores", async () => {
  const { coordinator, plugin, file } = setup();
  const task = await coordinator.send({ taskId: "one", objective: "write", sessionId: "session" });
  const secondStore = new DeepSeekStore(file); cleanups.push(() => secondStore.close());
  const second = new DeepSeekCoordinator(secondStore, plugin);
  assert.equal((await second.send({ taskId: "one", objective: "different", sessionId: "session" })).created, false);
  await assert.rejects(second.send({ taskId: "two", objective: "overlap", sessionId: "session" }), /active task one/);
  assert.equal(plugin.prompts.length, 1);
  assert.equal(task.task.requestId, secondStore.get("one")?.requestId);
});
test("a lost prompt reply is uncertain, never automatically resent, and recovered from persisted events", async () => {
  const { coordinator, plugin, file } = setup(); plugin.losePromptReply = true;
  const sent = await coordinator.send({ taskId: "uncertain", objective: "write", sessionId: "session" });
  assert.equal(sent.task.runOpen, true); assert.equal(sent.task.dispatchState, "uncertain");
  await assert.rejects(coordinator.continue({ taskId: "uncertain", feedback: "retry" }), /not been confirmed stopped/);
  const recoveredStore = new DeepSeekStore(file); cleanups.push(() => recoveredStore.close());
  const recovered = new DeepSeekCoordinator(recoveredStore, plugin);
  await recovered.send({ taskId: "uncertain", objective: "write", sessionId: "session" });
  assert.equal(plugin.prompts.length, 1);
  plugin.emit(sent.task.requestId, "started", "actually accepted"); plugin.emit(sent.task.requestId, "completed", "created artifact");
  const result = await recovered.sync("uncertain"); assert.equal(result.state, "needs_review"); assert.equal(result.runOpen, false);
});
test("only matching request and turn can finish the current attempt; late old events cannot finish rework", async () => {
  const { coordinator, plugin, store } = setup();
  const first = (await coordinator.send({ taskId: "rework", objective: "preserve original", sessionId: "session", constraints: ["keep existing"], acceptanceCommands: ["check one"] })).task;
  plugin.emit("other-request", "completed", "foreign"); plugin.emit(first.requestId, "completed", "wrong turn", "unrelated-turn");
  assert.equal((await coordinator.sync("rework")).state, "working");
  plugin.emit(first.requestId, "completed", "version one"); assert.equal((await coordinator.sync("rework")).state, "needs_review");
  const next = (await coordinator.continue({ taskId: "rework", feedback: "fix one detail", acceptanceCommands: ["check two"] })).task;
  assert.equal(next.sessionId, first.sessionId); assert.notEqual(next.requestId, first.requestId); assert.equal(next.attempt, 2);
  assert.match(plugin.prompts[1]!.text, /preserve original/); assert.match(plugin.prompts[1]!.text, /keep existing/); assert.match(plugin.prompts[1]!.text, /check one/); assert.match(plugin.prompts[1]!.text, /check two/);
  plugin.emit(first.requestId, "completed", "late old result"); assert.equal((await coordinator.sync("rework")).state, "working");
  plugin.emit(next.requestId, "completed", "version two"); const final = await coordinator.sync("rework"); assert.equal(final.report, "version two");
  assert.equal(store.attempts("rework")[0]?.report, "version one"); assert.equal(store.attempts("rework").length, 2);
});
test("disconnect and deadline block supervision while retaining active session ownership", async () => {
  const { coordinator, plugin, store } = setup();
  const sent = (await coordinator.send({ taskId: "timeout", objective: "long task", sessionId: "session" })).task;
  plugin.disconnect = true; assert.equal((await coordinator.sync("timeout")).state, "blocked");
  plugin.disconnect = false; store.update(sent.taskId, sent.attemptId, { deadlineAt: "2000-01-01T00:00:00.000Z" });
  const timed = await coordinator.sync("timeout"); assert.equal(timed.runOpen, true); assert.match(timed.blockingReason!, /deadline elapsed/);
  await assert.rejects(coordinator.send({ taskId: "cannot-overlap", objective: "new", sessionId: "session" }), /active task/);
  await assert.rejects(coordinator.continue({ taskId: "timeout", feedback: "try again" }), /not been confirmed stopped/);
  plugin.emit(sent.requestId, "completed", "late real completion"); assert.equal((await coordinator.sync("timeout")).state, "needs_review");
  assert.equal(plugin.prompts.length, 1);
});
test("cancellation request is distinct from confirmed stop and cannot unlock a live session", async () => {
  const { coordinator, plugin } = setup(); const task = (await coordinator.send({ taskId: "cancel", objective: "long", sessionId: "session" })).task;
  const pending = await coordinator.cancel("cancel", "stop work"); assert.equal(pending.remoteStopped, false); assert.equal(pending.task.cancelRequested, true); assert.equal(pending.task.runOpen, true);
  await assert.rejects(coordinator.continue({ taskId: "cancel", feedback: "replacement" }), /not been confirmed stopped/);
  plugin.emit(task.requestId, "progress", "still finishing tool"); assert.equal((await coordinator.sync("cancel")).state, "blocked");
  plugin.emit(task.requestId, "cancelled", "tool stopped"); const stopped = await coordinator.sync("cancel"); assert.equal(stopped.state, "cancelled"); assert.equal(stopped.runOpen, false);
  await coordinator.send({ taskId: "after-stop", objective: "new task", sessionId: "session" }); assert.equal(plugin.prompts.length, 2);
});
test("waiting for permission remains active and rework cannot bypass the pending input", async () => {
  const { coordinator, plugin } = setup(); const task = (await coordinator.send({ taskId: "permission", objective: "work", sessionId: "session" })).task;
  plugin.emit(task.requestId, "waiting_input", "Approve file write in Harness"); const pending = await coordinator.sync("permission");
  assert.equal(pending.state, "blocked"); assert.equal(pending.runOpen, true); await assert.rejects(coordinator.continue({ taskId: "permission", feedback: "continue" }), /not been confirmed stopped/);
});
test("acceptance needs confirmed completion, independent evidence and real nonempty artifact paths", async () => {
  const { coordinator, plugin, dir } = setup(); const task = (await coordinator.send({ taskId: "accept", objective: "write", sessionId: "session" })).task;
  await assert.rejects(coordinator.accept("accept", "done", ["checked"]), /confirmed completed/);
  plugin.emit(task.requestId, "completed", "created output"); await coordinator.sync("accept");
  await assert.rejects(coordinator.accept("accept", "done", []), /concrete evidence/);
  await assert.rejects(coordinator.accept("accept", "done", ["read output"], [path.join(dir, "missing")]), /ENOENT/);
  const output = path.join(dir, "output.md"); fs.writeFileSync(output, "verified content");
  const accepted = await coordinator.accept("accept", "reviewed", ["Read output.md and confirmed requested content"], [output]); assert.equal(accepted.state, "accepted");
  plugin.emit(task.requestId, "failed", "late failure"); assert.equal((await coordinator.sync("accept")).state, "accepted");
});
test("stale callback cannot regress a completed or accepted attempt", async () => {
  const { coordinator, plugin, store } = setup(); const task = (await coordinator.send({ taskId: "race", objective: "finish", sessionId: "session" })).task;
  plugin.emit(task.requestId, "completed", "done"); await coordinator.sync("race");
  const stale = store.update(task.taskId, task.attemptId, { state: "working" }, { expectedOpen: true }); assert.equal(stale.state, "needs_review");
});

test("native zero-based first event recovers an uncertain dispatch", async () => {
  const { coordinator, plugin, store } = setup(); plugin.losePromptReply = true;
  const task = (await coordinator.send({ taskId: "seq-zero", objective: "recover first event", sessionId: "session" })).task;
  assert.equal(task.lastEventSeq, -1);
  plugin.emit(task.requestId, "accepted", "accepted at sequence zero");
  const recovered = await coordinator.sync("seq-zero");
  assert.equal(recovered.dispatchState, "accepted"); assert.equal(recovered.lastEventSeq, 0); assert.equal(recovered.state, "working");
  assert.equal(store.events(task.attemptId)[0]?.seq, 0);
});

test("a completed turn without an assistant result cannot accept a user prompt as report", async () => {
  const { coordinator, plugin } = setup();
  const task = (await coordinator.send({ taskId: "no-result", objective: "create output", sessionId: "session" })).task;
  plugin.emit(task.requestId, "progress", "user task text, not a result");
  plugin.emit(task.requestId, "completed");
  const completed = await coordinator.sync("no-result"); assert.equal(completed.report, ""); assert.equal(completed.state, "needs_review");
  await assert.rejects(coordinator.accept("no-result", "done", ["claimed verified"]), /no result text or artifact evidence/);
});

test("explicit pre-admission rejection releases its reservation; admission-unknown remains locked", async () => {
  const { coordinator, plugin } = setup();
  plugin.prompt = async () => { throw new DeepSeekRpcError("bridge/session-busy", "another turn won the admission race", true); };
  const rejected = await coordinator.send({ taskId: "rejected", objective: "work", sessionId: "session" });
  assert.equal(rejected.task.runOpen, false); assert.equal(rejected.task.dispatchState, "rejected"); assert.equal(rejected.task.state, "failed");
  plugin.prompt = async () => { throw new DeepSeekRpcError("bridge/admission-unknown", "native call may have submitted"); };
  const unknown = await coordinator.send({ taskId: "unknown", objective: "work", sessionId: "session" });
  assert.equal(unknown.task.runOpen, true); assert.equal(unknown.task.dispatchState, "uncertain");
  await assert.rejects(coordinator.send({ taskId: "overlap", objective: "work", sessionId: "session" }), /active task unknown/);
});
test("a real assistant report declaring blocked is not eligible for acceptance", async () => {
  const { coordinator, plugin } = setup(); const task = (await coordinator.send({ taskId: "declared-blocked", objective: "work", sessionId: "session" })).task;
  plugin.emit(task.requestId, "completed", "TASK_STATUS: blocked\nREMAINING_PROBLEMS: missing input");
  const result = await coordinator.sync(task.taskId); assert.equal(result.state, "blocked"); assert.equal(result.runOpen, false);
  await assert.rejects(coordinator.accept(task.taskId, "done", ["checked"]), /confirmed completed/);
});

test("identity or not-found errors after native admission never release an uncertain run", async () => {
  const { coordinator, plugin } = setup();
  plugin.prompt = async () => { throw new DeepSeekRpcError("bridge/session-identity-mismatch", "second inspect failed after admission"); };
  const result = await coordinator.send({ taskId: "post-admission", objective: "work", sessionId: "session" });
  assert.equal(result.task.runOpen, true); assert.equal(result.task.dispatchState, "uncertain");
});

test("disconnect then empty successful page clears only a transport blocker and wait remains bounded", async () => {
  const { coordinator, plugin } = setup();
  await coordinator.send({ taskId: "transport-recovery", objective: "long tool", sessionId: "session" });
  plugin.disconnect = true; const disconnected = await coordinator.sync("transport-recovery");
  assert.equal(disconnected.blockingKind, "transport"); assert.match(disconnected.syncError!, /socket offline/);
  plugin.disconnect = false; const recovered = await coordinator.sync("transport-recovery");
  assert.equal(recovered.state, "working"); assert.equal(recovered.blockingReason, undefined); assert.equal(recovered.syncError, undefined);
  const started = Date.now(); const waited = await coordinator.wait("transport-recovery", 0.04);
  assert.equal(waited.task.state, "working"); assert.ok(Date.now() - started >= 20); assert.ok(Date.now() - started < 1000);
});
test("transport recovery preserves permission and cancellation blockers on empty event pages", async () => {
  const { coordinator, plugin } = setup(); const task = (await coordinator.send({ taskId: "preserve-blocker", objective: "needs input", sessionId: "session" })).task;
  plugin.emit(task.requestId, "waiting_input", "Approve in App"); await coordinator.sync(task.taskId);
  plugin.disconnect = true; const lost = await coordinator.sync(task.taskId); assert.equal(lost.blockingKind, "waiting_input"); assert.equal(lost.blockingReason, "Approve in App");
  plugin.disconnect = false; const connected = await coordinator.sync(task.taskId); assert.equal(connected.state, "blocked"); assert.equal(connected.blockingKind, "waiting_input");
  await coordinator.cancel(task.taskId); plugin.disconnect = true; await coordinator.sync(task.taskId); plugin.disconnect = false;
  const cancelled = await coordinator.sync(task.taskId); assert.equal(cancelled.blockingKind, "cancel_requested"); assert.equal(cancelled.runOpen, true);
});
test("oversized event pages shrink adaptively, persist the safe size and recover every event without redispatch", async () => {
  const { coordinator, plugin, store } = setup(); const task = (await coordinator.send({ taskId: "large-page", objective: "large output", sessionId: "session" })).task;
  for (let i = 0; i < 7; i++) plugin.emit(task.requestId, "progress", `tool progress ${i}`); plugin.emit(task.requestId, "completed", "actual result");
  const originalEvents = plugin.events.bind(plugin); const limits: number[] = [];
  plugin.events = async (input) => { limits.push(input.limit); if (input.limit > 3) throw new DeepSeekRpcError("bridge/response-too-large", "Use smaller event page limit"); return originalEvents(input); };
  let synced = await coordinator.sync(task.taskId); assert.equal(synced.eventPageLimit, 3); assert.deepEqual(limits, [100, 50, 25, 12, 6, 3]);
  synced = await coordinator.sync(task.taskId); synced = await coordinator.sync(task.taskId);
  assert.equal(synced.state, "needs_review"); assert.equal(synced.lastEventSeq, 7); assert.equal(store.events(task.attemptId).length, 8); assert.equal(plugin.prompts.length, 1);
  assert.deepEqual(limits.slice(6), [3, 3]);
});
test("a single oversized event remains explicitly blocked at page size one without releasing ownership", async () => {
  const { coordinator, plugin } = setup(); const task = (await coordinator.send({ taskId: "huge-event", objective: "huge single output", sessionId: "session" })).task;
  const limits: number[] = []; plugin.events = async (input) => { limits.push(input.limit); throw new DeepSeekRpcError("bridge/response-too-large", "too large"); };
  const blocked = await coordinator.sync(task.taskId); assert.equal(blocked.state, "blocked"); assert.equal(blocked.runOpen, true); assert.equal(blocked.eventPageLimit, 1); assert.match(blocked.blockingReason!, /One persisted Harness event/);
  limits.length = 0; await coordinator.sync(task.taskId); assert.deepEqual(limits, [1]); assert.equal(plugin.prompts.length, 1);
});
test("pre-admission marker is required before an RPC rejection can release the session lock", async () => {
  const { coordinator, plugin } = setup(); plugin.prompt = async () => { throw new DeepSeekRpcError("bridge/session-busy", "unmarked rejection"); };
  const task = (await coordinator.send({ taskId: "unmarked", objective: "work", sessionId: "session" })).task;
  assert.equal(task.runOpen, true); assert.equal(task.dispatchState, "uncertain");
});

test("routine progress cannot clear a pending input or cancellation; a new native step resumes input", async () => {
  const { coordinator, plugin } = setup();
  const task = (await coordinator.send({ taskId: "input-progress", objective: "work", sessionId: "session" })).task;
  plugin.emit(task.requestId, "waiting_input", "Answer the pending Harness question");
  plugin.emit(task.requestId, "progress", "Unrelated tool telemetry");
  const waiting = await coordinator.sync(task.taskId);
  assert.equal(waiting.state, "blocked"); assert.equal(waiting.blockingKind, "waiting_input");
  assert.equal(waiting.blockingReason, "Answer the pending Harness question");
  plugin.log.push({ seq: plugin.log.length, requestId: task.requestId, turnId: task.turnId, type: "progress", rawType: "step/start" });
  assert.equal((await coordinator.sync(task.taskId)).state, "working");
  await coordinator.cancel(task.taskId);
  plugin.emit(task.requestId, "waiting_input", "A question was logged while stopping");
  const stopping = await coordinator.sync(task.taskId);
  assert.equal(stopping.blockingKind, "cancel_requested"); assert.equal(stopping.runOpen, true);
});

test("rework can explicitly replace obsolete acceptance checks while retaining original scope and history", async () => {
  const { coordinator, plugin, store } = setup();
  const first = (await coordinator.send({ taskId: "revised-checks", objective: "create version one", sessionId: "session", constraints: ["Only output.json"], acceptanceCommands: ["version must be 1"] })).task;
  plugin.emit(first.requestId, "completed", "version one ready"); await coordinator.sync(first.taskId);
  const next = (await coordinator.continue({ taskId: first.taskId, feedback: "Change version to 2", acceptanceCommands: ["version must be 2"], acceptanceMode: "replace" })).task;
  assert.deepEqual(next.acceptanceCommands, ["version must be 2"]);
  assert.deepEqual(next.constraints, ["Only output.json"]); assert.equal(next.sessionId, first.sessionId);
  assert.doesNotMatch(plugin.prompts[1]!.text, /version must be 1/);
  assert.deepEqual(store.attempts(first.taskId)[0]?.acceptanceCommands, ["version must be 1"]);
});

test("empty replacement checks reject before reserving a new attempt", async () => {
  const { coordinator, plugin, store } = setup();
  const task = (await coordinator.send({ taskId: "empty-checks", objective: "work", sessionId: "session" })).task;
  plugin.emit(task.requestId, "completed", "done"); await coordinator.sync(task.taskId);
  await assert.rejects(coordinator.continue({ taskId: task.taskId, feedback: "update", acceptanceMode: "replace", acceptanceCommands: [] }), /nonempty complete revised list/);
  assert.equal(plugin.prompts.length, 1); assert.equal(store.get(task.taskId)?.attempt, 1);
});
