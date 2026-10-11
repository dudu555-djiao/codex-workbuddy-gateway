import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { writePrivateJson } from "../run-journal.js";
import { HubStore } from "./store.js";
import { HubEngine } from "./engine.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { createHubServer } from "./http.js";
import { AgentHubClient } from "./client.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = path.resolve(process.env.AGENT_HUB_STATE_DIR ?? path.join(root, "data", "platform"));
const command = process.argv[2] ?? "serve";
const label = `com.agent-hub.${crypto.createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
function launchctl(args: string[], required = true) {
  const response = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 15_000 });
  if (required && response.status !== 0) throw new Error(response.stderr?.trim() || `launchctl ${args[0]} failed`);
  return response;
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function serve() {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, "service.lock");
  try {
    const previous = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number };
    if (alive(previous.pid)) throw new Error("Agent Hub is already running for this state directory");
    fs.unlinkSync(lockFile);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const owner = crypto.randomUUID();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, owner }), { flag: "wx", mode: 0o600 });
  const unlock = () => { try { const value = JSON.parse(fs.readFileSync(lockFile, "utf8")); if (value.owner === owner) fs.unlinkSync(lockFile); } catch {} };
  process.on("exit", unlock);
  const tokenFile = path.join(directory, "api-token");
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Agent Hub token file");
  const store = new HubStore(path.join(directory, "hub.sqlite"));
  const provider = new WorkBuddyProvider(loadConfig());
  const engine = new HubEngine(store, [provider], directory, Number(process.env.AGENT_HUB_MAX_CONCURRENT ?? "1"));
  const server = createHubServer(engine, token);
  const port = Number(process.env.AGENT_HUB_PORT ?? "18492");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid AGENT_HUB_PORT");
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${port}`;
  writePrivateJson(path.join(directory, "connection.json"), { url, tokenFile, pid: process.pid, startedAt: new Date().toISOString() });
  process.stdout.write(`Agent Hub ${url}\n`);
  let stopping = false; let busy = false;
  const tick = async () => { if (busy || stopping) return; busy = true; try { await engine.tick(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); } finally { busy = false; } };
  const timer = setInterval(tick, 1000); void tick();
  const stop = async () => {
    if (stopping) return; stopping = true; clearInterval(timer);
    server.close(); server.closeAllConnections();
    await engine.exclusive(async () => {});
    provider.close(); store.close(); unlock(); process.exit(0);
  };
  process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
}
async function main() {
  if (command === "serve") return serve();
  if (command === "install" || command === "uninstall") {
    if (process.platform !== "darwin" || process.getuid?.() === undefined || !process.env.HOME) throw new Error("Service installation currently requires macOS");
    const plist = path.join(process.env.HOME, "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${process.getuid()}`;
    if (command === "uninstall") { launchctl(["bootout", `${domain}/${label}`], false); fs.rmSync(plist, { force: true }); process.stdout.write("Agent Hub service removed; task records preserved.\n"); return; }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.mkdirSync(path.dirname(plist), { recursive: true });
    const argumentsXml = ["/bin/sh", path.join(root, "bin", "agent-hub"), "serve"].map(value => `<string>${xml(value)}</string>`).join("");
    const envXml = Object.entries({ WORKBUDDY_NODE_BIN: process.execPath, AGENT_HUB_STATE_DIR: directory, AGENT_HUB_PORT: process.env.AGENT_HUB_PORT ?? "18492", AGENT_HUB_MAX_CONCURRENT: process.env.AGENT_HUB_MAX_CONCURRENT ?? "1" }).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
    const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argumentsXml}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${envXml}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(directory, "stdout.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(directory, "stderr.log"))}</string></dict></plist>`;
    launchctl(["bootout", `${domain}/${label}`], false);
    const removalDeadline = Date.now() + 5000;
    while (Date.now() < removalDeadline && launchctl(["print", `${domain}/${label}`], false).status === 0) await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(plist, content, { mode: 0o600 });
    let bootstrapError = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      const registered = launchctl(["bootstrap", domain, plist], false);
      if (registered.status === 0 || launchctl(["print", `${domain}/${label}`], false).status === 0) { bootstrapError = ""; break; }
      bootstrapError = registered.stderr?.trim() || "launchctl bootstrap failed";
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (bootstrapError) throw new Error(bootstrapError);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      try {
        const connection = JSON.parse(fs.readFileSync(path.join(directory, "connection.json"), "utf8"));
        if (alive(connection.pid)) {
          await AgentHubClient.local(directory).request("/v1/health", "GET", undefined, AbortSignal.timeout(1000));
          process.stdout.write(`Agent Hub service ready: ${connection.url}\n`); return;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Agent Hub service installed but not ready after 10 seconds; inspect ${path.join(directory, "stderr.log")}`);
  }
  const client = AgentHubClient.local(directory);
  if (command === "status") {
    const health = await client.request("/v1/health");
    process.stdout.write(JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(directory, "connection.json"), "utf8")), health }, null, 2) + "\n"); return;
  }
  if (command === "run") {
    const argument = process.argv[3]; if (!argument) throw new Error("Usage: agent-hub run @request.json [--no-wait]");
    const input = JSON.parse(argument.startsWith("@") ? fs.readFileSync(path.resolve(process.env.AGENT_HUB_CALLER_CWD ?? process.cwd(), argument.slice(1)), "utf8") : argument);
    const submitted = await client.submit(input);
    process.stderr.write(`Run: ${submitted.run.id}\n`);
    const run = process.argv.includes("--no-wait") ? submitted.run : await client.wait(submitted.run.id, { timeoutMs: (submitted.run.input.timeoutSeconds + 5) * 1000 });
    process.stdout.write(JSON.stringify(run, null, 2) + "\n");
    if (!["queued", "dispatching", "submitted", "running", "completed"].includes(run.status)) process.exitCode = 1;
    return;
  }
  if (command === "get" || command === "cancel") {
    const id = process.argv[3]; if (!id) throw new Error(`Usage: agent-hub ${command} run-id`);
    process.stdout.write(JSON.stringify(await (command === "get" ? client.get(id) : client.cancel(id)), null, 2) + "\n"); return;
  }
  throw new Error("Commands: serve, install, uninstall, status, run, get, cancel");
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
