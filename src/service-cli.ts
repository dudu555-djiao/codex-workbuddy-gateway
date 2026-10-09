import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "./config.js";
import { TaskStore } from "./task-store.js";
import { readDesktopSession } from "./desktop-runtime.js";
import { runsDirectory, writePrivateJson } from "./run-journal.js";
import { PersistentDesktopService, readServiceRegistration, registeredServiceConfig, serviceRegistrationPath, validateServiceRegistration, type NativeDesktopTrigger, type ServiceRegistration } from "./persistent-service.js";

const DEBUG_ENV = "WORKBUDDY_REMOTE_DEBUGGING_PORT";
interface CommandResult { status: number; stdout: string; stderr?: string }
export type LaunchctlRunner = (args: string[]) => CommandResult;
const launchctl: LaunchctlRunner = (args) => {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 15_000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
};

function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function labelFor(projectDir: string): string { return `com.codex.workbuddy-service.${crypto.createHash("sha256").update(projectDir).digest("hex").slice(0, 12)}`; }
function environmentValue(run: LaunchctlRunner): { present: boolean; value?: string } {
  const result = run(["getenv", DEBUG_ENV]);
  return result.status === 0 ? { present: true, value: result.stdout.replace(/\r?\n$/, "") } : { present: false };
}
function checked(run: LaunchctlRunner, args: string[]): void {
  const result = run(args);
  if (result.status !== 0) throw new Error(`launchctl ${args[0]} failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
}
function restoreEnvironment(run: LaunchctlRunner, previous: { present: boolean; value?: string }): void {
  checked(run, previous.present ? ["setenv", DEBUG_ENV, previous.value ?? ""] : ["unsetenv", DEBUG_ENV]);
}

export function launchdPlist(registration: ServiceRegistration, configFile: string): string {
  validateServiceRegistration(registration);
  if (!registration.launchdLabel) throw new Error("A launchd service label is required");
  const logs = path.join(registration.projectDir, "data", "service-logs");
  const args = [registration.nodeBin, path.join(registration.projectDir, "dist", "service-cli.js"), "run", "--config", configFile];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(registration.launchdLabel)}</string>\n<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(registration.projectDir)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>ProcessType</key><string>Background</string>\n<key>EnvironmentVariables</key><dict><key>${DEBUG_ENV}</key><string>${registration.cdpPort}</string></dict>\n<key>StandardOutPath</key><string>${xml(path.join(logs, "stdout.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(logs, "stderr.log"))}</string>\n</dict></plist>\n`;
}

export interface InstallServiceOptions {
  config: Config;
  sessionId: string;
  workspace: string;
  projectDir: string;
  nodeBin?: string;
  cdpPort: number;
  intervalMs?: number;
  /** Explicit test/platform injection; production uses the actual macOS account. */
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
}

export function installService(options: InstallServiceOptions, run: LaunchctlRunner = launchctl): { ok: true; registration: ServiceRegistration; configFile: string; restartWorkBuddyRequired: boolean } {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Persistent desktop service installation requires macOS launchd");
  const projectDir = fs.realpathSync(options.projectDir);
  // Keep the native session's path spelling (macOS /var may alias /private/var).
  const workspace = path.resolve(options.workspace);
  if (!fs.statSync(workspace).isDirectory()) throw new Error("The worker workspace must be a directory");
  const nodeBin = fs.realpathSync(options.nodeBin ?? process.execPath);
  if (!fs.statSync(nodeBin).isFile()) throw new Error("The service Node executable was not found");
  if (!fs.existsSync(path.join(projectDir, "dist", "service-cli.js"))) throw new Error("Build the project before installing its persistent service");
  const evidence = readDesktopSession(options.config.workbuddyConfigDir, options.sessionId);
  if (!evidence.registered) throw new Error(evidence.reason ?? "The dedicated WorkBuddy desktop session is not registered");
  if (evidence.cwd && path.resolve(evidence.cwd) !== workspace) throw new Error("The selected WorkBuddy desktop session uses another workspace");
  const configFile = serviceRegistrationPath(projectDir);
  const existing = readServiceRegistration(configFile);
  const currentEnv = environmentValue(run);
  const previousEnv = existing?.launchctlEnvPrevious && currentEnv.present && currentEnv.value === String(existing.cdpPort) ? existing.launchctlEnvPrevious : currentEnv;
  const label = labelFor(projectDir);
  const homeDir = options.homeDir ?? process.env.HOME;
  if (!homeDir || !path.isAbsolute(homeDir)) throw new Error("An absolute macOS user home is required");
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("The macOS user ID was not found");
  const plistPath = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const previousPlist = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, "utf8") : undefined;
  const registration: ServiceRegistration = {
    version: 1, sessionId: options.sessionId, workspace, projectDir, nodeBin, cdpPort: options.cdpPort,
    dbFile: options.config.dbFile, runsDir: runsDirectory(options.config), workbuddyConfigDir: options.config.workbuddyConfigDir, cliElectronPath: options.config.cliElectronPath,
    intervalMs: options.intervalMs ?? 1500, installedAt: new Date().toISOString(), launchdLabel: label, plistPath, launchctlEnvPrevious: previousEnv,
  };
  validateServiceRegistration(registration);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const logs = path.join(projectDir, "data", "service-logs");
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  for (const name of ["stdout.log", "stderr.log"]) {
    const file = path.join(logs, name);
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
  }
  writePrivateJson(configFile, registration);
  fs.writeFileSync(plistPath, launchdPlist(registration, configFile), { mode: 0o600 });
  fs.chmodSync(plistPath, 0o600);
  const domain = `gui/${uid}`;
  const previouslyLoaded = existing ? run(["print", `${domain}/${label}`]).status === 0 : false;
  try {
    checked(run, ["setenv", DEBUG_ENV, String(registration.cdpPort)]);
    // An absent prior instance returns nonzero; bootstrap is the authoritative result.
    run(["bootout", `${domain}/${label}`]);
    checked(run, ["bootstrap", domain, plistPath]);
  } catch (error) {
    try { restoreEnvironment(run, currentEnv); } catch { /* Saved registration retains the recovery information. */ }
    if (existing) writePrivateJson(configFile, existing);
    else fs.rmSync(configFile, { force: true });
    if (previousPlist !== undefined) {
      fs.writeFileSync(plistPath, previousPlist, { mode: 0o600 });
      if (previouslyLoaded) run(["bootstrap", domain, plistPath]);
    } else fs.rmSync(plistPath, { force: true });
    throw error;
  }
  return { ok: true, registration, configFile, restartWorkBuddyRequired: !currentEnv.present || currentEnv.value !== String(registration.cdpPort) };
}

export function serviceStatus(configFile: string, run: LaunchctlRunner = launchctl, uid = process.getuid?.()): Record<string, unknown> {
  const registration = readServiceRegistration(configFile);
  if (!registration) return { ok: true, installed: false, configFile };
  const native = readDesktopSession(registration.workbuddyConfigDir, registration.sessionId);
  const stateFile = path.join(registration.projectDir, "data", "persistent-service-status.json");
  let state: unknown;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { state = undefined; }
  const status = registration.launchdLabel && uid !== undefined ? run(["print", `gui/${uid}/${registration.launchdLabel}`]) : undefined;
  return { ok: true, installed: Boolean(registration.launchdLabel && registration.plistPath && fs.existsSync(registration.plistPath)), launchdLoaded: status?.status === 0, configFile, sessionId: registration.sessionId, workspace: registration.workspace, cdpPort: registration.cdpPort, desktopRegistered: native.registered, state };
}

export function uninstallService(configFile: string, run: LaunchctlRunner = launchctl, uid = process.getuid?.()): Record<string, unknown> {
  const registration = readServiceRegistration(configFile);
  if (!registration) return { ok: true, installed: false, configFile };
  if (registration.launchdLabel && uid !== undefined) {
    const target = `gui/${uid}/${registration.launchdLabel}`;
    const result = run(["bootout", target]);
    if (result.status !== 0 && run(["print", target]).status === 0) throw new Error("The persistent service could not be unloaded; its registration was preserved");
  }
  const current = environmentValue(run);
  let environmentRestored = false;
  // Do not overwrite a later environment change made outside this installation.
  if (registration.launchctlEnvPrevious && current.present && current.value === String(registration.cdpPort)) {
    restoreEnvironment(run, registration.launchctlEnvPrevious);
    environmentRestored = true;
  }
  if (registration.plistPath) fs.rmSync(registration.plistPath, { force: true });
  fs.rmSync(configFile, { force: true });
  fs.rmSync(path.join(registration.projectDir, "data", "persistent-service-status.json"), { force: true });
  return { ok: true, installed: false, environmentRestored, taskHistoryPreserved: true, configFile };
}

async function runService(configFile: string): Promise<void> {
  const registration = readServiceRegistration(configFile);
  if (!registration) throw new Error("Persistent service registration is missing; run install first");
  const config = registeredServiceConfig(loadConfig(), registration);
  checked(launchctl, ["setenv", DEBUG_ENV, String(registration.cdpPort)]);
  // Dynamic factory keeps the service testable without importing native/CDP machinery.
  const module = await import(new URL("./native-desktop-trigger.js", import.meta.url).href) as { createNativeDesktopTrigger?: (config: Config, options: { cdpPort: number }) => NativeDesktopTrigger | Promise<NativeDesktopTrigger> };
  if (typeof module.createNativeDesktopTrigger !== "function") throw new Error("The native desktop trigger factory is unavailable; rebuild the complete project");
  const trigger = await module.createNativeDesktopTrigger(config, { cdpPort: registration.cdpPort });
  const store = new TaskStore(config.dbFile);
  const service = new PersistentDesktopService(config, registration, trigger, store);
  const stateFile = path.join(registration.projectDir, "data", "persistent-service-status.json");
  let stopping = false;
  let stopDelay: (() => void) | undefined;
  const stop = () => { stopping = true; stopDelay?.(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const result = await service.pump();
      writePrivateJson(stateFile, { pid: process.pid, ...result, updatedAt: new Date().toISOString() });
      if (!stopping) await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { stopDelay = undefined; resolve(); }, registration.intervalMs ?? 1500);
        stopDelay = () => { clearTimeout(timer); stopDelay = undefined; resolve(); };
      });
    }
  } finally {
    store.close();
    const closable = trigger as NativeDesktopTrigger & { close?: () => void | Promise<void> };
    await closable.close?.();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({ allowPositionals: true, options: {
    config: { type: "string" }, "session-id": { type: "string" }, workspace: { type: "string" }, "project-dir": { type: "string" }, "node-bin": { type: "string" }, "cdp-port": { type: "string" }, "interval-ms": { type: "string" },
  } });
  const [action] = parsed.positionals;
  const projectDir = path.resolve(parsed.values["project-dir"] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const configFile = parsed.values.config ? path.resolve(parsed.values.config) : serviceRegistrationPath(projectDir);
  const required = (name: "session-id" | "workspace") => { const value = parsed.values[name]; if (!value) throw new Error(`Missing --${name}`); return value; };
  let result: unknown;
  if (action === "install") {
    if (configFile !== serviceRegistrationPath(projectDir)) throw new Error("Installation registration must remain under the project's data directory");
    result = installService({ config: loadConfig(), projectDir, sessionId: required("session-id"), workspace: required("workspace"), nodeBin: parsed.values["node-bin"], cdpPort: Number(parsed.values["cdp-port"] ?? process.env[DEBUG_ENV] ?? "18491"), intervalMs: parsed.values["interval-ms"] ? Number(parsed.values["interval-ms"]) : undefined });
  } else if (action === "status") result = serviceStatus(configFile);
  else if (action === "uninstall") result = uninstallService(configFile);
  else if (action === "run") { await runService(configFile); return; }
  else throw new Error("Use install --session-id ID --workspace PATH [--cdp-port PORT], status, uninstall, or run");
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
}
