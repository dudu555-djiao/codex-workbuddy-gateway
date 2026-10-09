import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AcpLiveClient, collectSseOrJson, validateLoopbackUrl, type AcpEvent } from "../src/acp-live.js";
import type { Config } from "../src/config.js";

function config(workbuddyConfigDir: string): Config {
  return {
    backend: "desktop-acp",
    apiBaseUrl: "https://test.workbuddy",
    tokenFile: "/tmp/unused-workbuddy-token.json",
    dbFile: "/tmp/unused-workbuddy.sqlite",
    oauthRedirectUri: "http://127.0.0.1:8787/oauth/callback",
    oauthPort: 8787,
    oauthScopes: "",
    requestTimeoutMs: 1000,
    cliElectronPath: "/tmp/electron",
    cliScriptPath: "/tmp/codebuddy",
    cliPermissionMode: "acceptEdits",
    acpPermissionMode: "deny",
    gatewayUrl: "http://127.0.0.1:64523",
    workbuddyConfigDir,
  };
}

function register(root: string, sessionId: string, cwd = "/tmp"): void {
  const db = new DatabaseSync(path.join(root, "workbuddy.db"));
  db.exec("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  db.prepare("INSERT INTO sessions VALUES(?,?,0,NULL)").run(sessionId, cwd);
  db.close();
}

function fixture(): { root: string; settings: Config; sessionId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-acp-run-"));
  fs.mkdirSync(path.join(root, "sessions"));
  const sessionId = "interactive-test";
  fs.writeFileSync(path.join(root, "sessions", "current.json"), JSON.stringify({
    kind: "interactive", pid: process.pid, sessionId, endpoint: "http://127.0.0.1:64523", cwd: "/tmp", lastHeartbeat: Date.now(),
  }));
  register(root, sessionId);
  return { root, settings: config(root), sessionId };
}

function sse(...messages: unknown[]): Response {
  return new Response(messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function transport(promptReply: (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input, init = {}) => {
    if (init.method === "DELETE") return new Response("", { status: 200 });
    if (String(input).endsWith("/connect")) return Response.json({ connectionId: "test-connection", sessionToken: "test-token" });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (body.method === "session/prompt" || body.method === undefined) return promptReply(body, init);
    return sse({ jsonrpc: "2.0", id: body.id, result: {} });
  };
}

test("discovers an interactive loopback session and probes ACP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-acp-"));
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "current.json"), JSON.stringify({
    kind: "interactive", pid: process.pid, sessionId: "interactive-test", endpoint: "http://127.0.0.1:64523", cwd: "/tmp", lastHeartbeat: Date.now(),
  }));
  register(root, "interactive-test");
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${String(input)}`);
    if (init.method === "DELETE") return new Response("", { status: 200 });
    return new Response(JSON.stringify({ connectionId: "test-connection", sessionToken: "test-token" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await new AcpLiveClient(config(root), "deny", fakeFetch).health();
  assert.equal(result.online, true);
  assert.equal(result.ready, true);
  assert.equal(result.endpoint.sessionId, "interactive-test");
  assert.deepEqual(calls.map((call) => call.split(" ")[0]), ["POST", "DELETE"]);
  assert.equal(validateLoopbackUrl("http://localhost:64523"), "http://localhost:64523");
  assert.throws(() => validateLoopbackUrl("https://127.0.0.1:64523"), /loopback/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("loads a prewarmed session once and returns the ACP assistant text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-acp-run-"));
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "current.json"), JSON.stringify({
    kind: "interactive", pid: process.pid, sessionId: "interactive-test", endpoint: "http://127.0.0.1:64523", cwd: "/tmp", lastHeartbeat: Date.now(),
  }));
  register(root, "interactive-test");
  const methods: string[] = [];
  let promptAttempts = 0;
  const sse = (message: unknown) => new Response(`:ok\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "DELETE") return new Response("", { status: 200 });
    if (url.endsWith("/connect")) return new Response(JSON.stringify({ connectionId: "test-connection", sessionToken: "test-token" }), { status: 200, headers: { "content-type": "application/json" } });
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    methods.push(body.method);
    if (body.method === "session/prompt") {
      promptAttempts += 1;
      if (promptAttempts === 1) return sse({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Session not found: interactive-test" } });
      return new Response([
        ":ok",
        "",
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BRIDGE_OK" } } } })}`,
        "",
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { stopReason: "end_turn" } })}`,
        "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return sse({ jsonrpc: "2.0", id: body.id, result: {} });
  };
  try {
    const result = await new AcpLiveClient(config(root), "deny", fakeFetch).run("hello", undefined, 5_000);
    assert.equal(result.text, "BRIDGE_OK");
    assert.deepEqual(methods, ["initialize", "session/prompt", "session/load", "session/prompt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("binds the requested session even when another conversation has a newer heartbeat", () => {
  const { root, settings, sessionId } = fixture();
  try {
    register(root, "other");
    fs.writeFileSync(path.join(root, "sessions", "newer.json"), JSON.stringify({
      kind: "interactive", pid: process.pid, sessionId: "other", endpoint: "http://127.0.0.1:64524", lastHeartbeat: Date.now() + 1,
    }));
    assert.equal(AcpLiveClient.discover(settings, sessionId).sessionId, sessionId);
    assert.throws(() => AcpLiveClient.discover(settings), /Multiple/);
    assert.throws(() => AcpLiveClient.discover(settings, "missing"), /will not switch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("never dispatches an unregistered session or a mismatched workspace", async () => {
  const { root, settings, sessionId } = fixture();
  try {
    let requests = 0;
    const fake: typeof fetch = async () => { requests += 1; throw new Error("should not dispatch"); };
    await assert.rejects(new AcpLiveClient(settings, "deny", fake).run("hello", sessionId, 1_000, { workspace: root }), /workspace differs/);
    const db = new DatabaseSync(path.join(root, "workbuddy.db"));
    db.exec("DELETE FROM sessions"); db.close();
    await assert.rejects(new AcpLiveClient(settings, "deny", fake).run("hello", sessionId), /not registered/);
    assert.equal(requests, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("requires session persistence callback before dispatch and surfaces callback errors", async () => {
  const { root, settings } = fixture();
  let sent = false;
  try {
    await assert.rejects(new AcpLiveClient(settings, "deny", transport(() => { sent = true; return sse(); })).run("hello", undefined, 1_000, {
      onSession: async () => { throw new Error("session lease unavailable"); },
    }), /lease unavailable/);
    assert.equal(sent, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a failed session lease cannot change another attempt's model", async () => {
  const { root, settings } = fixture();
  const methods: string[] = [];
  try {
    const fake: typeof fetch = async (input, init = {}) => {
      if (init.method === "DELETE") return new Response("", { status: 200 });
      if (String(input).endsWith("/connect")) return Response.json({ connectionId: "test" });
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      methods.push(body.method);
      return sse({ jsonrpc: "2.0", id: body.id, result: {} });
    };
    await assert.rejects(new AcpLiveClient(settings, "deny", fake).run("hello", undefined, 1_000, {
      model: "other-model", onSession: () => { throw new Error("session lease unavailable"); },
    }), /lease unavailable/);
    assert.deepEqual(methods, ["initialize"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("never replays after execution activity or a callback error mentioning Session not found", async () => {
  const { root, settings, sessionId } = fixture();
  try {
    let dispatched = 0;
    const fake = transport((body) => {
      dispatched += 1;
      return sse(
        { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", status: "in_progress" } } },
        { jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Session not found after tool execution" } },
      );
    });
    await assert.rejects(new AcpLiveClient(settings, "deny", fake).run("hello", sessionId, 1_000), /Session not found/);
    assert.equal(dispatched, 1);
    dispatched = 0;
    await assert.rejects(new AcpLiveClient(settings, "deny", fake).run("hello", sessionId, 1_000, {
      onEvent: async () => { throw new Error("Session not found in local journal"); },
    }), /local journal/);
    assert.equal(dispatched, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("new-session mode sends the real workspace and validates native registration before dispatch", async () => {
  const { root, settings } = fixture();
  const methods: string[] = [];
  try {
    const fake: typeof fetch = async (input, init = {}) => {
      if (init.method === "DELETE") return new Response("", { status: 200 });
      if (String(input).endsWith("/connect")) return Response.json({ connectionId: "test" });
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params: Record<string, unknown> };
      methods.push(body.method);
      if (body.method === "session/new") {
        assert.equal(body.params.cwd, root);
        register(root, "new-native", root);
        fs.writeFileSync(path.join(root, "sessions", "current.json"), JSON.stringify({
          kind: "interactive", pid: process.pid, sessionId: "new-native", endpoint: "http://127.0.0.1:64523", cwd: root, lastHeartbeat: Date.now(),
        }));
        return sse({ jsonrpc: "2.0", id: body.id, result: { sessionId: "new-native" } });
      }
      if (body.method === "session/prompt") {
        assert.equal(body.params.sessionId, "new-native");
        return sse(
          { jsonrpc: "2.0", method: "session/update", params: { sessionId: "new-native", update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } },
          { jsonrpc: "2.0", id: body.id, result: { stopReason: "end_turn" } },
        );
      }
      return sse({ jsonrpc: "2.0", id: body.id, result: {} });
    };
    const result = await new AcpLiveClient(settings, "deny", fake).run("hello", undefined, 1_000, {
      sessionMode: "new", workspace: root,
      onSession: (endpoint) => { assert.equal(endpoint.desktopVisible, true); assert.equal(endpoint.workspaceBinding, "native_cwd"); },
    });
    assert.equal(result.sessionId, "new-native");
    assert.deepEqual(methods, ["initialize", "session/new", "session/prompt"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("new-session native registration alone cannot dispatch an unreconnectable task", async () => {
  const { root, settings } = fixture();
  let dispatched = false;
  try {
    const fake: typeof fetch = async (input, init = {}) => {
      if (init.method === "DELETE") return new Response("", { status: 200 });
      if (String(input).endsWith("/connect")) return Response.json({ connectionId: "test" });
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      if (body.method === "session/new") { register(root, "new-native"); return sse({ jsonrpc: "2.0", id: body.id, result: { sessionId: "new-native" } }); }
      if (body.method === "session/prompt") dispatched = true;
      return sse({ jsonrpc: "2.0", id: body.id, result: {} });
    };
    const result = await new AcpLiveClient(settings, "deny", fake).run("hello", undefined, 1_000, { sessionMode: "new" });
    assert.equal(result.status, "blocked");
    assert.match(result.error ?? "", /not discoverable/);
    assert.equal(dispatched, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("SSE ignores unrelated responses and waits for only the matching prompt result", async () => {
  const response = sse(
    { jsonrpc: "2.0", id: 88, result: { stopReason: "end_turn" } },
    { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "real answer" } } } },
    { jsonrpc: "2.0", id: 99, result: { stopReason: "end_turn" } },
  );
  const observed: unknown[] = [];
  const terminal = await collectSseOrJson(response, 99, async (message) => { observed.push(message); });
  assert.equal(terminal.id, 99);
  assert.equal(observed.length, 3);
});

test("SSE stops a still-open broadcast stream at the matching result", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":3,"result":{}}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } });
  assert.equal((await collectSseOrJson(response, 3)).id, 3);
  assert.equal(cancelled, true);
});

test("malformed SSE, callback failure and missing terminal frames are protocol failures", async () => {
  await assert.rejects(collectSseOrJson(new Response('data: not-json\n\n', { headers: { "content-type": "text/event-stream" } }), 1), /malformed SSE/);
  await assert.rejects(collectSseOrJson(sse({ jsonrpc: "2.0", id: 1, result: {} }), 1, async () => { throw new Error("journal write failed"); }), /journal write failed/);
  await assert.rejects(collectSseOrJson(sse({ jsonrpc: "2.0", id: 2, result: {} }), 1), /before the matching/);
  await assert.rejects(collectSseOrJson(Response.json({ jsonrpc: "2.0", id: 2, result: {} }), 1), /matching request/);
});

test("SSE abort interrupts an unanswered input callback without reporting completion", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(collectSseOrJson(sse({ jsonrpc: "2.0", id: 9, method: "elicitation/create", params: {} }), 1,
      async () => await new Promise<void>(() => undefined), controller.signal), { name: "AbortError" });
  } finally { clearTimeout(timer); }
});

test("only allow_once is automatically selected when WorkBuddy offers persistent permission too", async () => {
  const { root, settings, sessionId } = fixture();
  const answers: Record<string, unknown>[] = [];
  try {
    const result = await new AcpLiveClient(settings, "allow_once", transport((body) => {
      if (!body.method) { answers.push(body); return new Response("", { status: 202 }); }
      return sse(
        { jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId, options: [{ kind: "allow_always", optionId: "permanent" }, { kind: "allow_once", optionId: "one-action" }] } },
        { jsonrpc: "2.0", method: "sessionUpdate", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } },
        { jsonrpc: "2.0", id: body.id, result: { stopReason: "end_turn" } },
      );
    })).run("hello", sessionId, 1_000);
    assert.equal(result.status, "completed");
    assert.deepEqual(answers[0]?.result, { outcome: { outcome: "selected", optionId: "one-action" } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("end_turn with no answer is blocked; tool events are delivered as execution evidence", async () => {
  const { root, settings, sessionId } = fixture();
  const events: AcpEvent[] = [];
  try {
    const result = await new AcpLiveClient(settings, "allow_once", transport((body) => sse(
      { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Render video", status: "in_progress", rawInput: { token: "sensitive" } } } },
      { jsonrpc: "2.0", id: body.id, result: { stopReason: "end_turn" } },
    ))).run("hello", sessionId, 1_000, { onEvent: (event) => { events.push(event); } });
    assert.equal(result.status, "blocked");
    assert.equal(events[0]?.type, "tool_call");
    assert.equal((events[0]?.data?.rawInput as Record<string, unknown>).token, "[redacted]");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("allow_once does not escalate to allow_always and required input can be answered", async () => {
  const { root, settings, sessionId } = fixture();
  const answers: Record<string, unknown>[] = [];
  const events: AcpEvent[] = [];
  let callback = 0;
  try {
    const result = await new AcpLiveClient(settings, "allow_once", transport((body) => {
      if (!body.method) { answers.push(body); return new Response("", { status: 202 }); }
      return sse(
        { jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId, options: [{ kind: "allow_always", optionId: "persistent" }] } },
        { jsonrpc: "2.0", id: "question-1", method: "elicitation/create", params: { sessionId, message: "Choose a voice" } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } },
        { jsonrpc: "2.0", id: body.id, result: { stopReason: "end_turn" } },
      );
    })).run("hello", sessionId, 1_000, {
      onEvent: (event) => { events.push(event); },
      onRequest: async (request) => { callback += 1; return request.method === "elicitation/create" ? { action: "accept", content: { voice: "user choice" } } : { outcome: { outcome: "cancelled" } }; },
    });
    assert.equal(result.status, "completed");
    assert.equal(callback, 2);
    assert.equal(answers.length, 2);
    assert.equal(events.filter((event) => event.type === "input_required").length, 2);
    assert.equal(JSON.stringify(answers).includes('"optionId":"persistent"'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("elicitation without an input handler reports waiting_input and never silently cancels", async () => {
  const { root, settings, sessionId } = fixture();
  let replied = false;
  try {
    const result = await new AcpLiveClient(settings, "deny", transport((body) => {
      if (!body.method) { replied = true; return new Response("", { status: 202 }); }
      return sse({ jsonrpc: "2.0", id: 71, method: "elicitation/create", params: { sessionId, message: "Need input" } });
    })).run("hello", sessionId, 1_000);
    assert.equal(result.status, "waiting_input");
    assert.equal(result.pendingInput?.id, 71);
    assert.equal(replied, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
