import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { HubError, requestSchema } from "./contracts.js";
const envelope = z.object({ text: z.string().trim().min(1), json: z.unknown().optional(), artifacts: z.array(z.string()).max(100) }).strict();
export function inside(root, file) { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
export function artifactFor(run, file) {
    if (!path.isAbsolute(file))
        throw new Error("Artifact paths must be absolute");
    const actual = fs.realpathSync(file);
    // The roots were canonicalized at reservation. Re-resolving a replaced root
    // could accidentally authorize a symlink into unrelated local files.
    const roots = [run.workspace, path.dirname(run.resultFile)];
    if (!roots.some(root => inside(root, actual)))
        throw new Error("Artifact escapes the authorized task directories");
    const stat = fs.statSync(actual);
    if (!stat.isFile())
        throw new Error("Artifact is not a regular file");
    return { path: actual, name: path.basename(actual), bytes: stat.size };
}
export function readResult(run) {
    const actual = fs.realpathSync(run.resultFile);
    if (!inside(path.dirname(run.resultFile), actual))
        throw new Error("Result file escapes its allocated directory");
    const stat = fs.statSync(actual);
    if (!stat.isFile() || stat.size > 1_048_576)
        throw new Error("Result must be a regular UTF-8 JSON file no larger than 1 MiB");
    const parsed = envelope.parse(JSON.parse(fs.readFileSync(actual, "utf8")));
    if (run.input.output === "json" && !Object.hasOwn(parsed, "json"))
        throw new Error("Requested JSON result is missing");
    const artifacts = [...new Set(parsed.artifacts)].map(file => artifactFor(run, file));
    if (run.input.output === "artifacts" && !artifacts.length)
        throw new Error("Requested artifact result is empty");
    return { text: parsed.text, ...(Object.hasOwn(parsed, "json") ? { json: parsed.json } : {}), artifacts };
}
function fingerprint(input) { return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
export class HubEngine {
    store;
    directory;
    maxConcurrent;
    providers;
    serial = Promise.resolve();
    constructor(store, providers, directory, maxConcurrent = 1) {
        this.store = store;
        this.directory = directory;
        this.maxConcurrent = maxConcurrent;
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.directory = fs.realpathSync(directory);
        if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
            throw new Error("maxConcurrent must be 1..16");
        this.providers = new Map(providers.map(provider => [provider.id, provider]));
        if (this.providers.size !== providers.length)
            throw new Error("Duplicate provider id");
    }
    exclusive(fn) {
        const next = this.serial.then(fn);
        this.serial = next.catch(() => { });
        return next;
    }
    get(id) { const run = this.store.get(id); if (!run)
        throw new HubError("NOT_FOUND", "Unknown run", 404); return run; }
    provider(id) { const provider = this.providers.get(id); if (!provider)
        throw new HubError("PROVIDER_UNAVAILABLE", `Provider ${id} is not implemented`, 400); return provider; }
    async describeProviders() { return Promise.all([...this.providers.values()].map(async (provider) => ({ id: provider.id, label: provider.label, capabilities: provider.capabilities, ...await provider.health() }))); }
    submit(raw) {
        const input = requestSchema.parse(raw);
        this.provider(input.provider);
        if (input.workspace) {
            if (!path.isAbsolute(input.workspace) || !fs.statSync(input.workspace).isDirectory())
                throw new HubError("INVALID_WORKSPACE", "workspace must be an existing absolute directory");
            input.workspace = fs.realpathSync(input.workspace);
        }
        const hash = fingerprint(input);
        const existing = input.idempotencyKey ? this.store.byKey(input.idempotencyKey, hash) : undefined;
        if (existing)
            return { run: existing, created: false };
        if (this.store.all().filter(run => run.status === "queued").length >= 100)
            throw new HubError("QUEUE_FULL", "Platform queue has 100 pending runs", 429);
        const id = `hub-${crypto.randomUUID()}`;
        const workspace = input.workspace ?? path.join(this.directory, "workspaces", id);
        if (!input.workspace)
            fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
        const resultFile = this.resultFile(id, 1);
        const now = new Date().toISOString();
        return this.store.create({ id, input, workspace, providerTaskId: id, status: "queued", review: "pending", holdsCapacity: false, round: 1, resultFile, usage: { credits: null, source: "unavailable" }, createdAt: now, updatedAt: now, deadline: new Date(Date.now() + input.timeoutSeconds * 1000).toISOString() }, hash);
    }
    resultFile(id, round) {
        const file = path.join(this.directory, "results", id, `round-${round}`, "output.json");
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        return file;
    }
    async synchronize(run) {
        const provider = this.provider(run.input.provider);
        try {
            if (run.status === "cancel_requested")
                await provider.cancel(run);
            const snapshot = await provider.poll(run);
            if (!snapshot || (run.status === "dispatching" && run.round > 1 && snapshot.attemptId === run.previousAttemptId)) {
                this.store.save({ ...run, status: "uncertain", holdsCapacity: true, error: { code: "DISPATCH_UNCERTAIN", message: "A current provider attempt could not be confirmed. Inspect it before any resubmission." } });
                return;
            }
            this.applySnapshot(run, snapshot);
        }
        catch (error) {
            this.store.save({ ...run, lastPollError: error instanceof Error ? error.message : String(error) });
        }
    }
    applySnapshot(run, snapshot) {
        for (const event of snapshot.events)
            this.store.event(run.id, event.type, { text: event.text }, event.key);
        const next = { ...run, status: snapshot.status === "queued" ? "submitted" : snapshot.status, holdsCapacity: snapshot.holdsCapacity, attemptId: snapshot.attemptId, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource, lastPollError: undefined, error: snapshot.error ? { code: "PROVIDER_BLOCKED", message: snapshot.error } : undefined };
        if (run.status === "cancel_requested") {
            next.status = snapshot.holdsCapacity ? "cancel_requested" : "cancelled";
            next.result = undefined;
        }
        else if (snapshot.status === "completed") {
            try {
                next.result = readResult(run);
            }
            catch (error) {
                next.status = "failed";
                next.error = { code: "INVALID_OUTPUT", message: error instanceof Error ? error.message : String(error) };
            }
        }
        if (snapshot.accepted)
            next.review = "accepted";
        this.store.save(next);
    }
    /** One serialized scheduler; start-up never replays dispatching records. */
    tick() {
        return this.exclusive(async () => {
            for (const run of this.store.all()) {
                if (run.status !== "queued" && (run.holdsCapacity || ["dispatching", "submitted", "running", "cancel_requested", "uncertain"].includes(run.status)))
                    await this.synchronize(run);
            }
            for (const candidate of this.store.all().filter(run => run.status === "queued")) {
                if (Date.parse(candidate.deadline) <= Date.now()) {
                    this.store.save({ ...candidate, status: "failed", error: { code: "QUEUE_TIMEOUT", message: "Deadline expired before dispatch; no provider task was submitted" } });
                    continue;
                }
                const occupied = this.store.all().filter(run => run.holdsCapacity);
                if (occupied.length >= this.maxConcurrent || occupied.some(run => run.workspace === candidate.workspace))
                    continue;
                const run = this.store.save({ ...candidate, status: "dispatching", holdsCapacity: true });
                try {
                    if (run.round > 1)
                        await this.provider(run.input.provider).rework(run);
                    else
                        await this.provider(run.input.provider).submit(run);
                    await this.synchronize(run);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (error instanceof HubError && error.code === "DISPATCH_NOT_SENT") {
                        this.store.save({ ...this.get(run.id), status: "failed", holdsCapacity: false, error: { code: error.code, message } });
                        continue;
                    }
                    this.store.save({ ...this.get(run.id), status: "dispatching", lastPollError: message });
                    await this.synchronize(this.get(run.id));
                }
            }
        });
    }
    cancel(id) {
        return this.exclusive(async () => {
            const run = this.get(id);
            if (["completed", "failed", "cancelled"].includes(run.status) && !run.holdsCapacity)
                return run;
            const next = this.store.save({ ...run, status: run.status === "queued" ? "cancelled" : "cancel_requested", holdsCapacity: run.status === "queued" ? false : run.holdsCapacity });
            if (next.status === "cancel_requested")
                await this.synchronize(next);
            return this.get(id);
        });
    }
    rework(id, feedback, model) {
        return this.exclusive(async () => {
            const run = this.get(id);
            if (!feedback.trim())
                throw new HubError("INVALID_FEEDBACK", "Feedback is required");
            if (!run.attemptId || run.holdsCapacity || !["completed", "failed", "blocked"].includes(run.status))
                throw new HubError("RUN_ACTIVE", "Only a confirmed finished provider attempt may be reworked", 409);
            if (model !== undefined && !model.trim())
                throw new HubError('INVALID_MODEL', 'model must be a nonempty native ID');
            return this.store.save({ ...run, input: model === undefined ? run.input : { ...run.input, model: model.trim() }, status: "queued", review: "pending", holdsCapacity: false, round: run.round + 1, previousAttemptId: run.attemptId, feedback, resultFile: this.resultFile(id, run.round + 1), result: undefined, error: undefined, deadline: new Date(Date.now() + run.input.timeoutSeconds * 1000).toISOString() });
        });
    }
    accept(id, input) {
        return this.exclusive(async () => {
            const run = this.get(id);
            if (run.status !== "completed" || run.holdsCapacity)
                throw new HubError("NOT_REVIEWABLE", "A valid finished result is required", 409);
            if (run.review === "accepted")
                return run;
            if (!input.note.trim() || !input.evidence.length || input.evidence.some(item => !item.trim()))
                throw new HubError("EVIDENCE_REQUIRED", "Provide a note and concrete independent verification evidence");
            await this.provider(run.input.provider).accept(run, input);
            this.store.event(id, "review", input);
            return this.store.save({ ...run, review: "accepted" });
        });
    }
}
//# sourceMappingURL=engine.js.map