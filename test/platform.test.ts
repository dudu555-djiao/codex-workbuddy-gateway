import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import http from "node:http";
import { HubStore } from "../src/platform/store.js";
import { HubEngine, readResult } from "../src/platform/engine.js";
import { HubError, type AgentProvider, type HubRun, type ProviderSnapshot } from "../src/platform/contracts.js";
import { createHubServer } from "../src/platform/http.js";
import { AgentHubClient } from "../src/platform/client.js";
import { dashboardHtml } from "../src/platform/ui.js";

class FakeProvider implements AgentProvider {
  constructor(readonly id = "workbuddy") {}
  readonly label = "Fake test provider"; readonly capabilities = {};
  snapshots = new Map<string, ProviderSnapshot>(); submitted: HubRun[] = []; reworked: HubRun[] = []; cancelled: string[] = []; accepted: string[] = [];
  sendError?: Error;
  async health() { return { state: "available", message: "test fixture only", usage: { credits: null, source: "unavailable" } as const }; }
  async models(sessionId?:string){return {models:[{id:'fast',name:'Fast'}],sessionId};}
  workspaces(){return {workers:[]};}
  async bindWorkspace(input:{workspace:string;sessionId?:string;model?:string}){return {ok:true,...input};}
  async submit(run: HubRun) { this.submitted.push(run); if (this.sendError) throw this.sendError; this.snapshots.set(run.id, { status: "queued", holdsCapacity: true, attemptId: `attempt-${run.round}`, sessionId: run.workspace, events: [] }); }
  async poll(run: HubRun) { return this.snapshots.get(run.id); }
  async cancel(run: HubRun) { this.cancelled.push(run.id); }
  async rework(run: HubRun) { this.reworked.push(run); this.snapshots.set(run.id, { status: "queued", holdsCapacity: true, attemptId: `attempt-${run.round}`, sessionId: run.workspace, events: [] }); }
  async accept(run: HubRun) { this.accepted.push(run.id); }
  finish(run: HubRun, result: unknown = { text: "test output", artifacts: [] }) {
    fs.writeFileSync(run.resultFile, JSON.stringify(result));
    this.snapshots.set(run.id, { status: "completed", holdsCapacity: false, attemptId: `attempt-${run.round}`, sessionId: run.workspace, runtimeSource: "fake_fixture", events: [{ key: `round-${run.round}:result`, type: "provider", text: "test fixture result" }] });
  }
}
function fixture(t: { after: (fn: () => void | Promise<void>) => void }, concurrency = 1) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-test-")));
  const store = new HubStore(path.join(directory, "hub.sqlite")); const provider = new FakeProvider();
  const engine = new HubEngine(store, [provider], directory, concurrency);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, provider, engine };
}

test("stable idempotency keys return original runs and reject changed requests, including after reopening storage", async t => {
  const f = fixture(t); const input = { task: "test objective", idempotencyKey: "stable" };
  const first = f.engine.submit(input);
  assert.equal(first.created, true); assert.equal(f.engine.submit(input).run.id, first.run.id);
  assert.throws(() => f.engine.submit({ ...input, task: "different" }), /different request/);
  const other = new HubStore(path.join(f.directory, "hub.sqlite"));
  try { const reopened = new HubEngine(other, [f.provider], f.directory); assert.equal(reopened.submit(input).created, false); }
  finally { other.close(); }
  assert.equal(fs.statSync(first.run.workspace).isDirectory(), true);
  assert.throws(() => f.engine.submit({ task: "x", provider: "deepseek" }), /not implemented/);
  const configured=f.engine.submit({ task: "x", model: "chosen", sessionId: "native-session" }).run;
  assert.equal(configured.input.model,"chosen");assert.equal(configured.input.sessionId,"native-session");
  assert.throws(() => f.engine.submit({ task: "x", unexpected: true }), /Unrecognized key/);
});

test("global capacity and canonical per-project serial order allow other projects while one is occupied", async t => {
  const f = fixture(t, 2); const a = path.join(f.directory, "a"), b = path.join(f.directory, "b"); fs.mkdirSync(a); fs.mkdirSync(b);
  fs.symlinkSync(a, path.join(f.directory, "alias-a"));
  const first = f.engine.submit({ task: "a1", workspace: a }).run;
  const second = f.engine.submit({ task: "a2", workspace: path.join(f.directory, "alias-a") }).run;
  const third = f.engine.submit({ task: "b1", workspace: b }).run;
  await Promise.all([f.engine.tick(), f.engine.tick()]);
  assert.deepEqual(f.provider.submitted.map(run => run.id), [first.id, third.id]);
  assert.equal(f.engine.get(second.id).status, "queued");
  f.provider.finish(first); await f.engine.tick();
  assert.deepEqual(f.provider.submitted.map(run => run.id), [first.id, third.id, second.id]);
  assert.equal(f.engine.get(first.id).review, "pending");
});

test("a second adapter uses the same task contract and cannot overlap writes to an occupied project", async t => {
  const f = fixture(t, 2); const second = new FakeProvider("fixture-provider-two");
  const engine = new HubEngine(f.store, [f.provider, second], f.directory, 2);
  const first = engine.submit({ task: "one", workspace: f.directory }).run;
  const next = engine.submit({ provider: second.id, task: "two", workspace: f.directory }).run;
  await engine.tick(); assert.equal(second.submitted.length, 0);
  f.provider.finish(first); await engine.tick();
  assert.equal(second.submitted[0]?.id, next.id); assert.equal(engine.get(next.id).input.provider, second.id);
});

test("an interrupted dispatch reconciles a real attempt and never replays it on restart", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "crash window" }).run;
  f.store.save({ ...run, status: "dispatching", holdsCapacity: true });
  f.provider.snapshots.set(run.id, { status: "running", holdsCapacity: true, attemptId: "original", events: [] });
  const restarted = new HubEngine(f.store, [f.provider], f.directory);
  await restarted.tick(); assert.equal(restarted.get(run.id).attemptId, "original"); assert.equal(f.provider.submitted.length, 0);
});

test("uncertain submission stays occupied without blind replay; proven pre-dispatch errors release capacity", async t => {
  const f = fixture(t); f.provider.sendError = new Error("transport interrupted");
  const first = f.engine.submit({ task: "uncertain" }).run; const second = f.engine.submit({ task: "later" }).run;
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.engine.get(first.id).status, "uncertain"); assert.equal(f.engine.get(first.id).holdsCapacity, true);
  assert.equal(f.engine.get(second.id).status, "queued"); assert.equal(f.provider.submitted.length, 1);
  f.provider.snapshots.set(first.id, { status: "failed", holdsCapacity: false, attemptId: "found", error: "verified stopped", events: [] });
  f.provider.sendError = new HubError("DISPATCH_NOT_SENT", "workspace preparation failed before task reservation");
  await f.engine.tick(); assert.equal(f.engine.get(second.id).status, "failed"); assert.equal(f.engine.get(second.id).holdsCapacity, false);
});

test("a queued deadline expires without dispatch and invalid output fails independently of execution", async t => {
  const f = fixture(t); const expired = f.engine.submit({ task: "expired" }).run;
  f.store.save({ ...expired, deadline: new Date(Date.now() - 1000).toISOString() }); await f.engine.tick();
  assert.equal(f.provider.submitted.length, 0); assert.equal(f.engine.get(expired.id).error?.code, "QUEUE_TIMEOUT");
  const json = f.engine.submit({ task: "json", output: "json" }).run; await f.engine.tick();
  f.provider.finish(json, { text: "missing json", artifacts: [] }); await f.engine.tick();
  assert.equal(f.engine.get(json.id).error?.code, "INVALID_OUTPUT"); assert.equal(f.engine.get(json.id).holdsCapacity, false);
});

test("JSON null is valid, output success is not acceptance, and concrete evidence is required", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "structured", output: "json" }).run; await f.engine.tick();
  f.provider.finish(run, { text: "valid fixture", json: null, artifacts: [] }); await f.engine.tick();
  assert.equal(f.engine.get(run.id).status, "completed"); assert.equal(f.engine.get(run.id).result?.json, null); assert.equal(f.engine.get(run.id).review, "pending");
  await assert.rejects(() => f.engine.accept(run.id, { note: "checked", evidence: [] }), /concrete independent/);
  await f.engine.accept(run.id, { note: "checked fixture", evidence: ["Compared fixture output with expected null"] });
  assert.equal(f.engine.get(run.id).review, "accepted"); assert.deepEqual(f.provider.accepted, [run.id]);
});

test("rework gets a fresh result location, preserves provider task identity and cannot reuse old attempt output", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "rework" }).run; await f.engine.tick(); f.provider.finish(run); await f.engine.tick();
  const next = await f.engine.rework(run.id, "change fixture result");
  assert.notEqual(next.resultFile, run.resultFile); assert.equal(next.providerTaskId, run.providerTaskId); assert.equal(next.round, 2);
  await f.engine.tick(); assert.equal(f.provider.reworked.length, 1); assert.equal(f.engine.get(run.id).attemptId, "attempt-2");
  await assert.rejects(() => f.engine.rework(run.id, "overlapping"), /confirmed finished/);
  f.provider.finish(next, { text: "second output", artifacts: [] }); await f.engine.tick();
  assert.equal(f.engine.get(run.id).result?.text, "second output");
  assert.equal(f.store.events(run.id).filter(event => event.type === "provider").length, 2);
});

test("restart during rework does not mistake the previous completed attempt for the new one", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "rework crash" }).run; await f.engine.tick(); f.provider.finish(run); await f.engine.tick();
  const next = await f.engine.rework(run.id, "new round"); f.store.save({ ...next, status: "dispatching", holdsCapacity: true });
  await f.engine.tick(); assert.equal(f.engine.get(run.id).status, "uncertain"); assert.equal(f.provider.reworked.length, 0);
});

test("cancelled running work keeps its slot until actual stop while unsubmitted work cancels immediately", async t => {
  const f = fixture(t); const active = f.engine.submit({ task: "active" }).run, pending = f.engine.submit({ task: "pending" }).run;
  await f.engine.tick(); assert.equal((await f.engine.cancel(pending.id)).status, "cancelled");
  const cancelled = await f.engine.cancel(active.id); assert.equal(cancelled.status, "cancel_requested"); assert.equal(cancelled.holdsCapacity, true);
  const third = f.engine.submit({ task: "later" }).run; await f.engine.tick(); assert.equal(f.engine.get(third.id).status, "queued");
  f.provider.snapshots.set(active.id, { status: "cancelled", holdsCapacity: false, attemptId: "attempt-1", events: [] });
  await f.engine.tick(); assert.equal(f.engine.get(active.id).status, "cancelled"); assert.equal(f.engine.get(third.id).status, "submitted");
});

test("result validation rejects external files, directory symlinks, missing files and oversized results", t => {
  const f = fixture(t); const run = f.engine.submit({ task: "files", output: "artifacts" }).run;
  const outside = path.join(f.directory, "private.txt"); fs.writeFileSync(outside, "private fixture");
  fs.writeFileSync(run.resultFile, JSON.stringify({ text: "bad", artifacts: [outside] })); assert.throws(() => readResult(run), /escapes/);
  const symlink = path.join(run.workspace, "outside.txt"); fs.symlinkSync(outside, symlink);
  fs.writeFileSync(run.resultFile, JSON.stringify({ text: "bad", artifacts: [symlink] })); assert.throws(() => readResult(run), /escapes/);
  fs.writeFileSync(run.resultFile, "x".repeat(1_048_577)); assert.throws(() => readResult(run), /1 MiB/);
  fs.rmSync(path.dirname(run.resultFile), { recursive: true }); fs.symlinkSync(f.directory, path.dirname(run.resultFile));
  fs.writeFileSync(path.join(f.directory, "output.json"), JSON.stringify({ text: "bad", artifacts: [] })); assert.throws(() => readResult(run), /escapes/);
});

test("events deduplicate provider observations and resume after persistent cursors", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "events" }).run; await f.engine.tick();
  f.provider.snapshots.set(run.id, { status: "running", holdsCapacity: true, attemptId: "attempt-1", events: [{ key: "progress-1", type: "provider", text: "one" }] });
  await f.engine.tick(); const events = f.store.events(run.id); const after = events.at(-1)!.id;
  await f.engine.tick(); assert.equal(f.store.events(run.id, after).length, 0);
  f.provider.finish(run); await f.engine.tick(); assert.ok(f.store.events(run.id, after).length >= 2);
  assert.equal(f.store.events(run.id).filter(event => event.type === "provider").length, 2);
});

test("HTTP authentication, Host/Origin checks, SDK waiting, SSE reconnect, files and errors share one engine", async t => {
  const f = fixture(t); const token = "a".repeat(64); const server = createHubServer(f.engine, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}`; const client = new AgentHubClient(url, token);
  assert.equal((await fetch(url + "/v1/runs")).status, 401);
  assert.equal((await fetch(url + "/v1/runs", { headers: { authorization: `Bearer ${token}`, origin: "https://example.com" } })).status, 403);
  const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    http.get(url + "/v1/runs", { headers: { authorization: `Bearer ${token}`, host: "evil.example" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(wrongHostStatus, 403);
  const navigation = await new Promise<number | undefined>((resolve, reject) => {
    http.get(url + "/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(navigation, 200, "A normal clicked link may open the dashboard; API access stays same-origin");
  const page = await fetch(url); assert.match(page.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/); assert.match(await page.text(), /Agent Hub/);
  assert.deepEqual(await client.models('native/session'),{models:[{id:'fast',name:'Fast'}],sessionId:'native/session'});
  assert.deepEqual(await client.workspaces(),{workers:[]});
  assert.deepEqual(await client.bindWorkspace({workspace:f.directory,sessionId:'native/session',model:'fast'}),{ok:true,workspace:f.directory,sessionId:'native/session',model:'fast'});
  await assert.rejects(()=>client.bindWorkspace({workspace:f.directory,model:''}),/at least 1 character/);
  const { run } = await client.submit({ task: "http", output: "artifacts" });
  const queued = await client.request<HubRun>(`/v1/runs/${run.id}/wait?timeoutSeconds=1`); assert.equal(queued.status, "queued");
  const controller = new AbortController();
  const stream = await fetch(`${url}/v1/runs/${run.id}/stream`, { headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "0" }, signal: controller.signal });
  const reader = stream.body!.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /event: state/); controller.abort(); await reader.cancel().catch(() => {});
  await f.engine.tick(); const file = path.join(run.workspace, "result.txt"); fs.writeFileSync(file, "fixture content"); f.provider.finish(run, { text: "file fixture", artifacts: [file] }); await f.engine.tick();
  assert.equal((await client.wait(run.id, { timeoutMs: 1000 })).status, "completed");
  const downloaded = await fetch(`${url}/v1/runs/${run.id}/artifacts/0`, { headers: { authorization: `Bearer ${token}` } }); assert.equal(await downloaded.text(), "fixture content");
  fs.rmSync(file); fs.symlinkSync(path.join(f.directory, "hub.sqlite"), file);
  const swapped = await fetch(`${url}/v1/runs/${run.id}/artifacts/0`, { headers: { authorization: `Bearer ${token}` } }); assert.notEqual(swapped.status, 200);
  await assert.rejects(() => client.submit({ task: "different", idempotencyKey: "key", output: "invalid" }), /Invalid enum/);
  assert.throws(() => new AgentHubClient("https://example.com", token), /loopback/);
});

test("SDK wait timeout does not cancel work and dashboard script compiles", async t => {
  const f = fixture(t); const token = "b".repeat(64); const server = createHubServer(f.engine, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address"); const client = new AgentHubClient(`http://127.0.0.1:${address.port}`, token);
  const { run } = await client.submit({ task: "still queued" }); await assert.rejects(() => client.wait(run.id, { timeoutMs: 20 }), /remains available/); assert.equal(f.engine.get(run.id).status, "queued");
  const script = dashboardHtml().match(/<script>([\s\S]*)<\/script>/)![1]!; assert.doesNotThrow(() => new vm.Script(script)); assert.ok(!script.includes("innerHTML"));
});
