import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resultForDetail } from "../src/brief-result.js";
import { TaskStore, type StoredTask } from "../src/task-store.js";
import type { LocalMessage } from "../src/workbuddy-client.js";

function task(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    taskId: "brief-task", messageId: "run-current", attemptId: "run-current", attempt: 2,
    sessionId: "native-session", runtimeSource: "desktop_queue", state: "needs_review", lastEventSeq: 99,
    objective: "Long goal ".repeat(10_000), constraints: ["Long constraint ".repeat(1_000)],
    acceptanceCommands: ["inspect the actual artifact"], workspace: "/fixture/workspace",
    artifacts: Array.from({ length: 130 }, (_, index) => `/fixture/artifact-${index}.txt`),
    createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T01:00:00.000Z",
    report: { status: "completed", filesChanged: ["file.txt"], commandsRun: ["render"], rawText: "TASK_STATUS: completed\n" + "Detailed result ".repeat(20_000) },
    ...overrides,
  };
}
function message(attemptId: string, eventSeq: number, text: string, extra: Record<string, unknown> = {}): LocalMessage {
  return { message_id: `${attemptId}:${eventSeq}`, role: "system", content: [text], metadata: { attemptId, sessionId: "native-session", runtimeSource: "desktop_queue", eventSeq, type: "progress", ...extra } };
}
function brief(value: unknown, messageAttemptId?: string): any {
  return resultForDetail(value, "brief", { messageAttemptId });
}

test("full is the original result and brief substantially reduces large logs without editing it", () => {
  const stored = task();
  const input = { ok: true, task: stored, messages: Array.from({ length: 100 }, (_, index) => message(stored.attemptId!, index, "Large progress log ".repeat(2_000))), attempts: [stored], next: "Inspect the artifacts" };
  const original = JSON.stringify(input);
  assert.strictEqual(resultForDetail(input), input);
  assert.strictEqual(resultForDetail(input, "full"), input);
  const result = brief(input);
  assert.equal(result.ok, true);
  assert.equal(result.next, input.next);
  for (const key of ["taskId", "attemptId", "attempt", "sessionId", "runtimeSource", "state", "lastEventSeq"]) assert.equal(result.task[key], (stored as any)[key]);
  assert.deepEqual(result.task.artifacts, stored.artifacts);
  assert.equal(result.task.latestReport.reportTruncated, true);
  assert.equal(result.task.latestReport.eventSeq, 99);
  assert.ok(result.task.latestReport.text.length <= 2_000);
  assert.match(result.task.latestReport.text, /Truncated; request detail: full/);
  assert.match(result.fullDetail, /not independent acceptance evidence/);
  for (const key of ["objective", "constraints", "acceptanceCommands", "report", "evidence"]) assert.equal(key in result.task, false);
  for (const key of ["messages", "attempts", "history", "rawText"]) assert.equal(key in result, false);
  assert.ok(JSON.stringify(result).length < original.length / 100);
  assert.equal(JSON.stringify(input), original);
  assert.equal((resultForDetail(input, "full") as typeof input).task.report?.rawText, stored.report?.rawText);
});

test("brief retains full blockers, errors, cancellation uncertainty and every artifact path", () => {
  const reason = "Permission denied; inspect original conversation. ".repeat(100);
  const stored = task({ state: "blocked", blockingReason: reason });
  const input = { ok: false, error: reason, task: stored, cancellationRequested: true, remoteStopped: false, messages: [message(stored.attemptId!, 100, "Awaiting permission", { status: "waiting_input", artifacts: ["/fixture/new-path.txt"] })] };
  const result = brief(input);
  assert.equal(result.ok, false);
  assert.equal(result.error, reason);
  assert.equal(result.task.blockingReason, reason);
  assert.equal(result.task.state, "blocked");
  assert.equal(result.cancellationRequested, true);
  assert.equal(result.remoteStopped, false);
  assert.deepEqual(result.task.artifacts, [...stored.artifacts!, "/fixture/new-path.txt"]);
  assert.equal(result.task.latestReport.reportTruncated, false);
  assert.equal(result.task.latestReport.status, "waiting_input");
  assert.equal(result.task.latestReport.text, "Awaiting permission");
  assert.equal(brief({ ok: false, error: "Wrong execution lease" }).error, "Wrong execution lease");
});

test("brief preserves all health session selection information and summarizes each list task", () => {
  const sessions = [{ sessionId: "one", workspace: "/one", ready: true, source: "desktop_queue" }];
  const workerCandidates = [{ sessionId: "one", workspace: "/one" }, { sessionId: "two", workspace: "/two" }];
  const result = brief({ ok: true, backend: "desktop-queue", online: true, ready: true, sessionId: "one", sessions, workerCandidates, next: "Choose by workspace", raw: { giantLog: "x".repeat(10_000) } });
  assert.deepEqual(result.sessions, sessions);
  assert.deepEqual(result.workerCandidates, workerCandidates);
  assert.equal(result.sessionId, "one");
  assert.equal(result.ready, true);
  assert.equal("raw" in result, false);
  const listed = brief({ ok: true, tasks: [task(), task({ taskId: "blocked-list", state: "blocked", blockingReason: "Missing input" })] });
  assert.equal(listed.tasks.length, 2);
  assert.equal(listed.tasks[0].latestReport.status, "completed");
  assert.equal(listed.tasks[0].latestReport.reportTruncated, true);
  assert.equal(listed.tasks[1].blockingReason, "Missing input");
  assert.equal("objective" in listed.tasks[0], false);
});

test("historical messages retain their own identity and paths without replacing the current attempt", () => {
  const current = task({ artifacts: ["/fixture/current.txt"] });
  const messages = [message("run-old", 4, "Old report", { sessionId: "old-session", runtimeSource: "desktop_interactive", status: "needs_review", artifacts: ["/fixture/old.txt"] })];
  const result = brief({ ok: true, task: current, messages }, "run-old");
  assert.equal(result.task.attemptId, "run-current");
  assert.equal(result.selectedAttemptId, "run-old");
  assert.equal(result.latestReport.attemptId, "run-old");
  assert.equal(result.latestReport.sessionId, "old-session");
  assert.equal(result.latestReport.runtimeSource, "desktop_interactive");
  assert.deepEqual(result.artifacts, ["/fixture/old.txt"]);
  assert.deepEqual(result.task.artifacts, ["/fixture/current.txt"]);
  assert.notEqual(result.task.latestReport.text, "Old report");
  const currentResult = brief({ ok: true, task: current, messages: [messages[0], message("run-current", 99, "Current progress")] });
  assert.equal(currentResult.task.latestReport.text, "Current progress");
  assert.deepEqual(currentResult.task.artifacts, ["/fixture/current.txt"]);
});

test("brief health retains the installed service binding and recovery status", () => {
  const persistentService = { installed: true, launchdLoaded: true, sessionId: "bound-native", state: { status: "no_task" } };
  const result = brief({ ok: true, persistentService, raw: { history: "private history" } });
  assert.deepEqual(result.persistentService, persistentService);
  assert.equal("raw" in result, false);
});

test("MCP schemas expose optional brief and full still retrieves complete durable reports and logs", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-brief-mcp-"));
  const store = new TaskStore(path.join(directory, "tasks.sqlite"));
  const native = new DatabaseSync(path.join(directory, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run("native-session", directory);
  native.close();
  const stored = store.createOrGet(task({ state: "accepted", workspace: directory })).task;
  store.addMessages(stored.taskId, Array.from({ length: 100 }, (_, index) => message(stored.attemptId!, index, "Durable progress ".repeat(1_000))));
  const client = new Client({ name: "brief-result-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "src/server.ts"],
    cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), stderr: "pipe",
    env: { WORKBUDDY_BACKEND: "desktop-queue", WORKBUDDY_DB_FILE: store.file, WORKBUDDY_CONFIG_DIR: directory, WORKBUDDY_RUNS_DIR: path.join(directory, "runs"), WORKBUDDY_TOKEN_FILE: path.join(directory, "unused-credentials.json") },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  t.after(async () => { await client.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const tools = await client.listTools();
  const detailedTools = ["health", "send_task", "get_task", "wait", "list_tasks", "get_messages", "continue_task", "accept_task", "cancel_task"];
  for (const suffix of detailedTools) {
    const schema = tools.tools.find((entry) => entry.name === `workbuddy_${suffix}`)!.inputSchema;
    assert.deepEqual((schema.properties?.detail as any)?.enum, ["full", "brief"]);
    assert.equal((schema.properties?.detail as any)?.default, "full");
    assert.equal(schema.required?.includes("detail") ?? false, false);
  }
  assert.equal(tools.tools.find((entry) => entry.name === "workbuddy_prepare_worker")!.inputSchema.properties?.detail, undefined);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.equal(content[0]?.type, "text", stderr);
    return JSON.parse(content[0]!.text!);
  };
  const isolatedHealth = await call("workbuddy_health", { detail: "brief" });
  assert.equal(isolatedHealth.persistentService.installed, false);
  assert.equal(isolatedHealth.status, "offline");
  assert.equal(isolatedHealth.workerCandidates[0].sessionId, "native-session");
  const defaultFull = await call("workbuddy_get_task", { taskId: stored.taskId });
  const explicitFull = await call("workbuddy_get_task", { taskId: stored.taskId, detail: "full" });
  assert.deepEqual(defaultFull, explicitFull);
  assert.equal(explicitFull.task.report.rawText, stored.report!.rawText);
  assert.equal(explicitFull.messages.length, 100);
  const compact = await call("workbuddy_get_task", { taskId: stored.taskId, detail: "brief" });
  assert.equal(compact.task.attemptId, stored.attemptId);
  assert.equal(compact.task.latestReport.reportTruncated, true);
  assert.deepEqual(compact.task.artifacts, stored.artifacts);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(explicitFull).length / 100);
  const completeAgain = await call("workbuddy_get_messages", { taskId: stored.taskId, detail: "full" });
  assert.deepEqual(completeAgain.messages, explicitFull.messages);
  assert.equal(completeAgain.task.objective, stored.objective);
  const compactMessages = await call("workbuddy_get_messages", { taskId: stored.taskId, detail: "brief" });
  assert.equal(compactMessages.task.latestReport.eventSeq, 99);
  assert.equal("messages" in compactMessages, false);
  const waited = await call("workbuddy_wait", { taskId: stored.taskId, timeoutSeconds: 0, detail: "brief" });
  assert.equal(waited.task.state, "accepted");
  assert.equal("messages" in waited, false);
  const listed = await call("workbuddy_list_tasks", { detail: "brief" });
  assert.equal(listed.tasks[0].taskId, stored.taskId);
  assert.equal("objective" in listed.tasks[0], false);
  const duplicate = await call("workbuddy_send_task", { taskId: stored.taskId, objective: "Never dispatched duplicate", detail: "brief" });
  assert.equal(duplicate.created, false);
  assert.equal("objective" in duplicate.task, false);
  const health = await call("workbuddy_health", { detail: "brief" });
  assert.deepEqual(health.workerCandidates, [{ sessionId: "native-session", workspace: directory }]);
  const prepared = await call("workbuddy_prepare_worker", { sessionId: "native-session" });
  assert.equal(prepared.started, false);
  assert.match(prepared.prompt, /claim --session-id/);
  const missing = await call("workbuddy_get_task", { taskId: "missing", detail: "brief" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Unknown task_id/);
});
