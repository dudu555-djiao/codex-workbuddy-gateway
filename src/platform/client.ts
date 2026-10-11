import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubError, waitingStates, type HubRun, type HubEvent, type RunRequestInput } from "./contracts.js";
export type { HubRun, HubEvent, RunRequestInput } from "./contracts.js";

export class AgentHubClient {
  constructor(readonly url: string, private readonly token: string) {
    const target = new URL(url);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Agent Hub v1 connects only to a loopback HTTP origin");
  }
  static local(directory = process.env.AGENT_HUB_STATE_DIR ?? fileURLToPath(new URL("../../data/platform/", import.meta.url))) {
    const connection = JSON.parse(fs.readFileSync(path.join(directory, "connection.json"), "utf8")) as { url: string; tokenFile: string };
    return new AgentHubClient(connection.url, fs.readFileSync(connection.tokenFile, "utf8").trim());
  }
  async request<T = unknown>(route: string, method = "GET", data?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, "")}${route}`, { method, headers: { authorization: `Bearer ${this.token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: signal ?? AbortSignal.timeout(65_000), redirect: "error" });
    const result = await response.json() as T & { error?: { code: string; message: string } };
    if (!response.ok) throw new HubError(result.error?.code ?? "HTTP_ERROR", result.error?.message ?? `HTTP ${response.status}`, response.status);
    return result;
  }
  submit(input: RunRequestInput) { return this.request<{ run: HubRun; created: boolean }>("/v1/runs", "POST", input); }
  get(id: string) { return this.request<HubRun>(`/v1/runs/${encodeURIComponent(id)}`); }
  events(id: string, after = 0) { return this.request<{ events: HubEvent[] }>(`/v1/runs/${encodeURIComponent(id)}/events?after=${after}`); }
  cancel(id: string) { return this.request<HubRun>(`/v1/runs/${encodeURIComponent(id)}/cancel`, "POST", {}); }
  rework(id: string, feedback: string) { return this.request<HubRun>(`/v1/runs/${encodeURIComponent(id)}/rework`, "POST", { feedback }); }
  accept(id: string, note: string, evidence: string[]) { return this.request<HubRun>(`/v1/runs/${encodeURIComponent(id)}/accept`, "POST", { note, evidence }); }
  async wait(id: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HubRun> {
    const deadline = Date.now() + (options.timeoutMs ?? 1_800_000);
    while (Date.now() < deadline) {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) : AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      let run: HubRun;
      try { run = await this.request<HubRun>(`/v1/runs/${encodeURIComponent(id)}/wait?timeoutSeconds=45`, "GET", undefined, signal); }
      catch (error) { if (options.signal?.aborted) throw error; if (Date.now() >= deadline) break; throw error; }
      if (!waitingStates.has(run.status)) return run;
    }
    throw new HubError("WAIT_TIMEOUT", `Waiting timed out; run ${id} remains available and was not cancelled`, 408);
  }
  async run(input: RunRequestInput, options?: { timeoutMs?: number; signal?: AbortSignal }) { const submitted = await this.submit(input); return this.wait(submitted.run.id, options); }
}
