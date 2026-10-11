import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
export class DeepSeekRpcError extends Error {
    code;
    admissionRejected;
    constructor(code, message, admissionRejected = false) {
        super(message);
        this.code = code;
        this.admissionRejected = admissionRejected;
        this.name = "DeepSeekRpcError";
    }
}
export class DeepSeekClient {
    registryDir;
    defaultHostId;
    timeoutMs;
    constructor(registryDir = process.env.DEEPSEEK_BRIDGE_REGISTRY_DIR ?? path.join(os.homedir(), ".dsh", "codex-bridge", "hosts"), defaultHostId = process.env.DEEPSEEK_HOST_ID, timeoutMs = 15_000) {
        this.registryDir = registryDir;
        this.defaultHostId = defaultHostId;
        this.timeoutMs = timeoutMs;
    }
    hosts() {
        if (!fs.existsSync(this.registryDir))
            return [];
        const hosts = [];
        for (const name of fs.readdirSync(this.registryDir).filter((name) => name.endsWith(".json"))) {
            try {
                const file = path.join(this.registryDir, name);
                const stat = fs.lstatSync(file);
                if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
                    continue;
                const value = JSON.parse(fs.readFileSync(file, "utf8"));
                if (!value || typeof value !== "object")
                    continue;
                const host = value;
                if (typeof host.hostId === "string" && typeof host.socketPath === "string" && path.isAbsolute(host.socketPath) && typeof host.token === "string" && host.token.length >= 16)
                    hosts.push({ ...host, processAlive: processAlive(host.pid) });
            }
            catch { /* Ignore stale or incomplete registration files. */ }
        }
        return hosts;
    }
    resolveHostId(hostId = this.defaultHostId) {
        const hosts = this.hosts().filter((host) => host.processAlive !== false);
        if (hostId) {
            if (!hosts.some((host) => host.hostId === hostId))
                throw new Error(`No registered DeepSeek host: ${hostId}`);
            return hostId;
        }
        if (hosts.length !== 1)
            throw new Error(hosts.length ? "Multiple Harness hosts are registered; select hostId explicitly" : "No Harness bridge is registered. Install/enable the Codex bridge plugin in DeepSeek Harness.");
        return hosts[0].hostId;
    }
    async rpc(method, params = {}, hostId) {
        const selected = this.resolveHostId(hostId);
        const host = this.hosts().find((candidate) => candidate.hostId === selected);
        const body = JSON.stringify({ method, params });
        return new Promise((resolve, reject) => {
            const request = http.request({ socketPath: host.socketPath, path: "/rpc", method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
                let raw = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => { raw += chunk; if (raw.length > 20 * 1024 * 1024)
                    request.destroy(new Error("Harness bridge response exceeds 20 MiB")); });
                response.on("error", reject);
                response.on("end", () => {
                    try {
                        const result = JSON.parse(raw);
                        if (response.statusCode !== 200 || result.ok !== true)
                            throw new DeepSeekRpcError(result.error?.code ?? "RPC_ERROR", result.error?.message ?? `Harness bridge HTTP ${response.statusCode}`, result.error?.admissionRejected === true);
                        resolve(result.value);
                    }
                    catch (error) {
                        reject(error);
                    }
                });
            });
            request.setTimeout(this.timeoutMs, () => request.destroy(new DeepSeekRpcError("TRANSPORT_TIMEOUT", "Harness bridge response timed out; dispatch may already have been accepted. Do not resend.")));
            request.on("error", reject);
            request.end(body);
        });
    }
    health(hostId) { return this.rpc("health", {}, hostId); }
    sessions(hostId) { return this.rpc("sessions", {}, hostId); }
    create({ hostId, ...input }) { return this.rpc("create", input, hostId); }
    session({ hostId, ...input }) { return this.rpc("session", input, hostId); }
    prompt({ hostId, ...input }) { return this.rpc("prompt", input, hostId); }
    events({ hostId, ...input }) { return this.rpc("events", input, hostId); }
    cancel({ hostId, ...input }) { return this.rpc("cancel", input, hostId); }
}
function processAlive(pid) {
    if (!Number.isSafeInteger(pid) || !pid || pid < 1)
        return undefined;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "ESRCH" ? false : true;
    }
}
//# sourceMappingURL=deepseek-client.js.map