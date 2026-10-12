import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubError, waitingStates } from "./contracts.js";
export class AgentHubClient {
    url;
    token;
    constructor(url, token) {
        this.url = url;
        this.token = token;
        const target = new URL(url);
        if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password || target.pathname !== "/" || target.search || target.hash)
            throw new Error("Agent Hub v1 connects only to a loopback HTTP origin");
    }
    static local(directory = process.env.AGENT_HUB_STATE_DIR ?? fileURLToPath(new URL("../../data/platform/", import.meta.url))) {
        const connection = JSON.parse(fs.readFileSync(path.join(directory, "connection.json"), "utf8"));
        return new AgentHubClient(connection.url, fs.readFileSync(connection.tokenFile, "utf8").trim());
    }
    async request(route, method = "GET", data, signal) {
        const response = await fetch(`${this.url.replace(/\/$/, "")}${route}`, { method, headers: { authorization: `Bearer ${this.token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: signal ?? AbortSignal.timeout(65_000), redirect: "error" });
        const result = await response.json();
        if (!response.ok)
            throw new HubError(result.error?.code ?? "HTTP_ERROR", result.error?.message ?? `HTTP ${response.status}`, response.status);
        return result;
    }
    submit(input) { return this.request("/v1/runs", "POST", input); }
    models(sessionId) { return this.request('/v1/providers/workbuddy/models' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '')); }
    workspaces() { return this.request('/v1/providers/workbuddy/workspaces'); }
    bindWorkspace(input) { return this.request('/v1/providers/workbuddy/workspaces', 'POST', input); }
    get(id) { return this.request(`/v1/runs/${encodeURIComponent(id)}`); }
    events(id, after = 0) { return this.request(`/v1/runs/${encodeURIComponent(id)}/events?after=${after}`); }
    cancel(id) { return this.request(`/v1/runs/${encodeURIComponent(id)}/cancel`, "POST", {}); }
    rework(id, feedback, model) { return this.request(`/v1/runs/${encodeURIComponent(id)}/rework`, "POST", { feedback, model }); }
    accept(id, note, evidence) { return this.request(`/v1/runs/${encodeURIComponent(id)}/accept`, "POST", { note, evidence }); }
    async wait(id, options = {}) {
        const deadline = Date.now() + (options.timeoutMs ?? 1_800_000);
        while (Date.now() < deadline) {
            const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) : AbortSignal.timeout(Math.max(1, deadline - Date.now()));
            let run;
            try {
                run = await this.request(`/v1/runs/${encodeURIComponent(id)}/wait?timeoutSeconds=45`, "GET", undefined, signal);
            }
            catch (error) {
                if (options.signal?.aborted)
                    throw error;
                if (Date.now() >= deadline)
                    break;
                throw error;
            }
            if (!waitingStates.has(run.status))
                return run;
        }
        throw new HubError("WAIT_TIMEOUT", `Waiting timed out; run ${id} remains available and was not cancelled`, 408);
    }
    async run(input, options) { const submitted = await this.submit(input); return this.wait(submitted.run.id, options); }
}
//# sourceMappingURL=client.js.map