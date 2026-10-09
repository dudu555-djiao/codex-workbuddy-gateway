import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { WorkBuddyApiError, WorkBuddyClient, messageText } from "./workbuddy-client.js";
const config = loadConfig();
const client = new WorkBuddyClient(config);
const store = new TaskStore(config.dbFile);
const server = new McpServer({ name: "codex-workbuddy-gateway", version: "0.1.0" });
server.tool("workbuddy_health", "Check whether the WorkBuddy Local Assistant is online and ready to accept a task.", {}, async () => {
    try {
        const result = await client.health();
        return jsonResult({ ok: true, online: result.online, status: result.online ? "ready" : "offline", message: result.online ? "WorkBuddy Local Assistant is online." : "Open WorkBuddy and bring the Local Assistant online." });
    }
    catch (error) {
        return errorResult(error);
    }
});
server.tool("workbuddy_send_task", "Send one idempotent, structured task to the WorkBuddy Local Assistant. A repeated task_id never sends a second message.", {
    taskId: z.string().min(1).max(200).optional().describe("Stable idempotency key. Reuse it when retrying the same task."),
    objective: z.string().min(1).describe("The task WorkBuddy should execute."),
    workspace: z.string().optional().describe("Absolute workspace path WorkBuddy should use."),
    constraints: z.array(z.string()).max(30).optional(),
    acceptanceCommands: z.array(z.string()).max(30).optional().describe("Commands WorkBuddy must run and report."),
    timeoutSeconds: z.number().int().positive().max(86_400).optional(),
}, async ({ taskId, objective, workspace, constraints, acceptanceCommands, timeoutSeconds }) => {
    const id = taskId ?? `codex-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
    const existing = store.get(id);
    if (existing)
        return jsonResult({ ok: true, created: false, task: existing, message: "This task_id already exists; no duplicate WorkBuddy message was sent." });
    try {
        const health = await client.health();
        if (!health.online)
            return jsonResult({ ok: false, state: "blocked", task_id: id, message: "WorkBuddy Local Assistant is offline. Start it, then call workbuddy_send_task again with the same taskId." });
        const prompt = buildTaskPrompt({ id, objective, workspace, constraints, acceptanceCommands, timeoutSeconds });
        const sent = await client.sendMessage(prompt);
        const result = store.createOrGet({ taskId: id, messageId: sent.messageId, objective, workspace, state: "working", lastMessageId: sent.messageId });
        return jsonResult({ ok: true, created: result.created, task: result.task, next: "Poll with workbuddy_get_task or workbuddy_get_messages." });
    }
    catch (error) {
        return errorResult(error);
    }
});
server.tool("workbuddy_get_task", "Get a task status and pull new WorkBuddy messages since the last message seen by the Gateway.", { taskId: z.string().min(1), includeMessages: z.boolean().optional().default(true), limit: z.number().int().positive().max(100).optional().default(100) }, async ({ taskId, includeMessages, limit }) => {
    const task = store.get(taskId);
    if (!task)
        return jsonResult({ ok: false, state: "unknown", message: `Unknown task_id: ${taskId}` });
    try {
        const fresh = includeMessages && task.state !== "cancelled" ? await syncTask(taskId, limit) : store.get(taskId);
        return jsonResult({ ok: true, task: fresh, messages: includeMessages ? store.listMessages(taskId, limit) : undefined, acceptance: "WorkBuddy completion is not Codex acceptance; inspect the workspace and run verification commands yourself." });
    }
    catch (error) {
        return errorResult(error, { task: store.get(taskId) });
    }
});
server.tool("workbuddy_get_messages", "Read the raw, normalized messages captured for a Gateway task. The call first performs an incremental WorkBuddy history query.", { taskId: z.string().min(1), limit: z.number().int().positive().max(500).optional().default(100) }, async ({ taskId, limit }) => {
    const task = store.get(taskId);
    if (!task)
        return jsonResult({ ok: false, state: "unknown", message: `Unknown task_id: ${taskId}` });
    try {
        const updated = await syncTask(taskId, limit);
        return jsonResult({ ok: true, task: updated, messages: store.listMessages(taskId, limit) });
    }
    catch (error) {
        return errorResult(error, { task: store.get(taskId), messages: store.listMessages(taskId, limit) });
    }
});
server.tool("workbuddy_cancel_task", "Mark a Gateway task as cancelled locally. The WorkBuddy Local Assistant API has no remote cancellation endpoint, so this does not stop an already running assistant turn.", { taskId: z.string().min(1), reason: z.string().max(500).optional() }, async ({ taskId, reason }) => {
    const task = store.get(taskId);
    if (!task)
        return jsonResult({ ok: false, state: "unknown", message: `Unknown task_id: ${taskId}` });
    const updated = store.update(taskId, { state: "cancelled", cancelNote: reason ?? "Cancelled by Codex." });
    return jsonResult({ ok: true, task: updated, warning: "WorkBuddy does not expose a Local Assistant cancellation endpoint; the Gateway will stop polling this task, but the remote turn may continue." });
});
async function syncTask(taskId, limit) {
    const task = store.get(taskId);
    if (!task)
        throw new Error(`Unknown task_id: ${taskId}`);
    if (task.state === "cancelled")
        return task;
    const messages = await client.messages({ afterMessageId: task.lastMessageId, limit });
    if (messages.length === 0)
        return task;
    store.addMessages(taskId, messages);
    const last = messages[messages.length - 1];
    const assistantText = messages.filter((message) => message.role === "assistant").map(messageText).join("\n");
    const report = assistantText ? parseReport(assistantText) : undefined;
    const state = report?.status === "completed" ? "completed" : report?.status === "blocked" ? "blocked" : report?.status === "failed" ? "failed" : "working";
    return store.update(taskId, { lastMessageId: last.message_id, state, report });
}
function parseReport(rawText) {
    const status = rawText.match(/TASK_STATUS:\s*(completed|blocked|failed|working|needs_review)/i)?.[1]?.toLowerCase();
    const filesChanged = sectionLines(rawText, "FILES_CHANGED");
    const commandsRun = sectionLines(rawText, "COMMANDS_RUN");
    const testResult = fieldValue(rawText, "TEST_RESULT");
    const remainingProblems = fieldValue(rawText, "REMAINING_PROBLEMS");
    return { status, filesChanged, commandsRun, testResult, remainingProblems, rawText };
}
function sectionLines(text, field) {
    const match = text.match(new RegExp(`${field}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|\\n\\[/CODEX_TASK\\]|$)`, "i"));
    if (!match?.[1])
        return [];
    return match[1].split("\n").map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}
function fieldValue(text, field) {
    return text.match(new RegExp(`${field}:\\s*(.*)`, "i"))?.[1]?.trim();
}
function buildTaskPrompt(input) {
    const constraints = input.constraints?.length ? input.constraints.map((item, index) => `${index + 1}. ${item}`).join("\n") : "(none supplied)";
    const commands = input.acceptanceCommands?.length ? input.acceptanceCommands.map((command) => `- ${command}`).join("\n") : "(run the project's relevant checks and report them)";
    return `[CODEX_TASK]\ntask_id: ${input.id}\n\n目标：\n${input.objective}\n\n工作目录：\n${input.workspace ?? "请先识别当前 WorkBuddy 工作目录，并在报告中写明"}\n\n约束：\n${constraints}\n\n超时（秒）：\n${input.timeoutSeconds ?? 1800}\n\n执行要求：\n1. 先检查相关代码与当前状态。\n2. 只做完成目标所需的修改。\n3. 运行并报告验收命令。\n4. 如果需要权限确认或无法继续，明确写出等待什么。\n\n验收命令：\n${commands}\n\n最终输出格式（字段名保持不变）：\nTASK_STATUS: completed | blocked | failed\nFILES_CHANGED:\nCOMMANDS_RUN:\nTEST_RESULT:\nREMAINING_PROBLEMS:\n[/CODEX_TASK]`;
}
function jsonResult(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errorResult(error, extra = {}) {
    const message = error instanceof WorkBuddyApiError ? error.message : error instanceof Error ? error.message : String(error);
    return jsonResult({ ok: false, error: message, ...extra });
}
const transport = new StdioServerTransport();
await server.connect(transport);
process.once("SIGINT", () => { store.close(); process.exit(0); });
process.once("SIGTERM", () => { store.close(); process.exit(0); });
//# sourceMappingURL=server.js.map