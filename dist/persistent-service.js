import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DesktopQueue } from "./desktop-queue.js";
import { readDesktopSession } from "./desktop-runtime.js";
import { RunJournal, runsDirectory, writePrivateJson } from "./run-journal.js";
export function serviceRegistrationPath(projectDir) {
    return path.join(projectDir, "data", "persistent-service.json");
}
export function readServiceRegistration(file) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    validateServiceRegistration(value);
    return value;
}
export function validateServiceRegistration(value) {
    if (value.version !== 1 || typeof value.sessionId !== "string" || !value.sessionId.trim())
        throw new Error("Invalid persistent worker registration");
    for (const field of ["workspace", "projectDir", "nodeBin", "dbFile", "runsDir", "workbuddyConfigDir", "cliElectronPath"]) {
        if (typeof value[field] !== "string" || !path.isAbsolute(value[field]))
            throw new Error(`Persistent worker ${field} must be an absolute path`);
    }
    if (!Number.isInteger(value.cdpPort) || value.cdpPort < 1 || value.cdpPort > 65535)
        throw new Error("cdpPort must be between 1 and 65535");
    if (value.intervalMs !== undefined && (!Number.isInteger(value.intervalMs) || value.intervalMs < 500 || value.intervalMs > 60_000))
        throw new Error("intervalMs must be between 500 and 60000");
}
export function registeredServiceConfig(config, registration) {
    validateServiceRegistration(registration);
    return { ...config, backend: "desktop-queue", dbFile: registration.dbFile, runsDir: registration.runsDir, workbuddyConfigDir: registration.workbuddyConfigDir, cliElectronPath: registration.cliElectronPath };
}
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
function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function sessionKey(sessionId) { return crypto.createHash("sha256").update(sessionId).digest("hex"); }
function writeWakeIntent(file, intent) {
    writePrivateJson(file, intent);
    // Force the intent and renamed directory entry to stable storage before native
    // submission. A machine restart must not erase our evidence of possible delivery.
    const fd = fs.openSync(file, "r");
    try {
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    const directory = fs.openSync(path.dirname(file), "r");
    try {
        fs.fsyncSync(directory);
    }
    finally {
        fs.closeSync(directory);
    }
}
/** SQLite CAS avoids two recovering daemons reclaiming the same stale file lock. */
class ServicePumpLock {
    sessionId;
    db;
    owner = crypto.randomUUID();
    acquired = false;
    constructor(root, sessionId) {
        this.sessionId = sessionId;
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const file = path.join(root, "persistent-service.sqlite");
        this.db = new DatabaseSync(file);
        fs.chmodSync(file, 0o600);
        this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pump_locks(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL)");
    }
    acquire() {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.db.prepare("SELECT pid FROM pump_locks WHERE session_id=?").get(this.sessionId);
            if (current && alive(current.pid)) {
                this.db.exec("COMMIT");
                return false;
            }
            this.db.prepare("DELETE FROM pump_locks WHERE session_id=?").run(this.sessionId);
            this.db.prepare("INSERT INTO pump_locks VALUES(?, ?, ?)").run(this.sessionId, this.owner, process.pid);
            this.db.exec("COMMIT");
            this.acquired = true;
            return true;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    close() {
        try {
            if (this.acquired)
                this.db.prepare("DELETE FROM pump_locks WHERE session_id=? AND owner=?").run(this.sessionId, this.owner);
        }
        finally {
            this.db.close();
        }
    }
}
export class PersistentDesktopService {
    registration;
    trigger;
    store;
    config;
    root;
    constructor(config, registration, trigger, store) {
        this.registration = registration;
        this.trigger = trigger;
        this.store = store;
        this.config = registeredServiceConfig(config, registration);
        this.root = runsDirectory(this.config);
    }
    async pump() {
        const lock = new ServicePumpLock(this.root, this.registration.sessionId);
        try {
            if (!lock.acquire())
                return this.result("session_busy", { reason: "Another service pump owns this desktop session" });
            return await this.pumpLocked();
        }
        catch (error) {
            return this.result("unavailable", { reason: error instanceof Error ? error.message : String(error) });
        }
        finally {
            lock.close();
        }
    }
    result(status, extra = {}) {
        return { status, sessionId: this.registration.sessionId, ...extra };
    }
    candidates() {
        const tasks = [];
        for (let offset = 0;; offset += 500) {
            const page = this.store.listTasks({ states: ["queued", "working", "blocked"], limit: 500, offset });
            tasks.push(...page);
            if (page.length < 500)
                break;
        }
        return tasks.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.taskId.localeCompare(b.taskId)).flatMap((task) => {
            if (!task.attemptId || (task.sessionId && task.sessionId !== this.registration.sessionId))
                return [];
            const journal = new RunJournal(this.root, task.attemptId);
            const snapshot = journal.snapshot();
            if (snapshot?.driver !== "desktop-queue" || snapshot.sessionId !== this.registration.sessionId || snapshot.status !== "queued" || journal.cancellationRequested())
                return [];
            // A claim followed by an incomplete state write is uncertain, not a fresh task.
            if (fs.existsSync(path.join(journal.dir, "claim.json")))
                return [];
            return [{ task, journal }];
        });
    }
    unresolvedLease() {
        const active = readJson(path.join(this.root, "queue-session-locks", `${sessionKey(this.registration.sessionId)}.active.json`));
        if (active) {
            const journal = new RunJournal(this.root, active.attemptId);
            const snapshot = journal.snapshot();
            if (!snapshot || snapshot.status === "working" || (fs.existsSync(path.join(journal.dir, "claim.json")) && !snapshot.stopReason))
                return true;
        }
        if (!fs.existsSync(this.root))
            return false;
        for (const name of fs.readdirSync(this.root)) {
            if (!/^run-[a-f0-9-]{36}$/.test(name))
                continue;
            const journal = new RunJournal(this.root, name);
            const snapshot = journal.snapshot();
            if (snapshot?.driver === "desktop-queue" && snapshot.sessionId === this.registration.sessionId && (snapshot.status === "working" || (fs.existsSync(path.join(journal.dir, "claim.json")) && !snapshot.stopReason)))
                return true;
        }
        return false;
    }
    async pumpLocked() {
        const candidate = this.candidates()[0];
        if (!candidate)
            return this.result("no_task");
        const { task, journal } = candidate;
        const identity = { attemptId: journal.attemptId };
        const snapshot = journal.snapshot();
        if (snapshot.deadline && Date.parse(snapshot.deadline) <= Date.now())
            return this.result("deadline_passed", identity);
        if (this.unresolvedLease())
            return this.result("active_lease", identity);
        if (new DesktopQueue(this.config).listeners().some((listener) => listener.sessionId === this.registration.sessionId))
            return this.result("listener_ready", identity);
        const evidence = readDesktopSession(this.config.workbuddyConfigDir, this.registration.sessionId);
        if (!evidence.registered)
            return this.result("unavailable", { ...identity, reason: evidence.reason });
        const request = journal.request();
        if (request.sessionId !== this.registration.sessionId || (request.workspace && path.resolve(request.workspace) !== this.registration.workspace) || (task.workspace && path.resolve(task.workspace) !== this.registration.workspace) || (evidence.cwd && path.resolve(evidence.cwd) !== this.registration.workspace)) {
            return this.result("binding_mismatch", { ...identity, reason: "The registered workspace or session no longer matches the queued task" });
        }
        const intentFile = path.join(journal.dir, "wake.json");
        const previous = readJson(intentFile);
        if (previous && (previous.sessionId !== this.registration.sessionId || previous.attemptId !== journal.attemptId))
            throw new Error("Wake intent identity does not match its queue attempt");
        if (previous && previous.state !== "rejected") {
            if (previous.state === "submitted")
                return this.result("wake_pending", { ...identity, wakeId: previous.wakeId });
            if (this.trigger.findWake) {
                try {
                    if (await this.trigger.findWake(this.registration.sessionId, previous.wakeId)) {
                        writeWakeIntent(intentFile, { ...previous, state: "submitted", updatedAt: new Date().toISOString() });
                        return this.result("wake_pending", { ...identity, wakeId: previous.wakeId });
                    }
                }
                catch { /* An unavailable lookup must not cause replay of an ambiguous submission. */ }
            }
            return this.result("wake_uncertain", { ...identity, wakeId: previous.wakeId, reason: previous.error ?? "Native wake submission has not been confirmed; inspect the original desktop conversation before retrying" });
        }
        const native = await this.trigger.inspect(this.registration.sessionId);
        if (native.state === "offline")
            return this.result("unavailable", { ...identity, reason: native.reason });
        if (native.state !== "idle")
            return this.result("session_busy", { ...identity, reason: native.reason ?? native.state });
        if (native.workspace && path.resolve(native.workspace) !== this.registration.workspace)
            return this.result("binding_mismatch", { ...identity, reason: "Native desktop workspace differs from the registered worker" });
        // Recheck after awaiting the native API. A native listener may have appeared meanwhile.
        if (journal.snapshot()?.status !== "queued" || journal.cancellationRequested() || this.unresolvedLease())
            return this.result("active_lease", identity);
        if (new DesktopQueue(this.config).listeners().some((listener) => listener.sessionId === this.registration.sessionId))
            return this.result("listener_ready", identity);
        const now = new Date().toISOString();
        const intent = { version: 1, sessionId: this.registration.sessionId, attemptId: journal.attemptId, wakeId: previous?.wakeId ?? `wake-${journal.attemptId}`, state: "submitting", createdAt: previous?.createdAt ?? now, updatedAt: now };
        // Persist before submission. A crash after this point is resolved by receipt lookup,
        // never by replaying an uncertain native prompt.
        writeWakeIntent(intentFile, intent);
        const prompt = `[CODEX_QUEUE_WAKE ${intent.wakeId}]\n${new DesktopQueue(this.config).prepare(this.registration.sessionId, false, true).prompt}`;
        try {
            const response = await this.trigger.wakeIdle(this.registration.sessionId, intent.wakeId, prompt);
            writeWakeIntent(intentFile, { ...intent, state: response.accepted ? "submitted" : "rejected", receipt: response.receipt, updatedAt: new Date().toISOString() });
            return this.result(response.accepted ? "wake_submitted" : "wake_rejected", { ...identity, wakeId: intent.wakeId });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            writeWakeIntent(intentFile, { ...intent, state: "uncertain", error: reason, updatedAt: new Date().toISOString() });
            return this.result("wake_uncertain", { ...identity, wakeId: intent.wakeId, reason });
        }
    }
}
//# sourceMappingURL=persistent-service.js.map