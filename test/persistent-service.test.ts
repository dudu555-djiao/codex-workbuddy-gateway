import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal, writePrivateJson } from "../src/run-journal.js";
import { PersistentDesktopService, readServiceRegistration, serviceRegistrationPath, type NativeDesktopTrigger, type ServiceRegistration, type WakeIntent } from "../src/persistent-service.js";
import { installService, launchdPlist, serviceStatus, uninstallService, type LaunchctlRunner } from "../src/service-cli.js";

class FakeTrigger implements NativeDesktopTrigger {
  state: "idle" | "busy" | "waiting_input" | "offline" = "idle";
  workspace?: string;
  accepted = true;
  found = false;
  inspections = 0;
  wakes: Array<{ sessionId: string; wakeId: string; prompt: string }> = [];
  beforeSubmit?: () => void | Promise<void>;
  async inspect() { this.inspections++; return { state: this.state, workspace: this.workspace }; }
  async wakeIdle(sessionId: string, wakeId: string, prompt: string) {
    this.wakes.push({ sessionId, wakeId, prompt });
    await this.beforeSubmit?.();
    return { accepted: this.accepted, receipt: this.accepted ? "native-receipt" : undefined };
  }
  async findWake() { return this.found; }
}

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-persistent-unit-"));
  const config: Config = { ...loadConfig(), backend: "desktop-queue", dbFile: path.join(dir, "data", "tasks.sqlite"), runsDir: path.join(dir, "data", "runs"), workbuddyConfigDir: dir };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run("worker-session", dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  const coordinator = new TaskCoordinator(config, store, new WorkBuddyClient(config));
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  const registration: ServiceRegistration = { version: 1, sessionId: "worker-session", workspace: dir, projectDir: dir, nodeBin: process.execPath, cdpPort: 9333, dbFile: config.dbFile, runsDir: config.runsDir!, workbuddyConfigDir: dir, cliElectronPath: config.cliElectronPath, intervalMs: 500 };
  const trigger = new FakeTrigger();
  trigger.workspace = dir;
  const service = () => new PersistentDesktopService(config, registration, trigger, store);
  const send = async (taskId = "transport-fixture") => {
    await coordinator.send({ taskId, objective: "Unit transport fixture only", sessionId: registration.sessionId, workspace: dir, timeoutSeconds: 600 });
    return new RunJournal(config.runsDir!, store.get(taskId)!.attemptId!);
  };
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, store, coordinator, queue, registration, trigger, service, send };
}

test("wake intent is durable before native submission, and daemon restart never submits accepted wake twice", async (t) => {
  const f = fixture(t);
  const journal = await f.send();
  f.trigger.beforeSubmit = () => {
    const intent = JSON.parse(fs.readFileSync(path.join(journal.dir, "wake.json"), "utf8")) as WakeIntent;
    assert.equal(intent.state, "submitting");
    assert.equal(intent.attemptId, journal.attemptId);
    assert.equal(journal.snapshot()?.runtimeSource, undefined);
    assert.equal(journal.snapshot()?.status, "queued");
  };
  assert.equal((await f.service().pump()).status, "wake_submitted");
  assert.equal((await f.service().pump()).status, "wake_pending");
  assert.equal(f.trigger.wakes.length, 1);
  assert.match(f.trigger.wakes[0]!.prompt, /CODEX_QUEUE_WAKE/);
  assert.match(f.trigger.wakes[0]!.prompt, /claim --session-id/);
  assert.match(f.trigger.wakes[0]!.prompt, /只再运行一次 claim --wait-seconds 0/);
  assert.doesNotMatch(f.trigger.wakes[0]!.prompt, /连续重试 4 次/);
  assert.equal(f.trigger.wakes[0]!.sessionId, "worker-session");
  assert.equal(f.store.get("transport-fixture")?.runtimeSource, undefined);
  assert.equal(journal.events(0, Infinity).filter((event) => event.type === "result").length, 0);
  assert.equal(fs.statSync(path.join(journal.dir, "wake.json")).mode & 0o777, 0o600);
});

test("installed binding supplies the worker identity without a new listener or explicit session", async (t) => {
  const f = fixture(t);
  f.config.serviceConfigFile = serviceRegistrationPath(f.dir);
  writePrivateJson(f.config.serviceConfigFile, f.registration);
  const result = await f.coordinator.send({ taskId: "bound-default", objective: "Unit binding fixture" });
  assert.equal(result.ok, true);
  const stored = f.store.get("bound-default")!;
  assert.equal(stored.sessionId, f.registration.sessionId);
  assert.equal(stored.workspace, f.dir);
  assert.equal(f.queue.listeners().length, 0);
});

test("two concurrent service instances reserve one native wake for the session", async (t) => {
  const f = fixture(t);
  await f.send("first");
  await f.send("second");
  let entered!: () => void;
  let release!: () => void;
  const submitting = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  f.trigger.beforeSubmit = async () => { entered(); await released; };
  const first = f.service().pump();
  await submitting;
  assert.equal((await f.service().pump()).status, "session_busy");
  release();
  assert.equal((await first).status, "wake_submitted");
  assert.equal(f.trigger.wakes.length, 1);
});

test("ambiguous submission is reconciled by native history and never blindly replayed", async (t) => {
  const f = fixture(t);
  const journal = await f.send();
  f.trigger.beforeSubmit = () => { throw new Error("Connection lost after submit"); };
  assert.equal((await f.service().pump()).status, "wake_uncertain");
  assert.equal((await f.service().pump()).status, "wake_uncertain");
  assert.equal(f.trigger.wakes.length, 1);
  f.trigger.found = true;
  assert.equal((await f.service().pump()).status, "wake_pending");
  assert.equal(f.trigger.wakes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(journal.dir, "wake.json"), "utf8")).state, "submitted");
  f.trigger.found = false;
  assert.equal((await f.service().pump()).status, "wake_pending");
  assert.equal(f.trigger.wakes.length, 1);
});

test("a persisted pre-submit intent is uncertain after restart, while a definite rejection may retry", async (t) => {
  const f = fixture(t);
  const journal = await f.send();
  const now = new Date().toISOString();
  const intent: WakeIntent = { version: 1, sessionId: f.registration.sessionId, attemptId: journal.attemptId, wakeId: `wake-${journal.attemptId}`, state: "submitting", createdAt: now, updatedAt: now };
  writePrivateJson(path.join(journal.dir, "wake.json"), intent);
  assert.equal((await f.service().pump()).status, "wake_uncertain");
  assert.equal(f.trigger.wakes.length, 0);
  writePrivateJson(path.join(journal.dir, "wake.json"), { ...intent, state: "rejected" });
  f.trigger.accepted = false;
  assert.equal((await f.service().pump()).status, "wake_rejected");
  f.trigger.accepted = true;
  assert.equal((await f.service().pump()).status, "wake_submitted");
  assert.equal(f.trigger.wakes.length, 2);
  assert.equal(f.trigger.wakes[0]!.wakeId, f.trigger.wakes[1]!.wakeId);
});

test("idle checks reject busy, waiting-input, offline and changed workspaces without a wake", async (t) => {
  const f = fixture(t);
  await f.send();
  for (const state of ["busy", "waiting_input", "offline"] as const) {
    f.trigger.state = state;
    assert.equal((await f.service().pump()).status, state === "offline" ? "unavailable" : "session_busy");
  }
  f.trigger.state = "idle";
  f.trigger.workspace = path.join(f.dir, "other-workspace");
  assert.equal((await f.service().pump()).status, "binding_mismatch");
  assert.equal(f.trigger.wakes.length, 0);
});

test("unresolved execution leases suppress wake, including claimed timeouts", async (t) => {
  const f = fixture(t);
  const journal = await f.send("first");
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  assert.equal(claim.status, "task");
  await f.send("second");
  assert.equal((await f.service().pump()).status, "active_lease");
  journal.save({ ...journal.snapshot()!, status: "blocked", error: "deadline passed" });
  assert.equal((await f.service().pump()).status, "active_lease");
  assert.equal(f.trigger.wakes.length, 0);
  await f.coordinator.sync("first");
  await assert.rejects(() => f.coordinator.continue({ taskId: "first", feedback: "Do not overlap an unresolved execution" }), /stopped|lease|unfinished/);
  await assert.rejects(() => f.queue.claim(f.registration.sessionId, 0), /unfinished queue task/);

  // A genuine native report releases the queue lease. The helper itself remains
  // a listener during the next claim, so the daemon still need not send a prompt.
  journal.save({ ...journal.snapshot()!, status: "working" });
  if (claim.status !== "task") throw new Error("Expected unit claim");
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: transport fixture", artifacts: [] });
  const waiting = f.queue.claim(f.registration.sessionId, 0.1);
  // Second task is claimed immediately; it is now protected by its active lease.
  await waiting;
  assert.equal((await f.service().pump()).status, "no_task");
  assert.equal(f.trigger.wakes.length, 0);
});

test("a live native claim listener consumes newly queued work without an extra desktop prompt", async (t) => {
  const f = fixture(t);
  const waiting = f.queue.claim(f.registration.sessionId, 0.5);
  await f.send();
  assert.equal((await f.service().pump()).status, "listener_ready");
  assert.equal(f.trigger.inspections, 0);
  assert.equal(f.trigger.wakes.length, 0);
  const claim = await waiting;
  assert.equal(claim.status, "task");
});

test("expired unclaimed tasks and deleted native sessions are never woken", async (t) => {
  const f = fixture(t);
  const journal = await f.send();
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await f.service().pump()).status, "deadline_passed");
  assert.equal(f.trigger.inspections, 0);
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() + 60_000).toISOString() });
  const native = new DatabaseSync(path.join(f.dir, "workbuddy.db"));
  native.exec("UPDATE sessions SET deleted_at=1");
  native.close();
  assert.equal((await f.service().pump()).status, "unavailable");
  assert.equal(f.trigger.wakes.length, 0);
});

test("same-chat rework gets one new wake and preserves original task identity and constraints", async (t) => {
  const f = fixture(t);
  await f.coordinator.send({ taskId: "rework", objective: "Unit fixture", constraints: ["Preserve original constraint"], sessionId: f.registration.sessionId, workspace: f.dir });
  assert.equal((await f.service().pump()).status, "wake_submitted");
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw new Error("Expected unit claim");
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: first fixture", artifacts: [] });
  await f.coordinator.sync("rework");
  await f.coordinator.continue({ taskId: "rework", feedback: "Correct fixture item" });
  assert.equal((await f.service().pump()).status, "wake_submitted");
  assert.equal(f.trigger.wakes.length, 2);
  assert.notEqual(f.trigger.wakes[0]!.wakeId, f.trigger.wakes[1]!.wakeId);
  assert.equal(f.trigger.wakes[0]!.sessionId, f.trigger.wakes[1]!.sessionId);
  const request = new RunJournal(f.config.runsDir!, f.store.get("rework")!.attemptId!).request();
  assert.match(request.prompt, /Preserve original constraint/);
  assert.match(request.prompt, /Correct fixture item/);
  assert.equal(f.store.get("rework")?.runtimeSource, undefined);
});

test("service finds queued work beyond its first 500 stored tasks", async (t) => {
  const f = fixture(t);
  const target = await f.send("oldest-task");
  f.store.update("oldest-task", { state: "queued" });
  // Make 500 newer unclaimable records; pagination must reach the durable queue attempt.
  for (let index = 0; index < 500; index++) f.store.createOrGet({ taskId: `new-${index}`, messageId: `pending-${index}`, objective: "Record only", state: "queued", createdAt: "2099-01-01T00:00:00.000Z" });
  const result = await f.service().pump();
  assert.equal(result.status, "wake_submitted");
  assert.equal(result.attemptId, target.attemptId);
});

function fakeLaunchctl(initial?: string) {
  let value = initial;
  let loaded = false;
  const calls: string[][] = [];
  const run: LaunchctlRunner = (args) => {
    calls.push(args);
    if (args[0] === "getenv") return { status: value === undefined ? 1 : 0, stdout: value === undefined ? "" : `${value}\n` };
    if (args[0] === "setenv") { value = args[2]; return { status: 0, stdout: "" }; }
    if (args[0] === "unsetenv") { value = undefined; return { status: 0, stdout: "" }; }
    if (args[0] === "bootstrap") { loaded = true; return { status: 0, stdout: "" }; }
    if (args[0] === "bootout") { const status = loaded ? 0 : 1; loaded = false; return { status, stdout: "" }; }
    if (args[0] === "print") return { status: loaded ? 0 : 1, stdout: loaded ? "state = running" : "" };
    throw new Error(`Unexpected unit launchctl command: ${args[0]}`);
  };
  return { run, calls, value: () => value };
}

test("launchd installer preserves the original environment through reinstall and uninstall", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, "dist"));
  fs.writeFileSync(path.join(f.dir, "dist", "service-cli.js"), "// Unit installer fixture; never executed\n");
  const fake = fakeLaunchctl("original-value");
  const options = { config: f.config, sessionId: f.registration.sessionId, workspace: f.dir, projectDir: f.dir, cdpPort: 9333, platform: "darwin" as const, homeDir: f.dir, uid: 501 };
  const installed = installService(options, fake.run);
  installService(options, fake.run);
  const registration = readServiceRegistration(installed.configFile)!;
  assert.deepEqual(registration.launchctlEnvPrevious, { present: true, value: "original-value" });
  assert.equal(fake.value(), "9333");
  assert.equal(fs.statSync(installed.configFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(registration.plistPath!).mode & 0o777, 0o600);
  const plist = fs.readFileSync(registration.plistPath!, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /WORKBUDDY_REMOTE_DEBUGGING_PORT/);
  assert.equal(serviceStatus(installed.configFile, fake.run, 501).launchdLoaded, true);
  const removed = uninstallService(installed.configFile, fake.run, 501);
  assert.equal(removed.environmentRestored, true);
  assert.equal(fake.value(), "original-value");
  assert.equal(fs.existsSync(registration.plistPath!), false);
  assert.equal(fs.existsSync(f.config.dbFile), true);
  assert.equal(fs.existsSync(serviceRegistrationPath(f.dir)), false);
});

test("uninstall restores an originally absent environment without overriding a later external change", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, "dist"));
  fs.writeFileSync(path.join(f.dir, "dist", "service-cli.js"), "// Unit fixture\n");
  const options = { config: f.config, sessionId: f.registration.sessionId, workspace: f.dir, projectDir: f.dir, cdpPort: 9333, platform: "darwin" as const, homeDir: f.dir, uid: 501 };
  const absent = fakeLaunchctl();
  const installed = installService(options, absent.run);
  assert.equal(uninstallService(installed.configFile, absent.run, 501).environmentRestored, true);
  assert.equal(absent.value(), undefined);
  installService(options, absent.run);
  absent.run(["setenv", "WORKBUDDY_REMOTE_DEBUGGING_PORT", "later-external-value"]);
  assert.equal(uninstallService(installed.configFile, absent.run, 501).environmentRestored, false);
  assert.equal(absent.value(), "later-external-value");
});

test("launchd plist quotes path characters as XML and carries no shell command or credentials", () => {
  const registration: ServiceRegistration = { version: 1, sessionId: "test", workspace: "/tmp/a & b", projectDir: "/tmp/a & b", nodeBin: "/tmp/node with spaces", cdpPort: 9333, dbFile: "/tmp/task.sqlite", runsDir: "/tmp/runs", workbuddyConfigDir: "/tmp/workbuddy", cliElectronPath: "/Applications/WorkBuddy.app/Contents/MacOS/Electron", launchdLabel: "com.codex.fixture" };
  const plist = launchdPlist(registration, "/tmp/a & b/data/persistent-service.json");
  assert.match(plist, /a &amp; b/);
  assert.match(plist, /<string>\/tmp\/node with spaces<\/string>/);
  assert.doesNotMatch(plist, /CLIENT_SECRET|ACCESS_TOKEN|fullAccess|\/bin\/sh/);
});
