import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { AcpLiveClient } from "./acp-live.js";
import { TaskCoordinator } from "./coordinator.js";
import { DesktopQueue } from "./desktop-queue.js";
import { listDesktopSessions } from "./desktop-runtime.js";
import { resultForDetail } from "./brief-result.js";
import { serviceStatus } from "./service-cli.js";
import { readServiceRegistration } from "./persistent-service.js";
import path from "node:path";
const config = loadConfig();
const client = new WorkBuddyClient(config);
const store = new TaskStore(config.dbFile);
const coordinator = new TaskCoordinator(config, store, client);
const server = new McpServer({ name: "codex-workbuddy-gateway", version: "0.4.1" });
const timeout = z.number().int().positive().max(86_400).optional();
const taskId = z.string().min(1).max(200);
const detail = z.enum(["full", "brief"]).optional().default("full").describe("full preserves complete records. brief omits repeated goals/history/logs and clips the latest report to 2000 characters, while retaining identity, blockers and artifact paths. Brief summaries are not acceptance evidence.");
server.tool("workbuddy_health", "Probe the configured transport. Online means a connection is available; it does not prove login, model/skill availability, desktop visibility or task success.", { sessionId: z.string().optional(), detail }, ({ sessionId, detail }) => guard(async () => {
    const result = await client.health(sessionId);
    let sessions = [];
    if (config.backend === "desktop-acp") {
        try {
            sessions = AcpLiveClient.listSessions(config).map((endpoint) => ({ sessionId: endpoint.sessionId, ready: endpoint.desktopVisible === true, workspace: endpoint.sessionCwd ?? endpoint.cwd, source: endpoint.runtimeSource }));
        }
        catch { }
    }
    if (config.backend === "desktop-queue")
        sessions = new DesktopQueue(config).listeners();
    const registrationFile = config.serviceConfigFile ?? path.join(path.dirname(config.dbFile), "persistent-service.json");
    const registration = config.backend === "desktop-queue" ? readServiceRegistration(registrationFile) : undefined;
    const bound = registration && path.resolve(registration.dbFile) === path.resolve(config.dbFile) && (!sessionId || sessionId === registration.sessionId);
    const persistentService = config.backend === "desktop-queue" ? (bound ? serviceStatus(registrationFile) : { installed: false }) : undefined;
    const state = persistentService?.state;
    const serviceAvailable = Boolean(persistentService?.installed && persistentService.launchdLoaded && persistentService.desktopRegistered && state?.updatedAt && Date.now() - Date.parse(state.updatedAt) < 30_000);
    return { ok: true, backend: config.backend, online: result.online, desktopSupervision: ["desktop-acp", "desktop-queue"].includes(config.backend), ready: result.ready ?? false, sessionId: result.sessionId ?? persistentService?.sessionId, sessions, persistentService, workerCandidates: config.backend === "desktop-queue" && !bound ? listDesktopSessions(config.workbuddyConfigDir) : undefined, status: result.online ? "transport_online" : serviceAvailable ? (state?.status === "no_task" ? "persistent_service_idle" : "persistent_service_state") : "offline", message: serviceAvailable && !result.online ? (state?.status === "no_task" ? "The persistent service is running. No temporary listener is needed while idle; queued tasks wake the bound native WorkBuddy chat automatically." : "The persistent service is running; inspect its state for active work, blockers or uncertain submission before any retry.") : result.raw.msg, next: persistentService?.installed ? "Persistent service can wake the registered native chat on queued tasks. An idle chat has no claim listener; inspect service state separately. Queued/installed does not prove execution." : "Use a dedicated desktop WorkBuddy worker conversation. Generate persistent setup with prepare_worker(persistent:true), or manually start the temporary claim helper. Candidate history entries are not active listeners." };
}, detail));
server.tool("workbuddy_prepare_worker", "Generate instructions for the selected real desktop chat. persistent:true installs a one-time native auto-wake service; false starts a temporary listener. Read-only: generating a prompt does not install or start anything.", { sessionId: z.string().min(1), persistent: z.boolean().optional().default(false) }, ({ sessionId, persistent }) => guard(async () => ({ ok: true, ...new DesktopQueue(config).prepare(sessionId, persistent) })));
server.tool("workbuddy_send_task", "Reserve and dispatch a task to a verified WorkBuddy desktop conversation. Repeated taskId never dispatches twice. Keep polling with workbuddy_wait, independently inspect the result, then continue or accept.", {
    taskId: taskId.optional(), objective: z.string().min(1), workspace: z.string().optional().describe("Existing absolute directory; must match the desktop session's working directory."),
    sessionId: z.string().min(1).optional().describe("Real WorkBuddy desktop session ID. Required when several live sessions exist."),
    sessionMode: z.enum(["existing", "new"]).optional().default("existing").describe("Queue supports existing only: first bootstrap a real native worker conversation. ACP new is version-dependent."),
    model: z.string().min(1).optional().describe("ACP-only model selection. Queue uses the desktop-selected model and rejects remote model changes."),
    constraints: z.array(z.string()).max(30).optional(), acceptanceCommands: z.array(z.string()).max(30).optional(), timeoutSeconds: timeout,
    detail,
}, ({ detail, ...input }) => guard(() => coordinator.send(input), detail));
server.tool("workbuddy_get_task", "Synchronize progress for the current attempt; includes source/session identity, blockers and real final report. A WorkBuddy turn ending is needs_review, not accepted.", {
    taskId, includeMessages: z.boolean().optional().default(true), limit: z.number().int().positive().max(100).optional().default(100), detail,
}, ({ taskId, includeMessages, limit, detail }) => guard(async () => {
    const task = await coordinator.sync(taskId, limit);
    return { ok: true, task, messages: includeMessages ? store.listMessages(taskId, limit) : undefined, attempts: store.listAttempts(taskId), acceptance: "Inspect actual sources/files and verify relevant checks before acceptance." };
}, detail));
server.tool("workbuddy_wait", "Wait up to 55 seconds for progress or a terminal/input state. Call repeatedly for long tasks; worker execution survives MCP disconnects. Do not tell the user the task is done until reviewing evidence.", {
    taskId, timeoutSeconds: z.number().int().min(0).max(55).optional().default(20), detail,
}, ({ taskId, timeoutSeconds, detail }) => guard(async () => {
    const before = coordinator.requireTask(taskId);
    const deadline = Date.now() + timeoutSeconds * 1000;
    let task = await coordinator.sync(taskId);
    while (["queued", "working"].includes(task.state) && task.lastMessageId === before.lastMessageId && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
        task = await coordinator.sync(taskId);
    }
    return { ok: true, task, messages: store.listMessages(taskId, 100), next: ["queued", "working"].includes(task.state) ? "Call wait again; continue supervision." : task.state === "needs_review" ? "Review actual output, then continue for corrections or accept with evidence." : task.state === "blocked" ? "Read the blocker. If waiting for input, use respond; inspect the original session before rework." : "Read the terminal result." };
}, detail));
server.tool("workbuddy_list_tasks", "List durable task history after reconnecting. Use get/wait on active tasks to resume supervision; never automatically resend a disconnected task.", {
    limit: z.number().int().positive().max(100).optional().default(20), detail,
}, ({ limit, detail }) => guard(async () => ({ ok: true, tasks: store.listTasks({ limit }) }), detail));
server.tool("workbuddy_get_messages", "Synchronize and read current-attempt progress, tool updates and WorkBuddy report. Select an earlier attemptId to inspect history.", {
    taskId, attemptId: z.string().optional(), limit: z.number().int().positive().max(500).optional().default(100), detail,
}, ({ taskId, attemptId, limit, detail }) => guard(async () => ({ ok: true, task: await coordinator.sync(taskId, 100), messages: store.listMessages(taskId, limit, attemptId) }), detail, { messageAttemptId: attemptId }));
server.tool("workbuddy_continue_task", "Send specific review feedback to the same verified desktop session. Original objective, constraints and checks remain in force. Refuses an overlapping prompt or switching sessions.", {
    taskId, feedback: z.string().min(1).max(10_000), acceptanceCommands: z.array(z.string()).max(30).optional(), timeoutSeconds: timeout, model: z.string().min(1).optional(), detail,
}, ({ detail, ...input }) => guard(() => coordinator.continue(input), detail));
server.tool("workbuddy_respond_task", "Respond to an active WorkBuddy permission or form request. Only offered single-action permission choices are accepted; never grants permanent access. Use submit with content for elicitation.", {
    taskId, decision: z.enum(["allow_once", "reject_once", "cancel", "submit"]), content: z.record(z.unknown()).optional(),
}, ({ taskId, decision, content }) => guard(async () => coordinator.respond(taskId, decision, content)));
server.tool("workbuddy_accept_task", "Record acceptance only after independent verification of a real desktop WorkBuddy result. Supply concrete verification evidence and any actual artifact paths. This records an audit, it does not run checks for you.", {
    taskId, note: z.string().min(1).max(2_000), evidence: z.array(z.string().min(1)).min(1).max(30), artifactPaths: z.array(z.string().min(1)).max(100).optional(), detail,
}, ({ taskId, note, evidence, artifactPaths, detail }) => guard(async () => ({ ok: true, task: await coordinator.accept(taskId, note, evidence, artifactPaths) }), detail));
server.tool("workbuddy_cancel_task", "Request cancellation and preserve an audit record. A cancellation request alone does not prove WorkBuddy stopped; inspect the desktop if it continues.", {
    taskId, reason: z.string().max(500).optional(), detail,
}, ({ taskId, reason, detail }) => guard(async () => coordinator.cancel(taskId, reason), detail));
async function guard(action, detail = "full", options = {}) {
    try {
        return jsonResult(resultForDetail(await action(), detail, options));
    }
    catch (error) {
        return jsonResult(resultForDetail({ ok: false, error: error instanceof Error ? error.message : String(error) }, detail));
    }
}
function jsonResult(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
await server.connect(new StdioServerTransport());
process.once("SIGINT", () => { store.close(); process.exit(0); });
process.once("SIGTERM", () => { store.close(); process.exit(0); });
//# sourceMappingURL=server.js.map