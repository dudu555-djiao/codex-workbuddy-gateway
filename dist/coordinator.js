import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { messageText } from "./workbuddy-client.js";
import { RunJournal, runsDirectory } from "./run-journal.js";
import { readServiceRegistration } from "./persistent-service.js";
export class TaskCoordinator {
    config;
    store;
    client;
    constructor(config, store, client) {
        this.config = config;
        this.store = store;
        this.client = client;
    }
    requireDesktop() {
        if (!["desktop-acp", "desktop-queue"].includes(this.config.backend))
            throw new Error("Desktop supervision requires WORKBUDDY_BACKEND=desktop-queue or desktop-acp. CLI and hidden gateway execution do not prove execution in your WorkBuddy desktop conversation.");
    }
    async send(input) {
        this.requireDesktop();
        if (this.config.backend === "desktop-queue") {
            const registration = readServiceRegistration(this.config.serviceConfigFile ?? path.join(path.dirname(this.config.dbFile), "persistent-service.json"));
            if (registration && path.resolve(registration.dbFile) === path.resolve(this.config.dbFile)) {
                input = { ...input, sessionId: input.sessionId ?? registration.sessionId, workspace: input.workspace ?? registration.workspace };
            }
        }
        const taskId = input.taskId ?? `codex-${crypto.randomUUID()}`;
        const previous = this.store.get(taskId);
        if (previous)
            return { ok: true, created: false, task: previous, message: "Task already exists; no second prompt was dispatched. Use get/wait or continue after review." };
        if (input.workspace && (!path.isAbsolute(input.workspace) || !fs.statSync(input.workspace).isDirectory()))
            throw new Error("workspace must be an existing absolute directory");
        const initial = this.store.createOrGet({ taskId, messageId: `pending-${taskId}`, objective: input.objective, workspace: input.workspace, constraints: input.constraints, acceptanceCommands: input.acceptanceCommands, state: "queued", sessionId: input.sessionId });
        if (!initial.created)
            return { ok: true, created: false, task: initial.task };
        return this.dispatch(initial.task, buildTaskPrompt({ ...input, taskId, timeoutSeconds: input.timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800 }), input);
    }
    async dispatch(task, prompt, input) {
        const attemptId = RunJournal.newId();
        this.store.beginAttempt(task.taskId, { attemptId, messageId: attemptId, sessionId: input.sessionId, acceptanceCommands: input.acceptanceCommands });
        // A reservation is not execution provenance. The actual worker supplies it.
        this.store.updateAttempt(task.taskId, attemptId, { runtimeSource: null });
        try {
            await this.client.sendMessage(prompt, task.workspace, input.timeoutSeconds, input.sessionId ?? task.sessionId, { taskId: task.taskId, attemptId, model: input.model, sessionMode: input.sessionMode });
            return { ok: true, created: true, task: this.store.get(task.taskId), next: "Call workbuddy_wait repeatedly. Read progress, then inspect actual artifacts. Use continue for corrections and accept only after verifying evidence." };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const journal = new RunJournal(runsDirectory(this.config), attemptId);
            journal.save({ ...journal.snapshot(), attemptId, taskId: task.taskId, status: "blocked", sessionId: input.sessionId ?? task.sessionId, error: message, updatedAt: new Date().toISOString() });
            journal.append("result", `TASK_STATUS: blocked\n${message}`, { status: "blocked", blockedReason: message, sessionId: input.sessionId ?? task.sessionId });
            const result = this.store.updateAttempt(task.taskId, attemptId, { state: "blocked", blockingReason: message });
            return { ok: false, task: result.task, error: message };
        }
    }
    async sync(taskId, limit = 100) {
        const task = this.requireTask(taskId);
        if (task.state === "accepted" || task.state === "cancelled")
            return task;
        const messages = await this.client.messages({ afterMessageId: task.lastMessageId, limit });
        if (!messages.length)
            return task;
        this.store.addMessages(taskId, messages);
        const patch = {};
        for (const message of messages) {
            const meta = message.metadata ?? {};
            if (task.attemptId && meta.attemptId && meta.attemptId !== task.attemptId)
                continue;
            patch.lastMessageId = message.message_id;
            if (typeof meta.eventSeq === "number")
                patch.lastEventSeq = meta.eventSeq;
            if (typeof meta.sessionId === "string")
                patch.sessionId = meta.sessionId;
            if (typeof meta.runtimeSource === "string")
                patch.runtimeSource = meta.runtimeSource;
            if (meta.status === "waiting_input") {
                patch.state = "blocked";
                patch.blockingReason = messageText(message);
            }
            else if (meta.status === "working" || meta.status === "queued") {
                patch.state = meta.status;
                patch.blockingReason = null;
            }
            if (meta.type === "result" || message.role === "assistant") {
                const report = parseReport(messageText(message));
                patch.report = report;
                const declared = typeof meta.status === "string" ? meta.status : report.status;
                patch.state = declared === "completed" || declared === "needs_review" ? "needs_review" : ["blocked", "failed", "cancelled"].includes(declared ?? "") ? declared : "blocked";
                patch.blockingReason = typeof meta.blockedReason === "string" ? meta.blockedReason : patch.state === "blocked" ? report.rawText : null;
                if (Array.isArray(meta.artifacts))
                    patch.artifacts = meta.artifacts.filter((value) => typeof value === "string");
            }
        }
        return task.attemptId ? this.store.updateAttempt(taskId, task.attemptId, patch).task : this.store.update(taskId, patch);
    }
    async continue(input) {
        this.requireDesktop();
        const task = await this.sync(input.taskId);
        if (task.state === "cancelled")
            throw new Error("Cancelled tasks cannot be continued; create a new task");
        if (!task.sessionId)
            throw new Error("No verified desktop session is bound. Inspect the old run and start a new task with an explicit WorkBuddy sessionId.");
        if (task.attemptId) {
            const snapshot = this.client.runSnapshot(task.attemptId);
            if (snapshot && ["queued", "working"].includes(snapshot.status))
                throw new Error(snapshot.waitingInput ? "WorkBuddy is waiting for input. Use workbuddy_respond_task; a new prompt would overlap the active turn." : "This task still has an active worker; wait or cancel before sending rework.");
            if (snapshot?.driver === "desktop-queue" && snapshot.status === "blocked" && !snapshot.stopReason && fs.existsSync(path.join(runsDirectory(this.config), task.attemptId, "claim.json")))
                throw new Error("The desktop attempt stopped reporting but its execution has not been confirmed stopped. Inspect the native session before rework.");
        }
        const current = { ...task, acceptanceCommands: [...new Set([...(task.acceptanceCommands ?? []), ...(input.acceptanceCommands ?? [])])] };
        const prompt = buildTaskPrompt({ taskId: current.taskId, objective: current.objective, workspace: current.workspace, constraints: current.constraints, acceptanceCommands: current.acceptanceCommands, timeoutSeconds: input.timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800 }, input.feedback);
        return this.dispatch(current, prompt, { ...input, sessionId: current.sessionId, sessionMode: "existing" });
    }
    async accept(taskId, note, evidence, artifactPaths = []) {
        this.requireDesktop();
        const task = await this.sync(taskId);
        if (task.state !== "needs_review" && task.state !== "completed")
            throw new Error("WorkBuddy must finish the turn before acceptance");
        if (!task.sessionId || !["desktop_interactive", "desktop_queue"].includes(task.runtimeSource ?? "") || !task.report?.rawText.trim())
            throw new Error("Acceptance requires a verified desktop session and a real WorkBuddy result");
        if (!evidence.length || evidence.some((value) => !value.trim()))
            throw new Error("Provide concrete evidence from independent verification, including the command/output or inspected source/artifact");
        const artifactEvidence = artifactPaths.map((file) => {
            if (!path.isAbsolute(file))
                throw new Error("Acceptance artifact paths must be absolute");
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size === 0)
                throw new Error(`Artifact is missing or empty: ${file}`);
            return `Inspected artifact: ${file} (${stat.size} bytes)`;
        });
        if (!task.attemptId)
            throw new Error("Legacy tasks cannot be accepted without a durable desktop execution attempt");
        const accepted = this.store.updateAttempt(taskId, task.attemptId, { state: "accepted", evidence: [...evidence, ...artifactEvidence], artifacts: [...new Set([...(task.artifacts ?? []), ...artifactPaths])], reviewNote: note, reviewedAt: new Date().toISOString() }, { expectedStates: ["needs_review", "completed"] });
        if (!accepted.applied)
            throw new Error("Task changed during review; inspect the current attempt before acceptance");
        return accepted.task;
    }
    respond(taskId, decision, content) {
        this.requireDesktop();
        const task = this.requireTask(taskId);
        if (!task.attemptId)
            throw new Error("This legacy task has no durable input channel");
        this.client.respond(task.attemptId, decision, content);
        return { ok: true, taskId, message: "Input delivered to the active WorkBuddy request; call wait for its response." };
    }
    cancel(taskId, reason) {
        const task = this.requireTask(taskId);
        const requested = this.client.cancel(task.messageId);
        // Preserve uncertainty: cancellation requested does not prove remote execution stopped.
        const updated = this.store.update(taskId, { state: "cancelled", cancelNote: reason ?? "Cancellation requested by Codex; inspect the desktop session if remote work continues." });
        return { ok: true, cancellationRequested: requested, remoteStopped: false, task: updated };
    }
    requireTask(taskId) {
        const task = this.store.get(taskId);
        if (!task)
            throw new Error(`Unknown task_id: ${taskId}`);
        return task;
    }
}
export function parseReport(rawText) {
    const status = rawText.match(/TASK_STATUS:\s*(completed|blocked|failed|working|needs_review|cancelled)/i)?.[1]?.toLowerCase();
    const section = (field) => (rawText.match(new RegExp(`${field}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|\\n\\[/|$)`, "i"))?.[1] ?? "").split("\n").map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
    const value = (field) => rawText.match(new RegExp(`${field}:\\s*(.*)`, "i"))?.[1]?.trim();
    return { status, filesChanged: section("FILES_CHANGED"), commandsRun: section("COMMANDS_RUN"), testResult: value("TEST_RESULT"), remainingProblems: value("REMAINING_PROBLEMS"), rawText };
}
export function buildTaskPrompt(input, feedback) {
    return `[CODEX_TASK]\ntask_id: ${input.taskId}\n目标：\n${input.objective}\n工作目录：${input.workspace ?? "当前绑定桌面会话的目录"}\n约束（每轮继续有效）：\n${input.constraints?.map((item) => `- ${item}`).join("\n") || "按目标范围执行"}\n验收要求：\n${input.acceptanceCommands?.map((item) => `- ${item}`).join("\n") || "运行相关检查并报告真实结果"}\n超时（秒）：${input.timeoutSeconds ?? 1800}\n${feedback ? `Codex 本轮验收反馈（逐项修正，保留已有有效成果）：\n${feedback}\n` : ""}执行要求：使用 WorkBuddy 当前会话和自身工具完成任务。遇到输入、权限、素材或能力阻碍时如实报告。不要把计划或请求受理当成成品，也不要宣称别的 Agent 完成的文件是本轮成果。最终给出实际产物路径、用到的工具/技能、运行的命令和结果。\n最终格式：\nTASK_STATUS: completed | blocked | failed\nARTIFACTS:\nFILES_CHANGED:\nCOMMANDS_RUN:\nTEST_RESULT:\nREMAINING_PROBLEMS:\n[/CODEX_TASK]`;
}
//# sourceMappingURL=coordinator.js.map