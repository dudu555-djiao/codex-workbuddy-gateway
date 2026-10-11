import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DeepSeekStore, type DeepSeekTask } from "../src/deepseek-store.js";

test("MCP health returns sanitized choices for multiple live hosts without attempting dispatch", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-"));
  for (const hostId of ["desktop", "web"]) fs.writeFileSync(path.join(dir, `${hostId}.json`), JSON.stringify({ hostId, pid: process.pid, profile: hostId, runtimeSource: `deepseek-${hostId}`, socketPath: path.join(dir, `${hostId}.sock`), token: `private-token-${hostId}-do-not-return` }), { mode: 0o600 });
  const client = new Client({ name: "deepseek-test", version: "0.1.0" });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.DEEPSEEK_HOST_ID;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("src/deepseek-server.ts")], env: { ...env, DEEPSEEK_BRIDGE_REGISTRY_DIR: dir, DEEPSEEK_DB_FILE: path.join(dir, "tasks.sqlite") }, stderr: "pipe" });
  t.after(async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const result = await client.callTool({ name: "deepseek_health", arguments: {} });
  const serialized = (result.content as { type: string; text: string }[])[0]!.text;
  const value = JSON.parse(serialized) as { selectionRequired: boolean; hosts: Array<{ hostId: string; profile: string }> };
  assert.equal(value.selectionRequired, true); assert.equal(value.hosts.length, 2); assert.deepEqual(value.hosts.map((host) => host.profile).sort(), ["desktop", "web"]);
  assert.doesNotMatch(serialized, /private-token|socketPath|ECONNREFUSED|ENOENT/);
  const tools = await client.listTools(); assert.equal(tools.tools.filter((tool) => tool.name.startsWith("deepseek_")).length, 10);
});

test("MCP evidence preserves execution identity and tool results while full retains raw diagnostic history", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-evidence-")); const dbFile = path.join(dir, "tasks.sqlite");
  const store = new DeepSeekStore(dbFile); const now = new Date().toISOString();
  const task: DeepSeekTask = { taskId: "evidence-task", objective: "test", hostId: "host", sessionId: "session", constraints: [], acceptanceCommands: [], state: "working", attemptId: "attempt", requestId: "request", turnId: "turn", attempt: 1, runOpen: true, dispatchState: "accepted", createdAt: now, updatedAt: now, deadlineAt: now, lastEventSeq: -1, artifacts: [], evidence: [] };
  store.reserve(task);
  const base = { requestId: task.requestId, turnId: task.turnId };
  store.applyEvents(task.taskId, task.attemptId, [
    { ...base, seq: 0, type: "progress", rawType: "system/message", data: { content: "SYSTEM_SENTINEL_" + "x".repeat(100000) } },
    { ...base, seq: 1, type: "progress", rawType: "assistant/message", data: { stream: "REASONING_SENTINEL" } },
    { ...base, seq: 2, type: "progress", rawType: "tool/call", data: { name: "read", callId: "call-1", arguments: '{"file_path":"/tmp/output.json"}' } },
    { ...base, seq: 3, type: "progress", rawType: "tool/result", data: { message: { toolCallId: "call-1", isError: false, content: [{ type: "text", text: "RESULT_SENTINEL_" + "y".repeat(4000) }] } } },
    { ...base, seq: 4, type: "completed", rawType: "turn/end", text: "output ready", data: { reason: { kind: "completed" } } },
  ], 4); store.close();
  const client = new Client({ name: "evidence-test", version: "0.1.0" });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("src/deepseek-server.ts")], env: { ...env, DEEPSEEK_DB_FILE: dbFile, DEEPSEEK_BRIDGE_REGISTRY_DIR: dir }, stderr: "pipe" });
  t.after(async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }); await client.connect(transport);
  const response = await client.callTool({ name: "deepseek_get_task", arguments: { taskId: task.taskId, detail: "evidence" } });
  assert.notEqual(response.isError, true);
  const text = (response.content as { type: string; text: string }[])[0]!.text; const value = JSON.parse(text);
  assert.equal(value.task.state, "needs_review"); assert.deepEqual(value.events.map((event: { seq: number }) => event.seq), [2, 3, 4]);
  assert.equal(value.events[0].requestId, "request"); assert.equal(value.events[0].turnId, "turn");
  assert.equal(value.events[0].name, "read"); assert.equal(value.events[1].callId, "call-1"); assert.equal(value.events[1].isError, false);
  assert.deepEqual(value.events[1].truncatedFields, ["result"]); assert.equal(value.events[2].endReason, "completed");
  assert.doesNotMatch(text, /SYSTEM_SENTINEL|REASONING_SENTINEL/); assert.ok(text.length < 6000);
  const full = await client.callTool({ name: "deepseek_get_task", arguments: { taskId: task.taskId, detail: "full" } });
  const raw = (full.content as { type: string; text: string }[])[0]!.text;
  assert.match(raw, /SYSTEM_SENTINEL/); assert.match(raw, /REASONING_SENTINEL/); assert.ok(raw.includes("y".repeat(4000)));
});
