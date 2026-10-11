import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

export interface DeepSeekHost { hostId: string; socketPath: string; token: string; pid?: number; version?: string; profile?: string; runtimeSource?: string; processAlive?: boolean; }
export interface DeepSeekSession { sessionId: string; workspace?: string; busy?: boolean; activeRequestId?: string; title?: string; }
export interface DeepSeekEvent {
  seq: number; requestId: string; turnId?: string;
  type: "accepted" | "started" | "progress" | "completed" | "failed" | "cancelled" | "waiting_input";
  text?: string; artifacts?: string[]; error?: string; timestamp?: string; rawType?: string; data?: unknown; raw?: unknown;
}
export interface DeepSeekEvents { events: DeepSeekEvent[]; cursor: number; }
export interface DeepSeekTransport {
  health(hostId?: string): Promise<unknown>;
  sessions(hostId?: string): Promise<{ sessions: DeepSeekSession[] }>;
  create(input: { hostId?: string; workspace?: string; title?: string }): Promise<DeepSeekSession>;
  session(input: { hostId?: string; sessionId: string }): Promise<DeepSeekSession>;
  prompt(input: { hostId: string; sessionId: string; requestId: string; text: string }): Promise<{ requestId: string; turnId?: string; accepted: boolean }>;
  events(input: { hostId: string; sessionId: string; requestId: string; afterSeq: number; limit: number }): Promise<DeepSeekEvents>;
  cancel(input: { hostId: string; sessionId: string; requestId: string }): Promise<{ requested: boolean; stopped?: boolean }>;
  resolveHostId(hostId?: string): string;
}
export class DeepSeekRpcError extends Error {
  constructor(readonly code: string, message: string, readonly admissionRejected = false) { super(message); this.name = "DeepSeekRpcError"; }
}
export class DeepSeekClient implements DeepSeekTransport {
  constructor(readonly registryDir = process.env.DEEPSEEK_BRIDGE_REGISTRY_DIR ?? path.join(os.homedir(), ".dsh", "codex-bridge", "hosts"), readonly defaultHostId = process.env.DEEPSEEK_HOST_ID, readonly timeoutMs = 15_000) {}
  hosts(): DeepSeekHost[] {
    if (!fs.existsSync(this.registryDir)) return [];
    const hosts: DeepSeekHost[] = [];
    for (const name of fs.readdirSync(this.registryDir).filter((name) => name.endsWith(".json"))) {
      try {
        const file = path.join(this.registryDir, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) continue;
        const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!value || typeof value !== "object") continue;
        const host = value as Partial<DeepSeekHost>;
        if (typeof host.hostId === "string" && typeof host.socketPath === "string" && path.isAbsolute(host.socketPath) && typeof host.token === "string" && host.token.length >= 16) hosts.push({ ...host, processAlive: processAlive(host.pid) } as DeepSeekHost);
      } catch { /* Ignore stale or incomplete registration files. */ }
    }
    return hosts;
  }
  resolveHostId(hostId = this.defaultHostId): string {
    const hosts = this.hosts().filter((host) => host.processAlive !== false);
    if (hostId) {
      if (!hosts.some((host) => host.hostId === hostId)) throw new Error(`No registered DeepSeek host: ${hostId}`);
      return hostId;
    }
    if (hosts.length !== 1) throw new Error(hosts.length ? "Multiple Harness hosts are registered; select hostId explicitly" : "No Harness bridge is registered. Install/enable the Codex bridge plugin in DeepSeek Harness.");
    return hosts[0]!.hostId;
  }
  async rpc<T>(method: string, params: Record<string, unknown> = {}, hostId?: string): Promise<T> {
    const selected = this.resolveHostId(hostId);
    const host = this.hosts().find((candidate) => candidate.hostId === selected)!;
    const body = JSON.stringify({ method, params });
    return new Promise<T>((resolve, reject) => {
      const request = http.request({ socketPath: host.socketPath, path: "/rpc", method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { raw += chunk; if (raw.length > 20 * 1024 * 1024) request.destroy(new Error("Harness bridge response exceeds 20 MiB")); });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const result = JSON.parse(raw) as { ok?: boolean; value?: T; error?: { code?: string; message?: string; admissionRejected?: boolean } };
            if (response.statusCode !== 200 || result.ok !== true) throw new DeepSeekRpcError(result.error?.code ?? "RPC_ERROR", result.error?.message ?? `Harness bridge HTTP ${response.statusCode}`, result.error?.admissionRejected === true);
            resolve(result.value as T);
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new DeepSeekRpcError("TRANSPORT_TIMEOUT", "Harness bridge response timed out; dispatch may already have been accepted. Do not resend.")));
      request.on("error", reject);
      request.end(body);
    });
  }
  health(hostId?: string) { return this.rpc("health", {}, hostId); }
  sessions(hostId?: string) { return this.rpc<{ sessions: DeepSeekSession[] }>("sessions", {}, hostId); }
  create({ hostId, ...input }: { hostId?: string; workspace?: string; title?: string }) { return this.rpc<DeepSeekSession>("create", input, hostId); }
  session({ hostId, ...input }: { hostId?: string; sessionId: string }) { return this.rpc<DeepSeekSession>("session", input, hostId); }
  prompt({ hostId, ...input }: { hostId: string; sessionId: string; requestId: string; text: string }) { return this.rpc<{ requestId: string; turnId?: string; accepted: boolean }>("prompt", input, hostId); }
  events({ hostId, ...input }: { hostId: string; sessionId: string; requestId: string; afterSeq: number; limit: number }) { return this.rpc<DeepSeekEvents>("events", input, hostId); }
  cancel({ hostId, ...input }: { hostId: string; sessionId: string; requestId: string }) { return this.rpc<{ requested: boolean; stopped?: boolean }>("cancel", input, hostId); }
}

function processAlive(pid?: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) return undefined;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true; }
}
