import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDesktopSession } from "./desktop-runtime.js";
import { DurableRuns, RunJournal, runsDirectory, writePrivateJson } from "./run-journal.js";
import { TaskStore } from "./task-store.js";
const SOURCE = "desktop_queue";
const TERMINAL = new Set(["needs_review", "blocked", "failed", "cancelled"]);
/** Prove the helper was launched by the native desktop app, not a standalone CLI or Codex. */
export function assertDesktopCaller(config) {
    let pid = process.ppid;
    const executable = path.resolve(config.cliElectronPath);
    for (let step = 0; pid > 1 && step < 30; step++) {
        const parentText = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 2000 }).trim();
        const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 }).trim();
        // The native application root has no script argument; daemon/CLI child
        // processes using Electron must continue walking to the application root.
        if (command === executable || command.startsWith(`${executable} --`)) {
            if (!/--type=|--stdio|cli\/bin|sidecar-entry|daemon-app-server/.test(command))
                return { desktopPid: pid };
        }
        const parent = Number(parentText);
        if (!Number.isInteger(parent) || parent <= 0 || parent === pid)
            break;
        pid = parent;
    }
    throw new Error("This worker helper must be called from the real WorkBuddy desktop conversation. Standalone CLI and Codex-side execution cannot report WorkBuddy results.");
}
function alive(pid) { try {
    process.kill(pid, 0);
    return true;
}
catch {
    return false;
} }
function key(sessionId) { return crypto.createHash("sha256").update(sessionId).digest("hex"); }
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function locked(file, action) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let fd;
    try {
        fd = fs.openSync(file, "wx", 0o600);
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        const owner = readJson(file);
        if (!owner || alive(owner.pid))
            throw new Error("Queue record is busy; retry this call without resending the task");
        fs.unlinkSync(file);
        fd = fs.openSync(file, "wx", 0o600);
    }
    try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid }));
        return action();
    }
    finally {
        fs.closeSync(fd);
        fs.rmSync(file, { force: true });
    }
}
export class DesktopQueue {
    config;
    verifyActor;
    root;
    listenersDir;
    constructor(config, verifyActor = () => assertDesktopCaller(config)) {
        this.config = config;
        this.verifyActor = verifyActor;
        this.root = runsDirectory(config);
        this.listenersDir = path.join(this.root, "desktop-listeners");
    }
    prepare(sessionId, persistent = false, wakeOnce = false) {
        const evidence = readDesktopSession(this.config.workbuddyConfigDir, sessionId);
        if (!evidence.registered)
            throw new Error(evidence.reason ?? "Desktop session unregistered");
        const helper = fileURLToPath(new URL("../bin/workbuddy-worker", import.meta.url));
        const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
        if (persistent) {
            if (!evidence.cwd || !path.isAbsolute(evidence.cwd))
                throw new Error("Persistent setup needs the native session's absolute workspace");
            const service = fileURLToPath(new URL("../bin/workbuddy-service", import.meta.url));
            return { sessionId, workspace: evidence.cwd, started: false, mode: "persistent", prompt: `请一次性配置本桌面会话为 Codex 的常驻执行会话。会话 ID：${sessionId}。用户授权安装本机服务，并在需要启用原生接口时、其他任务结束后自动重启 WorkBuddy 一次。\n请用你自己的 Bash 工具执行：\n${quote(service)} install --session-id ${quote(sessionId)} --workspace ${quote(evidence.cwd)} --cdp-port 18491\n安装完成只回报安装状态或真实错误，结束当前回复。不要启动无限 claim，不改桥接器源码，不写其他成果或记忆，不改变权限设置。服务会保存会话绑定、按真实队列自动唤起本会话，退出和重开后无需再次粘贴。安装成功不等于任务通过；后续仍需实际领取、产物和验收证明。需要登录或原生权限时如实说明。` };
        }
        const waiting = wakeOnce ? "关键：本次由常驻服务按任务唤起。完成 report 后只再运行一次 claim --wait-seconds 0；若有任务则实际执行并报告，若 status=retry 则结束本轮。不要循环空等；新任务和后续返工由常驻服务自动重新唤起，无需用户粘贴。" : "关键：回报之后不要结束当前轮次，立即再次运行 claim，等待 Codex 的检查和返工任务；下一任务必须按新的 attemptId 和 leaseToken 执行。status=retry 表示暂时没有任务，最多连续重试 4 次（每次最多 50 秒）；领取任务后重置空等计数。连续四次空等后结束并明确说明监听已停止，需要重新启动。长命令若转后台，等待该命令输出后再决定下一步，不要并行启动多个 claim。";
        return { sessionId, workspace: evidence.cwd, started: false, prompt: `请将本桌面会话用作 Codex 任务队列的执行会话。会话 ID：${sessionId}。这是启动监听，具体工作只按领取到的任务执行。\n使用你自己的 Bash 工具执行下面的本机命令（不能由 Codex 代执行）：\n${quote(helper)} claim --session-id ${quote(sessionId)} --wait-seconds 50\n若返回 status=task，读取完整 prompt，遵守目标、约束和验收要求，用 WorkBuddy 本会话自己的工具实际执行。保留返回的 attemptId、sessionId、leaseToken，不要猜测或复用旧轮次。完成后通过同一个 helper 的 report 命令回报：--session-id、--attempt-id、--lease-token 必须使用本轮值；--status 使用 completed、blocked 或 failed；--text 写实际结果（包括 TASK_STATUS、FILES_CHANGED、COMMANDS_RUN、TEST_RESULT、REMAINING_PROBLEMS）；--artifacts 使用真实绝对路径组成的 JSON 数组。命令参数用安全的 shell 引号。空报告、只有计划或没有实际产物不能报 completed。可用 progress 命令（相同身份参数和 --text）上报进度并检查 cancellationRequested；取消时停止当前任务并如实 report。\n${waiting}\n不要为了领取任务而修改本桥接器实现、WorkBuddy 数据库或安全设置；不要提取账号凭据。遇到权限或输入请求遵守 WorkBuddy 桌面现有设置，需要人操作则明确说明。helper 只传递任务和回报，不替你制作成果。` };
    }
    listeners() {
        if (!fs.existsSync(this.listenersDir))
            return [];
        return fs.readdirSync(this.listenersDir).filter((name) => name.endsWith(".json")).flatMap((name) => {
            const value = readJson(path.join(this.listenersDir, name));
            if (!value || !value.waiting || !alive(value.pid) || !alive(value.desktopPid) || Date.now() - Date.parse(value.updatedAt) > 70_000)
                return [];
            const evidence = readDesktopSession(this.config.workbuddyConfigDir, value.sessionId);
            return evidence.registered ? [{ sessionId: value.sessionId, workspace: evidence.cwd, ready: true, source: SOURCE }] : [];
        });
    }
    start(request) {
        if (request.sessionMode === "new")
            throw new Error("The queue route needs a dedicated native desktop worker conversation; it does not create one through a private API");
        const listeners = this.listeners();
        const sessionId = request.sessionId ?? (listeners.length === 1 ? listeners[0].sessionId : undefined);
        if (!sessionId)
            throw new Error("Specify a WorkBuddy worker sessionId, or start exactly one desktop queue listener first");
        const evidence = readDesktopSession(this.config.workbuddyConfigDir, sessionId);
        if (!evidence.registered)
            throw new Error(evidence.reason ?? "WorkBuddy desktop session is unregistered");
        if (request.workspace && evidence.cwd && path.resolve(request.workspace) !== path.resolve(evidence.cwd))
            throw new Error("The task workspace differs from the dedicated desktop worker session");
        if (request.model)
            throw new Error("Queue tasks use the model selected in the WorkBuddy desktop conversation. Select and verify the model there; queue dispatch cannot switch it remotely.");
        const journal = new RunJournal(this.root, request.attemptId);
        fs.mkdirSync(journal.dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(journal.dir, "request.json"), JSON.stringify({ ...request, sessionId }), { flag: "wx", mode: 0o600 });
        journal.save({ attemptId: request.attemptId, taskId: request.taskId, sessionId, driver: "desktop-queue", status: "queued", deadline: new Date(Date.now() + request.timeoutSeconds * 1000).toISOString(), updatedAt: new Date().toISOString() });
        journal.append("status", "Task queued for the specified native WorkBuddy desktop worker; waiting for its claim.", { status: "queued", sessionId });
    }
    async claim(sessionId, waitSeconds = 50) {
        const actor = this.verifyActor();
        const evidence = readDesktopSession(this.config.workbuddyConfigDir, sessionId);
        if (!evidence.registered)
            throw new Error(evidence.reason ?? "Desktop session unregistered");
        const listenerFile = path.join(this.listenersDir, `${key(sessionId)}.json`);
        const writeListener = (waiting) => writePrivateJson(listenerFile, { sessionId, pid: process.pid, desktopPid: actor.desktopPid, waiting, updatedAt: new Date().toISOString() });
        const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 55) * 1000;
        writeListener(true);
        const store = new TaskStore(this.config.dbFile);
        try {
            do {
                writeListener(true);
                for (const task of store.listTasks({ states: ["queued", "working", "blocked"], limit: 100 })) {
                    if (!task.attemptId || (task.sessionId && task.sessionId !== sessionId))
                        continue;
                    const journal = new RunJournal(this.root, task.attemptId);
                    const snapshot = journal.snapshot();
                    if (!snapshot || snapshot.driver !== "desktop-queue" || snapshot.status !== "queued" || snapshot.sessionId !== sessionId || journal.cancellationRequested())
                        continue;
                    const request = journal.request();
                    const claimed = locked(path.join(this.root, "queue-session-locks", `${key(sessionId)}.lock`), () => {
                        const bindingFile = path.join(this.root, "queue-session-locks", `${key(sessionId)}.active.json`);
                        const active = readJson(bindingFile);
                        if (active) {
                            const previous = new RunJournal(this.root, active.attemptId).snapshot();
                            if (previous && (!TERMINAL.has(previous.status) || (previous.status === "blocked" && !previous.stopReason && fs.existsSync(path.join(this.root, active.attemptId, "claim.json")))))
                                throw new Error("The desktop conversation already has an unfinished queue task; report or verify it stopped before claiming another");
                        }
                        return locked(path.join(journal.dir, "queue-write.lock"), () => {
                            const current = journal.snapshot();
                            if (current.status !== "queued")
                                return undefined;
                            if (current.deadline && Date.parse(current.deadline) <= Date.now()) {
                                this.expire(journal, current);
                                return undefined;
                            }
                            const leaseToken = crypto.randomBytes(24).toString("hex");
                            writePrivateJson(path.join(journal.dir, "claim.json"), { sessionId, leaseHash: key(leaseToken), desktopPid: actor.desktopPid, claimedAt: new Date().toISOString() });
                            writePrivateJson(bindingFile, { attemptId: task.attemptId });
                            journal.save({ ...current, status: "working", pid: actor.desktopPid, runtimeSource: SOURCE });
                            journal.append("session", "The verified native WorkBuddy desktop conversation claimed this task.", { status: "working", sessionId, runtimeSource: SOURCE });
                            return { status: "task", taskId: task.taskId, attemptId: task.attemptId, sessionId, leaseToken, prompt: request.prompt, workspace: request.workspace, deadline: current.deadline };
                        });
                    });
                    if (claimed)
                        return claimed;
                }
                if (Date.now() < deadline)
                    await new Promise((resolve) => setTimeout(resolve, 250));
            } while (Date.now() < deadline);
            return { status: "retry", message: "No task is available yet. If the operator asked you to stay available, call claim again. Do not fabricate a task or an outcome." };
        }
        finally {
            store.close();
            writeListener(false);
        }
    }
    progress(input) {
        const actor = this.verifyActor();
        return this.mutateClaim(input, actor, (journal, snapshot) => {
            journal.append("progress", input.text.slice(0, 32_000), { status: "working", sessionId: input.sessionId, runtimeSource: SOURCE });
            journal.save(snapshot);
            return { ok: true, cancellationRequested: journal.cancellationRequested() };
        });
    }
    report(input) {
        const actor = this.verifyActor();
        return this.mutateClaim(input, actor, (journal, snapshot) => {
            if (!input.text.trim())
                throw new Error("A real WorkBuddy result is required; an empty report cannot complete a task");
            const status = journal.cancellationRequested() ? "cancelled" : input.status === "completed" ? "needs_review" : input.status;
            journal.save({ ...snapshot, status, text: input.text, stopReason: input.status === "completed" ? "end_turn" : input.status, artifacts: input.artifacts });
            journal.append("result", input.text.slice(0, 1_000_000), { status, artifacts: input.artifacts, sessionId: input.sessionId, runtimeSource: SOURCE, stopReason: input.status === "completed" ? "end_turn" : input.status });
            return { ok: true, status };
        });
    }
    mutateClaim(input, actor, action) {
        const journal = new RunJournal(this.root, input.attemptId);
        return locked(path.join(journal.dir, "queue-write.lock"), () => {
            const claim = readJson(path.join(journal.dir, "claim.json"));
            if (!claim || claim.sessionId !== input.sessionId || claim.desktopPid !== actor.desktopPid || claim.leaseHash !== key(input.leaseToken))
                throw new Error("Report does not belong to this verified desktop session and execution lease");
            const snapshot = journal.snapshot();
            if (!snapshot || snapshot.status !== "working")
                throw new Error("This execution attempt is no longer active; old or repeated reports are rejected");
            if (!readDesktopSession(this.config.workbuddyConfigDir, input.sessionId).registered)
                throw new Error("WorkBuddy desktop registration disappeared");
            return action(journal, snapshot);
        });
    }
    messages(cursor, limit = 100) {
        const attemptId = cursor.split(":")[0];
        if (!/^run-[a-f0-9-]{36}$/.test(attemptId))
            return new DurableRuns(this.config).messages(cursor, limit);
        const journal = new RunJournal(this.root, attemptId);
        const snapshot = journal.snapshot();
        if (snapshot?.driver === "desktop-queue" && !TERMINAL.has(snapshot.status)) {
            locked(path.join(journal.dir, "queue-write.lock"), () => {
                const current = journal.snapshot();
                if (!TERMINAL.has(current.status) && current.deadline && Date.parse(current.deadline) <= Date.now())
                    this.expire(journal, current);
            });
        }
        return new DurableRuns(this.config).messages(cursor, limit);
    }
    expire(journal, snapshot) {
        const error = "The desktop queue task deadline passed without a verified result. Inspect the original WorkBuddy conversation before rework; no automatic resend occurred.";
        journal.save({ ...snapshot, status: "blocked", error });
        journal.append("result", `TASK_STATUS: blocked\n${error}`, { status: "blocked", blockedReason: error, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource });
    }
}
//# sourceMappingURL=desktop-queue.js.map