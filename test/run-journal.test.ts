import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { DurableRuns, RunJournal, writePrivateJson, type RunRequest, type RunSnapshot } from "../src/run-journal.js";

function fixture(t: { after: (fn: () => void) => void }): { dir: string; config: Config; journal: RunJournal; request: RunRequest } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config: Config = { ...loadConfig(), dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"), workbuddyConfigDir: path.join(dir, "fake-workbuddy") };
  const attemptId = RunJournal.newId();
  const journal = new RunJournal(config.runsDir!, attemptId);
  const request: RunRequest = { attemptId, taskId: "task-durable", prompt: "Create an artifact in the task workspace", workspace: path.join(dir, "workspace"), timeoutSeconds: 600 };
  writePrivateJson(path.join(journal.dir, "request.json"), request);
  return { dir, config, journal, request };
}

function snapshot(journal: RunJournal, state: Partial<RunSnapshot> = {}): RunSnapshot {
  return { attemptId: journal.attemptId, taskId: "task-durable", status: "working", pid: process.pid, sessionId: "bound-workbuddy-session", runtimeSource: "workbuddy-interactive", updatedAt: new Date().toISOString(), ...state };
}

function mode(file: string): number { return fs.statSync(file).mode & 0o777; }

test("replays durable events across MCP restarts with cursors beyond the first 100 updates", (t) => {
  const { config, journal, request } = fixture(t);
  journal.save(snapshot(journal));
  for (let index = 1; index <= 125; index++) journal.append("progress", `tool event ${index}`, { toolCallId: `tool-${index}` });
  journal.append("result", "Rendered output.mp4", { status: "needs_review", artifacts: ["output.mp4"] });
  journal.save(snapshot(journal, { status: "needs_review", text: "Rendered output.mp4", artifacts: ["output.mp4"], stopReason: "end_turn" }));

  const firstServer = new DurableRuns(config);
  const firstPage = firstServer.messages(journal.attemptId, 100);
  assert.equal(firstPage.length, 100);
  assert.equal(firstPage.at(-1)?.message_id, `${journal.attemptId}:100`);
  assert.equal(firstPage[0]?.metadata?.sessionId, "bound-workbuddy-session");
  assert.equal(firstPage[0]?.metadata?.runtimeSource, "workbuddy-interactive");

  const reopenedServer = new DurableRuns(config);
  const remainder = reopenedServer.messages(firstPage.at(-1)!.message_id, 100);
  assert.equal(remainder.length, 26);
  assert.equal(remainder[0]?.metadata?.eventSeq, 101);
  assert.equal(remainder.at(-1)?.metadata?.status, "needs_review");
  assert.deepEqual(remainder.at(-1)?.metadata?.artifacts, ["output.mp4"]);
  assert.equal(reopenedServer.messages(remainder.at(-1)!.message_id).length, 0);
  assert.deepEqual(new RunJournal(reopenedServer.root, request.attemptId).request(), request);
  assert.equal(new RunJournal(reopenedServer.root, request.attemptId).append("review", "Codex inspecting artifact").seq, 127);
});

test("blocks a dead worker once without replaying its prompt or creating another attempt", (t) => {
  const { config, journal } = fixture(t);
  journal.save(snapshot(journal, { pid: 2147483647 }));
  journal.append("tool_call", "render was dispatched");
  const requestFile = path.join(journal.dir, "request.json");
  const originalRequest = fs.readFileSync(requestFile, "utf8");
  const originalDirs = fs.readdirSync(config.runsDir!);
  const server = new DurableRuns(config);
  const events = server.messages(journal.attemptId);
  assert.equal(journal.snapshot()?.status, "blocked");
  assert.equal(events.at(-1)?.metadata?.status, "blocked");
  assert.match(String(events.at(-1)?.content[0]), /not automatically resent/);
  const seq = events.at(-1)!.message_id;
  assert.equal(new DurableRuns(config).messages(seq).length, 0);
  assert.deepEqual(fs.readdirSync(config.runsDir!), originalDirs);
  assert.equal(fs.readFileSync(requestFile, "utf8"), originalRequest);
  assert.equal(journal.events(0, Infinity).filter((event) => event.type === "result").length, 1);
});

test("queued startup grace and live workers are not mistaken for dead execution", (t) => {
  const { config, journal } = fixture(t);
  journal.save(snapshot(journal, { status: "queued", pid: undefined }));
  journal.append("status", "starting");
  new DurableRuns(config).messages(journal.attemptId);
  assert.equal(journal.snapshot()?.status, "queued");
  journal.save(snapshot(journal));
  new DurableRuns(config).messages(journal.attemptId);
  assert.equal(journal.snapshot()?.status, "working");
  writePrivateJson(path.join(journal.dir, "state.json"), snapshot(journal, { status: "queued", pid: undefined, updatedAt: new Date(Date.now() - 60_000).toISOString() }));
  new DurableRuns(config).messages(journal.attemptId);
  assert.equal(journal.snapshot()?.status, "blocked");
});

test("reports unrecoverable legacy runs as blocked and refuses missing journals", (t) => {
  const { config } = fixture(t);
  const server = new DurableRuns(config);
  const legacy = server.messages("acp-legacy-in-memory-id");
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0]?.metadata?.status, "blocked");
  assert.equal(legacy[0]?.metadata?.source, "legacy-unrecoverable");
  assert.match(String(legacy[0]?.content[0]), /cannot be recovered/);
  assert.equal(server.cancel("acp-legacy-in-memory-id"), false);
  assert.throws(() => server.messages(RunJournal.newId()), /not found; refusing/);
  assert.throws(() => new RunJournal(server.root, "../../private"), /Invalid run journal identity/);
});

test("creates private run files and persists cancellation for the detached worker", (t) => {
  const { config, journal } = fixture(t);
  journal.save(snapshot(journal));
  journal.append("progress", "private task progress");
  const server = new DurableRuns(config);
  assert.equal(server.cancel(`${journal.attemptId}:1`), true);
  assert.equal(new RunJournal(server.root, journal.attemptId).cancellationRequested(), true);
  // Cancellation is a durable request. Only the worker can report whether the
  // actual WorkBuddy task has stopped, so the snapshot is still working here.
  assert.equal(journal.snapshot()?.status, "working");
  assert.equal(mode(journal.dir), 0o700);
  for (const name of ["request.json", "state.json", "events.jsonl", "cancel.json"]) assert.equal(mode(path.join(journal.dir, name)), 0o600);
  journal.save(snapshot(journal, { status: "cancelled" }));
  assert.equal(server.cancel(journal.attemptId), false);
  assert.equal(server.messages(journal.attemptId).at(-1)?.metadata?.type, "progress");
  assert.equal(journal.snapshot()?.status, "cancelled");
});

test("only answers the currently pending WorkBuddy permission request once", (t) => {
  const { config, journal } = fixture(t);
  const key = "a".repeat(64);
  journal.save(snapshot(journal, { waitingInput: true }));
  writePrivateJson(path.join(journal.dir, "pending-input.json"), { key, kind: "permission", tool: "write-file" });
  const server = new DurableRuns(config);
  server.respond(journal.attemptId, "reject_once");
  const answer = path.join(journal.dir, `input-${key}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(answer, "utf8")), { decision: "reject_once" });
  assert.equal(mode(answer), 0o600);
  assert.throws(() => server.respond(journal.attemptId, "allow_once"), /EEXIST/);
  journal.save(snapshot(journal, { waitingInput: false }));
  assert.throws(() => server.respond(journal.attemptId, "allow_once"), /No active WorkBuddy input/);
  journal.save(snapshot(journal, { status: "blocked", waitingInput: true }));
  assert.throws(() => server.respond(journal.attemptId, "allow_once"), /No active WorkBuddy input/);
});

test("recovers a truncated last frame without swallowing the subsequent terminal result", (t) => {
  const { config, journal } = fixture(t);
  journal.save(snapshot(journal, { status: "needs_review" }));
  journal.append("progress", "complete first event");
  fs.appendFileSync(path.join(journal.dir, "events.jsonl"), '{"seq":2,"type":"progress",');
  const reopened = new RunJournal(config.runsDir!, journal.attemptId);
  reopened.append("result", "terminal result after restart", { status: "needs_review" });
  const recovered = new DurableRuns(config).messages(journal.attemptId);
  assert.equal(recovered.at(-1)?.metadata?.type, "result");
  assert.equal(recovered.at(-1)?.content[0], "terminal result after restart");
});
