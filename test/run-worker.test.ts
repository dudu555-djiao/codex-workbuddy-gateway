import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { DurableRuns, RunJournal, writePrivateJson } from "../src/run-journal.js";
import { acquireSessionLease, classifyResult, runWorker, type WorkerTransport } from "../src/run-worker.js";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-worker-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { ...loadConfig(), backend: "desktop-acp" as const, dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"), workbuddyConfigDir: path.join(dir, "desktop") };
  const id = RunJournal.newId();
  const journal = new RunJournal(config.runsDir, id);
  writePrivateJson(path.join(journal.dir, "request.json"), { attemptId: id, taskId: "test-task", prompt: "Create output", workspace: dir, sessionId: "desktop-test", timeoutSeconds: 5 });
  return { dir, config, id, journal };
}
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the simulated worker");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("turn completion needs review; empty, partial, blocked and cancelled results cannot pass", () => {
  assert.equal(classifyResult({ text: "Rendered output", stopReason: "end_turn" }).status, "needs_review");
  assert.equal(classifyResult({ text: "TASK_STATUS: completed", stopReason: "end_turn" }).status, "needs_review");
  assert.equal(classifyResult({ text: "", stopReason: "end_turn" }).status, "failed");
  assert.equal(classifyResult({ text: "Some partial output", stopReason: "max_tokens" }).status, "blocked");
  assert.equal(classifyResult({ text: "Need materials", status: "waiting_input" }).status, "blocked");
  assert.equal(classifyResult({ text: "Stopped", stopReason: "cancelled" }).status, "cancelled");
  assert.deepEqual(classifyResult({ text: "ARTIFACTS:\n- /tmp/output.mp4\nTEST_RESULT: pass" }).artifacts, ["/tmp/output.mp4"]);
});

test("worker persists the exact desktop binding and protects it from concurrent prompts", async (t) => {
  const { dir, config, id, journal } = fixture(t);
  const transport: WorkerTransport = {
    async run(_prompt, sessionId, _timeout, options) {
      assert.equal(sessionId, "desktop-test");
      assert.equal(options.workspace, dir);
      options.onSession({ sessionId: "desktop-test", desktopVisible: true, runtimeSource: "desktop_interactive" });
      assert.throws(() => acquireSessionLease(config.runsDir, "desktop-test", "other-attempt"), /already executing/);
      options.onEvent({ type: "tool_call", text: "Running render", status: "working" });
      return { text: "TASK_STATUS: completed\nARTIFACTS:\n- /tmp/output.mp4", stopReason: "end_turn" };
    }, async cancel() {},
  };
  await runWorker(config.runsDir, id, config, transport);
  const snapshot = journal.snapshot()!;
  assert.equal(snapshot.sessionId, "desktop-test");
  assert.equal(snapshot.runtimeSource, "desktop_interactive");
  assert.equal(snapshot.status, "needs_review");
  assert.ok(journal.events().some((event) => event.type === "tool_call"));
  const release = acquireSessionLease(config.runsDir, "desktop-test", "next-attempt"); release();
});

test("worker refuses changed or non-visible sessions before accepting output", async (t) => {
  const { config, id, journal } = fixture(t);
  const fake: WorkerTransport = {
    async run(_prompt, _sessionId, _timeout, options) {
      options.onSession({ sessionId: "different", desktopVisible: true });
      assert.fail("dispatch should have been prevented by the binding callback");
    }, async cancel() {},
  };
  await runWorker(config.runsDir, id, config, fake);
  assert.equal(journal.snapshot()?.status, "blocked");
  assert.match(journal.snapshot()?.error ?? "", /refusing to send rework/);
});

test("a pending single-action permission can be answered after the MCP client is recreated", async (t) => {
  const { config, id, journal } = fixture(t);
  let response: Record<string, unknown> | undefined;
  const transport: WorkerTransport = {
    async run(_prompt, _sessionId, _timeout, options) {
      options.onSession({ sessionId: "desktop-test", desktopVisible: true });
      response = await options.onRequest({ id: 42, method: "session/request_permission", params: { options: [{ kind: "allow_once", optionId: "single-edit" }, { kind: "allow_always", optionId: "permanent" }] } });
      return { text: "Finished edit", stopReason: "end_turn" };
    }, async cancel() {},
  };
  const running = runWorker(config.runsDir, id, config, transport);
  await until(() => journal.snapshot()?.waitingInput === true);
  new DurableRuns(config).respond(id, "allow_once");
  await running;
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "single-edit" } });
  assert.equal(journal.snapshot()?.waitingInput, false);
  assert.equal(journal.snapshot()?.status, "needs_review");
});

test("an actual detached worker survives its launcher exiting and writes its final evidence", async (t) => {
  const { dir, config, id, journal } = fixture(t);
  // Only a fixture ACP server is used here. No WorkBuddy application or model is invoked.
  let promptCount = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method === "DELETE") { response.end(); return; }
    if (request.url?.endsWith("/connect")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ connectionId: "fixture-connection" })); return; }
    const buffers = [];
    for await (const chunk of request) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString()) as { id: number; method: string };
    response.setHeader("content-type", "text/event-stream");
    const event = (value: unknown) => response.write(`data: ${JSON.stringify({jsonrpc: "2.0", ...(value as Record<string, unknown>)})}\n\n`);
    if (body.method === "session/prompt") {
      promptCount++;
      event({ method: "session/update", params: { sessionId: "desktop-test", update: { sessionUpdate: "tool_call", title: "Simulated render", status: "in_progress" } } });
      setTimeout(() => {
        event({ method: "session/update", params: { sessionId: "desktop-test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixture artifact complete" } } } });
        event({ id: body.id, result: { stopReason: "end_turn" } });
        response.end();
      }, 500);
    } else { event({ id: body.id, result: {} }); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  fs.mkdirSync(path.join(config.workbuddyConfigDir, "sessions"), { recursive: true });
  const db = new DatabaseSync(path.join(config.workbuddyConfigDir, "workbuddy.db"));
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  db.prepare("INSERT INTO sessions VALUES(?,?,0,NULL)").run("desktop-test", dir); db.close();
  fs.writeFileSync(path.join(config.workbuddyConfigDir, "sessions", "fixture.json"), JSON.stringify({ kind: "interactive", pid: process.pid, sessionId: "desktop-test", endpoint: `http://127.0.0.1:${port}`, lastHeartbeat: Date.now() }));
  const request = journal.request();
  fs.rmSync(path.join(journal.dir, "request.json")); // DurableRuns owns initial reservation below.
  const moduleUrl = new URL("../dist/run-journal.js", import.meta.url).href;
  const code = `import {DurableRuns} from ${JSON.stringify(moduleUrl)}; import {loadConfig} from ${JSON.stringify(new URL("../dist/config.js", import.meta.url).href)}; await new DurableRuns(loadConfig()).start(${JSON.stringify(request)});`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, WORKBUDDY_BACKEND: "desktop-acp", WORKBUDDY_CONFIG_DIR: config.workbuddyConfigDir, WORKBUDDY_DB_FILE: config.dbFile, WORKBUDDY_RUNS_DIR: config.runsDir, WORKBUDDY_ACP_PERMISSION_MODE: "deny" } });
  const reconnected = new DurableRuns(config);
  try { await until(() => journal.snapshot()?.status === "needs_review"); }
  catch (error) { assert.fail(`${String(error)}; snapshot=${JSON.stringify(journal.snapshot())}; promptCount=${promptCount}`); }
  assert.equal(promptCount, 1);
  assert.notEqual(journal.snapshot()?.pid, process.pid);
  assert.equal(journal.snapshot()?.sessionId, "desktop-test");
  const messages = reconnected.messages(id);
  assert.equal(messages.at(-1)?.metadata?.status, "needs_review");
  assert.equal(messages.at(-1)?.content[0], "Fixture artifact complete");
});
