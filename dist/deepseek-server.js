import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeepSeekClient } from "./deepseek-client.js";
import { DeepSeekStore } from "./deepseek-store.js";
import { DeepSeekCoordinator } from "./deepseek-coordinator.js";
import { summarizeDeepSeekEvents } from "./deepseek-evidence.js";
const dbFile = process.env.DEEPSEEK_DB_FILE ?? fileURLToPath(new URL("../data/deepseek/tasks.sqlite", import.meta.url));
const client = new DeepSeekClient();
const store = new DeepSeekStore(dbFile);
const coordinator = new DeepSeekCoordinator(store, client);
const server = new McpServer({ name: "codex-deepseek-gateway", version: "0.1.1" });
const taskId = z.string().min(1).max(200);
const hostId = z.string().min(1).max(200).optional();
const detail = z.enum(["brief", "full"]).optional().default("brief");
const timeoutSeconds = z.number().int().min(1).max(86400).optional();
server.tool("deepseek_health", "Probe authenticated Harness bridge. A reachable plugin does not prove model availability, an active turn or successful output. Never expose the local registry token.", { hostId }, ({ hostId }) => guard(async () => {
    const hosts = client.hosts().map(({ hostId, pid, version, profile, runtimeSource, processAlive }) => ({ hostId, pid, version, profile, runtimeSource, processAlive }));
    const candidates = hosts.filter((host) => host.processAlive !== false);
    if (!hostId && !client.defaultHostId && candidates.length > 1)
        return { ok: true, online: false, selectionRequired: true, hosts, dbFile, message: "Multiple live Harness hosts are registered. Select hostId explicitly; no host was probed." };
    try {
        const selectedHostId = client.resolveHostId(hostId);
        return { ok: true, hosts, selectedHostId, health: await client.health(selectedHostId), dbFile };
    }
    catch (error) {
        return { ok: false, hosts, dbFile, error: error instanceof Error ? error.message : String(error) };
    }
}));
server.tool("deepseek_list_sessions", "List real Harness sessions. Select an explicit host/session before dispatch; busy sessions cannot receive overlapping tasks.", { hostId }, ({ hostId }) => guard(async () => ({ ok: true, hostId: client.resolveHostId(hostId), ...await client.sessions(hostId) })));
server.tool("deepseek_create_session", "Create a new visible Harness conversation in an existing absolute workspace. Creation is explicit and does not dispatch a task.", { hostId, workspace: z.string().min(1), title: z.string().min(1).max(200).optional() }, ({ hostId, workspace, title }) => guard(async () => {
    if (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory())
        throw new Error("workspace must be an existing absolute directory");
    return { ok: true, hostId: client.resolveHostId(hostId), session: await client.create({ hostId, workspace, title }) };
}));
server.tool("deepseek_send_task", "Persist attempt identity before dispatching into a real Harness session. Repeated taskId never dispatches twice. On uncertain transport, synchronize the same task; never resend.", {
    taskId: taskId.optional(), hostId, sessionId: z.string().min(1), objective: z.string().min(1).max(100000), workspace: z.string().optional(), constraints: z.array(z.string()).max(30).optional(), acceptanceCommands: z.array(z.string()).max(30).optional(), timeoutSeconds, detail,
}, ({ detail, ...input }) => guard(() => coordinator.send(input), detail));
server.tool("deepseek_get_task", "Recover current attempt from persistent Harness events. brief returns status/result; evidence adds bounded tool calls/results and matching turn evidence without model streams; full includes raw local history for diagnosis.", { taskId, detail: z.enum(["brief", "evidence", "full"]).optional().default("brief"), eventLimit: z.number().int().min(1).max(500).optional().default(100) }, ({ taskId, detail, eventLimit }) => guard(async () => {
    const task = await coordinator.sync(taskId);
    return { ok: true, task, ...(detail === "full" ? { attempts: store.attempts(taskId), events: store.events(task.attemptId, eventLimit) } : detail === "evidence" ? { events: summarizeDeepSeekEvents(store.events(task.attemptId, eventLimit)), eventScope: `Evidence from the last ${eventLimit} locally synchronized events of the current attempt; raw history remains available with detail=full.` } : {}), acceptance: "A completed turn is needs_review. Inspect actual files/sources and relevant checks before acceptance." };
}, detail));
server.tool("deepseek_wait", "Wait at most 55 seconds for progress. Harness execution continues independently of the MCP process. Repeat wait until terminal/input state, then independently verify outputs.", { taskId, timeoutSeconds: z.number().int().min(0).max(55).optional().default(20), detail }, ({ taskId, timeoutSeconds, detail }) => guard(() => coordinator.wait(taskId, timeoutSeconds), detail));
server.tool("deepseek_list_tasks", "Read durable task history. Resume get/wait for active or uncertain runs; list does not automatically redispatch tasks.", { limit: z.number().int().min(1).max(100).optional().default(20), detail }, ({ limit, detail }) => guard(async () => ({ ok: true, tasks: store.list(limit) }), detail));
server.tool("deepseek_continue_task", "Dispatch reviewed corrections into the same Harness conversation, preserving objective and scope. Checks append by default; acceptanceMode=replace requires the complete nonempty revised list when criteria change. Refuses active or uncertain runs.", { taskId, feedback: z.string().min(1).max(20000), acceptanceCommands: z.array(z.string().min(1)).max(30).optional(), acceptanceMode: z.enum(["append", "replace"]).optional().default("append"), timeoutSeconds, detail }, ({ detail, ...input }) => guard(() => coordinator.continue(input), detail));
server.tool("deepseek_cancel_task", "Request cancellation and record uncertainty. cancelled is recorded only after Harness confirms the run stopped; a request alone cannot unlock the session.", { taskId, reason: z.string().max(1000).optional(), detail }, ({ taskId, reason, detail }) => guard(() => coordinator.cancel(taskId, reason), detail));
server.tool("deepseek_accept_task", "Record acceptance after independently inspecting actual artifacts and running relevant checks. Evidence is your audit statement; this tool only verifies supplied artifact paths exist and are nonempty.", { taskId, note: z.string().min(1).max(2000), evidence: z.array(z.string().min(1)).min(1).max(30), artifactPaths: z.array(z.string().min(1)).max(100).optional(), detail }, ({ taskId, note, evidence, artifactPaths, detail }) => guard(async () => ({ ok: true, task: await coordinator.accept(taskId, note, evidence, artifactPaths) }), detail));
function briefTask(task) {
    return { taskId: task.taskId, hostId: task.hostId, sessionId: task.sessionId, workspace: task.workspace, state: task.state,
        attemptId: task.attemptId, attempt: task.attempt, requestId: task.requestId, turnId: task.turnId, runOpen: task.runOpen,
        dispatchState: task.dispatchState, deadlineAt: task.deadlineAt, lastEventSeq: task.lastEventSeq, updatedAt: task.updatedAt,
        blockingReason: task.blockingReason, blockingKind: task.blockingKind, syncError: task.syncError, cancelRequested: task.cancelRequested, artifacts: task.artifacts,
        report: clip(task.report), lastProgress: clip(task.lastProgress), evidence: task.evidence, reviewNote: task.reviewNote };
}
function clip(value) { return value && value.length > 2000 ? `${value.slice(0, 2000)}\n[truncated; use deepseek_get_task detail=full for the complete local record]` : value; }
async function guard(action, detail = "brief") {
    let result;
    try {
        result = await action();
    }
    catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (detail !== "full" && result && typeof result === "object") {
        const value = result;
        if (value.task)
            value.task = briefTask(value.task);
        if (Array.isArray(value.tasks))
            value.tasks = value.tasks.map(briefTask);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
await server.connect(new StdioServerTransport());
process.once("SIGINT", () => { store.close(); process.exit(0); });
process.once("SIGTERM", () => { store.close(); process.exit(0); });
//# sourceMappingURL=deepseek-server.js.map