import fs from "node:fs";
import path from "node:path";
import { TaskStore } from "../task-store.js";
import { TaskCoordinator } from "../coordinator.js";
import { WorkBuddyClient, messageText } from "../workbuddy-client.js";
import { runsDirectory } from "../run-journal.js";
import { workerRegistration, listModels, listWorkspaces, ensureWorkspace } from "../workspace-manager.js";
import { HubError } from "./contracts.js";
export class WorkBuddyProvider {
    config;
    id = "workbuddy";
    label = "WorkBuddy";
    capabilities = { outputs: ["text", "json", "artifacts"], execution: "native-desktop", sessionIsolation: "project", modelSelection: true, workspaceBinding: true, creditUsage: false, cancellation: "cooperative", fullToolTrace: false };
    store;
    client;
    coordinator;
    constructor(config) {
        this.config = config;
        if (config.backend !== "desktop-queue")
            throw new Error("Agent Hub v1 requires WORKBUDDY_BACKEND=desktop-queue; other providers are not silently substituted");
        this.store = new TaskStore(config.dbFile);
        this.client = new WorkBuddyClient(config);
        this.coordinator = new TaskCoordinator(config, this.store, this.client);
    }
    close() { this.store.close(); }
    models(sessionId) { return listModels(this.config, sessionId); }
    workspaces() { return { ok: true, workers: listWorkspaces(this.config) }; }
    bindWorkspace(input) { return ensureWorkspace(this.config, input); }
    async health() {
        let message = "First submitted workspace will be prepared automatically. WorkBuddy login and permissions must be valid.";
        let state = "needs_setup";
        try {
            const registration = workerRegistration(this.config);
            if (registration) {
                const file = path.join(registration.projectDir, "data", "persistent-service-status.json");
                const heartbeat = JSON.parse(fs.readFileSync(file, "utf8"));
                const fresh = heartbeat.updatedAt && Date.now() - Date.parse(heartbeat.updatedAt) < 30_000;
                state = fresh ? "available" : "degraded";
                message = fresh ? "Native wake service heartbeat is current. Login, model quota and permissions are confirmed only by execution." : "Native wake service heartbeat is stale; inspect the existing service before resubmitting.";
            }
        }
        catch (error) {
            state = "degraded";
            message = error instanceof Error ? error.message : String(error);
        }
        return { state, message, login: "unknown", model: "selected_in_workbuddy", usage: { credits: null, source: "unavailable" } };
    }
    instructions(run) {
        return `${run.input.task}\n\n平台结果要求（本轮）：\n使用本 WorkBuddy 会话自己的模型、工具和 Skill 执行，自检后将真实结果写入 ${run.resultFile}。先创建该结果文件的父目录。文件必须为 UTF-8 JSON 对象：{"text":"简短真实结果","json":任意JSON值,"artifacts":["真实产物绝对路径"]}。text 必须非空；${run.input.output === "json" ? "json 字段必须包含用户要求的结构化成果。" : "json 字段可省略。"}${run.input.output === "artifacts" ? "artifacts 至少包含一个真实成果文件。" : "没有附加文件时 artifacts 使用空数组。"}产物只写入本任务工作目录或上述结果文件所在目录。不要将结果文件自身列入 artifacts。不要改平台源码、配置或写记忆。最终通过当前 claim 身份 report 真实状态、结果文件路径和产物。任务受阻时如实 report blocked，不能仅写结果文件就声称业务任务成功。`;
    }
    async submit(run) {
        let response;
        try {
            response = await this.coordinator.send({ taskId: run.providerTaskId, workspace: run.workspace, sessionId: run.input.sessionId, model: run.input.model, objective: this.instructions(run), constraints: run.input.constraints, timeoutSeconds: Math.max(1, Math.ceil((Date.parse(run.deadline) - Date.now()) / 1000)) });
        }
        catch (error) {
            // The coordinator reserves TaskStore before it can submit a task. Native
            // workspace preparation alone does not execute the user's objective.
            if (!this.store.get(run.providerTaskId))
                throw new HubError("DISPATCH_NOT_SENT", error instanceof Error ? error.message : String(error));
            throw error;
        }
        if (!response.ok)
            throw new Error(("error" in response && response.error) || "WorkBuddy dispatch was blocked");
    }
    async poll(run) {
        if (!this.store.get(run.providerTaskId))
            return undefined;
        const task = await this.coordinator.sync(run.providerTaskId);
        const snapshot = task.attemptId ? this.client.runSnapshot(task.attemptId) : undefined;
        const claimed = task.attemptId && fs.existsSync(path.join(runsDirectory(this.config), task.attemptId, "claim.json"));
        const active = snapshot?.status === "queued" || snapshot?.status === "working" || Boolean(claimed && !snapshot?.stopReason);
        const status = task.state === "working" ? "running" : ["needs_review", "completed", "accepted"].includes(task.state) ? "completed" : task.state === "cancelled" ? "cancelled" : task.state === "failed" ? "failed" : task.state === "blocked" ? "blocked" : "queued";
        return { status, holdsCapacity: active, attemptId: task.attemptId, sessionId: task.sessionId, runtimeSource: task.runtimeSource, error: task.blockingReason, accepted: task.state === "accepted", events: this.store.listMessages(task.taskId).map(message => ({ key: `${task.attemptId}:${message.message_id}`, type: "provider", text: messageText(message).slice(0, 32_000) })) };
    }
    async cancel(run) {
        const task = this.store.get(run.providerTaskId);
        if (task)
            this.client.cancel(task.messageId);
    }
    async rework(run) {
        const response = await this.coordinator.continue({ taskId: run.providerTaskId, model: run.input.model, feedback: `${run.feedback}\n\n${this.instructions(run)}`, timeoutSeconds: Math.max(1, Math.ceil((Date.parse(run.deadline) - Date.now()) / 1000)) });
        if (!response.ok)
            throw new Error(response.error ?? "WorkBuddy rework was blocked");
    }
    async accept(run, input) {
        await this.coordinator.accept(run.providerTaskId, input.note, input.evidence, [run.resultFile, ...(run.result?.artifacts.map(item => item.path) ?? [])]);
    }
}
//# sourceMappingURL=workbuddy.js.map