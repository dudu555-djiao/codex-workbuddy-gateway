import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DeepSeekRpcError, type DeepSeekTransport } from "./deepseek-client.js";
import { DeepSeekStore, type DeepSeekTask } from "./deepseek-store.js";

export interface DeepSeekSendInput { taskId?: string; hostId?: string; sessionId: string; objective: string; workspace?: string; constraints?: string[]; acceptanceCommands?: string[]; timeoutSeconds?: number; }
export class DeepSeekCoordinator {
  constructor(readonly store: DeepSeekStore, readonly client: DeepSeekTransport) {}
  requireTask(taskId: string): DeepSeekTask { const task = this.store.get(taskId); if (!task) throw new Error(`Unknown DeepSeek task: ${taskId}`); return task; }
  async send(input: DeepSeekSendInput) {
    const taskId = input.taskId ?? `deepseek-${crypto.randomUUID()}`;
    const existing = this.store.get(taskId);
    if (existing) return { ok: true, created: false, task: existing, message: "Task already exists. No duplicate prompt was dispatched; synchronize it or continue after review." };
    const hostId = this.client.resolveHostId(input.hostId);
    const session = await this.client.session({ hostId, sessionId: input.sessionId });
    if (session.sessionId !== input.sessionId) throw new Error("Harness returned a different session identity");
    if (session.busy) throw new Error("Harness session is busy. Wait for its active turn before dispatching.");
    const workspace = verifiedWorkspace(input.workspace, session.workspace);
    const now = new Date().toISOString(); const attemptId = crypto.randomUUID();
    const task: DeepSeekTask = { taskId, objective: input.objective, hostId, sessionId: session.sessionId, workspace,
      constraints: input.constraints ?? [], acceptanceCommands: input.acceptanceCommands ?? [], state: "queued", attemptId, attempt: 1,
      requestId: attemptId, runOpen: true, dispatchState: "reserved", createdAt: now, updatedAt: now,
      deadlineAt: deadline(input.timeoutSeconds), lastEventSeq: -1, artifacts: [], evidence: [] };
    const reservation = this.store.reserve(task);
    if (!reservation.created) return { ok: true, created: false, task: reservation.task };
    return this.dispatch(task, buildDeepSeekPrompt(task));
  }
  private async dispatch(task: DeepSeekTask, text: string) {
    try {
      const result = await this.client.prompt({ hostId: task.hostId, sessionId: task.sessionId, requestId: task.requestId, text });
      if (result.requestId !== task.requestId || result.accepted !== true) throw new Error("Harness did not confirm the reserved request identity; dispatch remains uncertain");
      const updated = this.store.update(task.taskId, task.attemptId, { state: "working", dispatchState: "accepted", turnId: result.turnId, blockingReason: undefined, blockingKind: undefined }, { expectedOpen: true, expectedDispatchStates: ["reserved", "uncertain"] });
      return { ok: true, created: true, task: updated, next: "Call deepseek_wait repeatedly. Independently inspect artifacts/checks before accept; use continue for corrections." };
    } catch (error) {
      const message = errorText(error);
      const rejectedBeforeAdmission = error instanceof DeepSeekRpcError && error.admissionRejected === true;
      // Only explicit pre-admission rejection may release the lock. A lost response
      // or bridge/admission-unknown can follow a successful native dispatch.
      const updated = this.store.update(task.taskId, task.attemptId, rejectedBeforeAdmission
        ? { state: "failed", runOpen: false, dispatchState: "rejected", blockingKind: "executor", blockingReason: `Harness rejected the prompt before admission: ${message}` }
        : { state: "blocked", dispatchState: "uncertain", blockingKind: "dispatch_unknown", blockingReason: `Dispatch outcome unknown: ${message}. Never resend this attempt; synchronize its persisted events.` }, { expectedOpen: true });
      return { ok: false, created: true, task: updated, error: message, dispatchUncertain: updated.runOpen };
    }
  }
  async sync(taskId: string, limit = 100): Promise<DeepSeekTask> {
    const task = this.requireTask(taskId);
    if (!task.runOpen) return task;
    try {
      let pageLimit = Math.max(1, Math.min(256, task.eventPageLimit ?? limit));
      let result;
      for (;;) {
        try { result = await this.client.events({ hostId: task.hostId, sessionId: task.sessionId, requestId: task.requestId, afterSeq: task.lastEventSeq, limit: pageLimit }); break; }
        catch (error) {
          if (!(error instanceof DeepSeekRpcError) || error.code !== "bridge/response-too-large") throw error;
          if (pageLimit === 1) throw new Error("One persisted Harness event exceeds the bridge response limit. The plugin must provide a local payload reference before this run can be synchronized; no prompt was resent.");
          pageLimit = Math.max(1, Math.floor(pageLimit / 2));
          this.store.update(taskId, task.attemptId, { eventPageLimit: pageLimit }, { expectedOpen: true });
        }
      }
      if (!Array.isArray(result.events) || !Number.isSafeInteger(result.cursor)) throw new Error("Malformed Harness event response");
      this.store.applyEvents(taskId, task.attemptId, result.events, result.cursor);
      const updated = this.store.syncSucceeded(taskId, task.attemptId, pageLimit);
      if (updated.runOpen && Date.now() >= Date.parse(updated.deadlineAt)) return this.store.update(taskId, task.attemptId, { state: "blocked", blockingKind: "deadline", blockingReason: "Supervision deadline elapsed. Harness may still be running; cancellation or a persisted terminal event is required before rework." }, { expectedOpen: true });
      return updated;
    } catch (error) {
      return this.store.syncFailed(taskId, task.attemptId, `Harness synchronization unavailable: ${errorText(error)}. Execution may continue; reconnect and synchronize without resending.`);
    }
  }
  async wait(taskId: string, timeoutSeconds = 20) {
    const initial = this.requireTask(taskId); const until = Date.now() + Math.max(0, Math.min(55, timeoutSeconds)) * 1000;
    let task = await this.sync(taskId);
    while (task.runOpen && task.state !== "blocked" && task.lastEventSeq === initial.lastEventSeq && Date.now() < until) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, until - Date.now()))); task = await this.sync(taskId);
    }
    return { ok: true, task, next: task.runOpen ? "Continue supervision with wait/get. An open run cannot be resent or reworked, even after a timeout or disconnect." : task.state === "needs_review" ? "Review actual outputs and relevant checks, then accept with evidence or continue with feedback." : "Inspect the terminal report." };
  }
  async continue(input: { taskId: string; feedback: string; acceptanceCommands?: string[]; acceptanceMode?: "append" | "replace"; timeoutSeconds?: number }) {
    if (input.acceptanceMode === "replace" && !input.acceptanceCommands?.length) throw new Error("Replacing acceptance checks requires a nonempty complete revised list");
    const current = await this.sync(input.taskId);
    if (current.runOpen) throw new Error("Harness run has not been confirmed stopped. Wait, resolve pending input in the App, or cancel and await a terminal event before rework.");
    if (current.state === "cancelled") throw new Error("Cancelled tasks cannot be continued; create a new task explicitly");
    const session = await this.client.session({ hostId: current.hostId, sessionId: current.sessionId });
    if (session.sessionId !== current.sessionId || session.busy) throw new Error("Bound Harness session is busy or changed; no rework was dispatched");
    verifiedWorkspace(current.workspace, session.workspace);
    const attemptId = crypto.randomUUID();
    const task: DeepSeekTask = { ...current, attemptId, requestId: attemptId, attempt: current.attempt + 1, turnId: undefined,
      state: "queued", dispatchState: "reserved", runOpen: true, updatedAt: new Date().toISOString(), deadlineAt: deadline(input.timeoutSeconds),
      acceptanceCommands: [...new Set(input.acceptanceMode === "replace" ? input.acceptanceCommands! : [...current.acceptanceCommands, ...(input.acceptanceCommands ?? [])])], lastEventSeq: -1,
      lastProgress: undefined, report: undefined, artifacts: [], evidence: [], blockingReason: undefined, blockingKind: undefined, syncError: undefined,
      cancelRequested: false, cancelNote: undefined, cancelledAt: undefined, reviewNote: undefined, reviewedAt: undefined };
    this.store.reserve(task, input.feedback);
    return this.dispatch(task, buildDeepSeekPrompt(task, input.feedback));
  }
  async cancel(taskId: string, reason = "Cancellation requested by Codex") {
    const task = await this.sync(taskId);
    if (!task.runOpen) return { ok: true, task, cancellationRequested: false, remoteStopped: true, message: "Run already ended; no cancellation was dispatched." };
    const requested = this.store.update(taskId, task.attemptId, { state: "blocked", cancelRequested: true, cancelNote: reason, blockingKind: "cancel_requested", blockingReason: "Cancellation requested; awaiting confirmed stop" }, { expectedOpen: true });
    if (!requested.runOpen) return { ok: true, task: requested, cancellationRequested: false, remoteStopped: true };
    try {
      const result = await this.client.cancel({ hostId: task.hostId, sessionId: task.sessionId, requestId: task.requestId });
      const updated = result.stopped === true ? this.store.update(taskId, task.attemptId, { state: "cancelled", runOpen: false, cancelledAt: new Date().toISOString(), blockingReason: undefined, blockingKind: undefined }, { expectedOpen: true }) : await this.sync(taskId);
      return { ok: true, task: updated, cancellationRequested: result.requested, remoteStopped: !updated.runOpen };
    } catch (error) { return { ok: false, task: this.requireTask(taskId), cancellationRequested: true, remoteStopped: false, error: errorText(error) }; }
  }
  async accept(taskId: string, note: string, evidence: string[], artifactPaths: string[] = []) {
    const task = await this.sync(taskId);
    if (task.state !== "needs_review" || task.runOpen || task.dispatchState !== "accepted") throw new Error("Acceptance requires a confirmed completed Harness turn");
    if (!task.report?.trim() && !task.artifacts.length) throw new Error("Harness produced no result text or artifact evidence; inspect the session before accepting");
    if (!note.trim() || !evidence.length || evidence.some((entry) => !entry.trim())) throw new Error("Supply concrete evidence from independent file/source inspection or executed checks");
    const fileEvidence = artifactPaths.map((file) => {
      if (!path.isAbsolute(file)) throw new Error("Acceptance artifact paths must be absolute");
      const stat = fs.statSync(file); if (!stat.isFile() || !stat.size) throw new Error(`Acceptance artifact missing or empty: ${file}`);
      return `Verified artifact exists: ${file} (${stat.size} bytes)`;
    });
    return this.store.accept(taskId, task.attemptId, note, [...evidence, ...fileEvidence], artifactPaths);
  }
}
function verifiedWorkspace(requested?: string, actual?: string): string | undefined {
  for (const workspace of [requested, actual]) if (workspace && (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory())) throw new Error("workspace must be an existing absolute directory");
  if (requested && actual && fs.realpathSync(requested) !== fs.realpathSync(actual)) throw new Error("Requested workspace does not match the Harness session directory");
  if (requested && !actual) throw new Error("Harness did not verify its workspace; select a session with a known directory");
  return actual ?? requested;
}
function deadline(seconds = 1800) { if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error("timeoutSeconds must be between 1 and 86400"); return new Date(Date.now() + seconds * 1000).toISOString(); }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
export function buildDeepSeekPrompt(task: DeepSeekTask, feedback?: string) {
  return `[CODEX_TASK]\ntask_id: ${task.taskId}\nattempt_id: ${task.attemptId}\n原始目标：\n${task.objective}\n工作目录：${task.workspace ?? "当前绑定会话的目录"}\n约束（每轮持续有效）：\n${task.constraints.map((item) => `- ${item}`).join("\n") || "按目标范围执行"}\n本轮验收要求：\n${task.acceptanceCommands.map((item) => `- ${item}`).join("\n") || "运行相关检查并报告真实结果"}\n${feedback ? `本轮返工反馈：\n${feedback}\n反馈明确修订的结果要求以本轮反馈和验收要求为准，持续约束与允许修改的范围仍然有效。\n` : ""}使用当前 DeepSeek Harness 会话已有的模型、工具和 Skill 完成任务。遇到权限、输入或能力阻碍，如实报告并等待；不要宣称未执行的检查通过。最终简短给出实际产物绝对路径、改动文件、关键命令与结果、剩余问题；详细执行日志已由 Harness 保存，不另建未授权的日志文件。\n最终格式：\nTASK_STATUS: completed | blocked | failed\nARTIFACTS:\nFILES_CHANGED:\nCOMMANDS_RUN:\nTEST_RESULT:\nREMAINING_PROBLEMS:\n[/CODEX_TASK]`;
}
