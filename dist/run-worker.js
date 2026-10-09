import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AcpLiveClient } from "./acp-live.js";
import { loadConfig } from "./config.js";
import { RunJournal, writePrivateJson } from "./run-journal.js";
function safeEventData(value, depth = 0) {
    if (depth > 10)
        return "[depth limit]";
    if (typeof value === "string")
        return value.slice(0, 32_000);
    if (Array.isArray(value))
        return value.slice(0, 100).map((item) => safeEventData(item, depth + 1));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, /password|secret|token|cookie|authorization/i.test(key) ? "[redacted]" : safeEventData(item, depth + 1)]));
    return value;
}
/** A lease protects a desktop conversation from overlapping prompts by this bridge. */
export function acquireSessionLease(root, sessionId, attemptId) {
    const directory = path.join(root, "leases");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${crypto.createHash("sha256").update(sessionId).digest("hex")}.json`);
    for (let retry = 0; retry < 2; retry++) {
        try {
            fs.writeFileSync(file, JSON.stringify({ pid: process.pid, attemptId }), { flag: "wx", mode: 0o600 });
            return () => {
                try {
                    const value = JSON.parse(fs.readFileSync(file, "utf8"));
                    if (value.attemptId === attemptId)
                        fs.unlinkSync(file);
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
                }
            };
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const value = JSON.parse(fs.readFileSync(file, "utf8"));
            let alive = false;
            if (value.pid) {
                try {
                    process.kill(value.pid, 0);
                    alive = true;
                }
                catch { }
            }
            if (alive)
                throw new Error("This WorkBuddy desktop conversation is already executing another bridge task. Wait for that task before continuing.");
            fs.unlinkSync(file);
        }
    }
    throw new Error("Could not reserve the WorkBuddy desktop conversation");
}
export function classifyResult(result) {
    const declared = result.text.match(/TASK_STATUS:\s*(completed|needs_review|blocked|failed|working)/i)?.[1]?.toLowerCase();
    const artifacts = result.artifacts ?? extractArtifacts(result.text);
    if (result.status === "waiting_input" || result.status === "blocked" || declared === "blocked") {
        return { status: "blocked", error: "WorkBuddy needs input or permission. Read the original desktop conversation before continuing.", artifacts };
    }
    if (result.stopReason === "cancelled" || result.status === "cancelled")
        return { status: "cancelled", artifacts };
    if (!result.text.trim())
        return { status: "failed", error: "WorkBuddy returned no final text; completion was not verified.", artifacts };
    if (result.status === "failed" || declared === "failed")
        return { status: "failed", artifacts };
    if (declared === "working" || result.stopReason !== "end_turn") {
        return { status: "blocked", error: `WorkBuddy stopped without completing the turn (${result.stopReason ?? "working"}). Inspect the desktop session.`, artifacts };
    }
    // A transport result only finishes WorkBuddy's turn. Codex still has to inspect evidence.
    return { status: "needs_review", artifacts };
}
function extractArtifacts(text) {
    const section = text.match(/ARTIFACTS:\s*([\s\S]*?)(?=\n[A-Z_]+:|\n\[\/|$)/i)?.[1] ?? "";
    return section.split("\n").map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean).slice(0, 100);
}
export async function runWorker(root, attemptId, config, transport) {
    const journal = new RunJournal(root, attemptId);
    const request = journal.request();
    let snapshot = { attemptId, taskId: request.taskId, status: "queued", pid: process.pid, updatedAt: new Date().toISOString() };
    journal.save(snapshot);
    let releaseLease;
    let boundSession;
    let cancelSent = false;
    const deadline = Date.now() + request.timeoutSeconds * 1000;
    const save = (patch) => { snapshot = { ...snapshot, ...patch }; journal.save(snapshot); };
    const cancellation = setInterval(() => {
        if (journal.cancellationRequested() && boundSession && !cancelSent) {
            cancelSent = true;
            void transport.cancel(boundSession).catch(() => undefined);
        }
    }, 250);
    try {
        if (journal.cancellationRequested())
            throw new Error("Cancelled before WorkBuddy dispatch");
        const result = await transport.run(request.prompt, request.sessionId, request.timeoutSeconds * 1000, {
            workspace: request.workspace, model: request.model, sessionMode: request.sessionMode,
            onSession(endpoint) {
                if (journal.cancellationRequested())
                    throw new Error("Cancelled before WorkBuddy dispatch");
                if (request.sessionId && request.sessionId !== endpoint.sessionId)
                    throw new Error("WorkBuddy session changed; refusing to send rework to another conversation");
                if (endpoint.desktopVisible !== true || endpoint.reconnectable === false)
                    throw new Error("WorkBuddy has not provided a registered, recoverable desktop conversation. Desktop execution is unverified; refusing to dispatch.");
                releaseLease = acquireSessionLease(root, endpoint.sessionId, attemptId);
                boundSession = endpoint.sessionId;
                const runtimeSource = endpoint.runtimeSource ?? "desktop_interactive";
                save({ sessionId: boundSession, runtimeSource, status: "working" });
                journal.append("session", "Bound to the WorkBuddy desktop conversation; dispatching this attempt.", { sessionId: boundSession, runtimeSource, status: "working" });
            },
            onEvent(event) {
                // Keep progress useful without copying credential-bearing transport envelopes.
                const text = event.text ?? event.type;
                journal.append(event.type, text, { status: event.status, sessionId: boundSession, runtimeSource: snapshot.runtimeSource, data: safeEventData(event.data) });
            },
            async onRequest(input) {
                const key = crypto.createHash("sha256").update(`${input.method}:${input.id}`).digest("hex");
                const safeInput = safeEventData({ method: input.method, options: input.params.options, message: input.params.message, requestedSchema: input.params.requestedSchema, questions: input.params.questions, toolCallId: input.params.toolCallId });
                writePrivateJson(path.join(journal.dir, "pending-input.json"), { key, ...safeInput });
                save({ waitingInput: true });
                journal.append("input_request", "WorkBuddy is waiting for a permission decision or form input. Use workbuddy_respond_task or inspect the desktop conversation.", { status: "waiting_input", input: safeInput });
                try {
                    const answerFile = path.join(journal.dir, `input-${key}.json`);
                    while (Date.now() < deadline) {
                        if (journal.cancellationRequested())
                            return input.method === "elicitation/create" ? { action: "cancel" } : { outcome: { outcome: "cancelled" } };
                        if (fs.existsSync(answerFile)) {
                            const answer = JSON.parse(fs.readFileSync(answerFile, "utf8"));
                            if (input.method === "elicitation/create") {
                                if (answer.decision === "submit")
                                    return { action: "accept", content: answer.content ?? {} };
                                if (answer.decision === "cancel")
                                    return { action: "cancel" };
                                throw new Error("This WorkBuddy form requires submit or cancel");
                            }
                            if (input.method === "_codebuddy.ai/question") {
                                if (answer.decision === "submit")
                                    return { outcome: { outcome: "submitted", data: answer.content ?? {} } };
                                if (answer.decision === "cancel")
                                    return { outcome: { outcome: "cancelled" } };
                                throw new Error("This WorkBuddy question requires submit or cancel");
                            }
                            if (answer.decision === "cancel")
                                return { outcome: { outcome: "cancelled" } };
                            const options = Array.isArray(input.params.options) ? input.params.options : [];
                            const selected = options.find((option) => option.kind === answer.decision && typeof option.optionId === "string");
                            if (!selected || !["allow_once", "reject_once"].includes(answer.decision))
                                throw new Error("Requested permission choice was not offered by WorkBuddy");
                            return { outcome: { outcome: "selected", optionId: selected.optionId } };
                        }
                        await new Promise((resolve) => setTimeout(resolve, 250));
                    }
                    throw new Error("WorkBuddy input request timed out. Inspect its desktop conversation before continuing.");
                }
                finally {
                    save({ waitingInput: false });
                    fs.rmSync(path.join(journal.dir, "pending-input.json"), { force: true });
                    journal.append("status", "WorkBuddy input wait ended.", { status: "working" });
                }
            },
        });
        if (!boundSession)
            throw new Error("Transport returned a result without a verified desktop session binding");
        const outcome = cancelSent ? { status: "cancelled", artifacts: result.artifacts ?? [] } : classifyResult(result);
        save({ ...outcome, text: result.text, stopReason: result.stopReason });
        journal.append("result", `${result.text}${outcome.error ? `\nBRIDGE_NOTE: ${outcome.error}` : ""}`, { status: outcome.status, stopReason: result.stopReason, artifacts: outcome.artifacts, blockedReason: outcome.error, sessionId: boundSession, runtimeSource: snapshot.runtimeSource });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // An interrupted transport can leave WorkBuddy running. Do not resubmit automatically.
        const status = journal.cancellationRequested() ? "cancelled" : "blocked";
        save({ status, error: message });
        journal.append("result", `TASK_STATUS: ${status}\n${message}\nInspect the original WorkBuddy conversation before retrying; no automatic resend occurred.`, { status, blockedReason: message, sessionId: boundSession, runtimeSource: snapshot.runtimeSource });
    }
    finally {
        clearInterval(cancellation);
        releaseLease?.();
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [root, attemptId] = process.argv.slice(2);
    if (!root || !attemptId)
        throw new Error("Worker requires a journal directory and attempt identity");
    const config = loadConfig();
    await runWorker(root, attemptId, config, new AcpLiveClient(config, config.acpPermissionMode));
}
//# sourceMappingURL=run-worker.js.map