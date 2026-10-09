import fs from "node:fs";
import path from "node:path";
import { readDesktopSession, waitForDesktopSession } from "./desktop-runtime.js";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_SESSION_FILE_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_FRAME_CHARS = 4_000_000;
class WaitingForInput extends Error {
    request;
    constructor(request) {
        super("WorkBuddy needs an explicit response before it can continue");
        this.request = request;
    }
}
class PreDispatchSessionMissing extends Error {
}
export class AcpRpcError extends Error {
    method;
    code;
    constructor(value, method) {
        const error = asRecord(value);
        super(typeof error.message === "string" ? error.message : `WorkBuddy ACP ${method} returned a protocol error`);
        this.method = method;
        this.code = typeof error.code === "number" ? error.code : undefined;
    }
}
/** Uses an exact, desktop-registered ACP conversation; never starts an independent CLI fallback. */
export class AcpLiveClient {
    config;
    permissionMode;
    fetchImpl;
    credentials;
    connectedEndpoint;
    activeController;
    aborted = false;
    nextId = 1;
    constructor(config, permissionMode = "deny", fetchImpl = globalThis.fetch) {
        this.config = config;
        this.permissionMode = permissionMode;
        this.fetchImpl = fetchImpl;
    }
    static listSessions(config) {
        const sessionsDir = path.join(config.workbuddyConfigDir, "sessions");
        let files;
        try {
            files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".json"));
        }
        catch {
            return [];
        }
        const candidates = [];
        const now = Date.now();
        for (const name of files) {
            const filename = path.join(sessionsDir, name);
            try {
                const stat = fs.statSync(filename);
                if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES)
                    continue;
                const value = JSON.parse(fs.readFileSync(filename, "utf8"));
                if (value.kind !== "interactive")
                    continue;
                const { pid, sessionId } = value;
                const endpoint = value.endpoint ?? value.url;
                const heartbeat = Number(value.lastHeartbeat ?? value.updatedAt);
                if (!Number.isInteger(pid) || Number(pid) <= 0 || typeof sessionId !== "string" || !sessionId.trim())
                    continue;
                if (typeof endpoint !== "string" || !Number.isFinite(heartbeat) || heartbeat <= 0 || Math.abs(now - heartbeat) > 120_000)
                    continue;
                const baseUrl = validateLoopbackUrl(endpoint);
                try {
                    process.kill(Number(pid), 0);
                }
                catch {
                    continue;
                }
                const evidence = readDesktopSession(config.workbuddyConfigDir, sessionId);
                candidates.push({
                    baseUrl, pid: Number(pid), sessionId, sessionFile: filename,
                    cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : undefined,
                    runtimeSource: "desktop_interactive", desktopVisible: evidence.registered,
                    isPlayground: evidence.isPlayground, sessionCwd: evidence.cwd, registrationReason: evidence.reason,
                    workspaceBinding: evidence.cwd ? "native_cwd" : "absolute_paths",
                    reconnectable: true,
                });
            }
            catch { /* Incomplete and stale registry rows are not usable endpoints. */ }
        }
        return candidates;
    }
    static discover(config, requestedSessionId) {
        const candidates = AcpLiveClient.listSessions(config).filter((endpoint) => !requestedSessionId || endpoint.sessionId === requestedSessionId);
        if (!candidates.length)
            throw new Error(requestedSessionId
                ? "The bound WorkBuddy desktop conversation is offline. Open that same conversation and retry; the bridge will not switch to another one."
                : "No live WorkBuddy interactive conversation was found. Open a dedicated conversation in WorkBuddy and retry.");
        if (candidates.length > 1)
            throw new Error("Multiple WorkBuddy interactive conversations are available. Supply the dedicated sessionId; the bridge will not guess the latest conversation.");
        return candidates[0];
    }
    async health(sessionId) {
        const endpoint = AcpLiveClient.discover(this.config, sessionId);
        await this.connect(endpoint);
        await this.close();
        return { endpoint, online: true, ready: endpoint.desktopVisible === true, reason: endpoint.registrationReason };
    }
    async run(prompt, sessionId, timeoutMs = 300_000, options = {}) {
        if (!prompt.trim())
            throw new Error("WorkBuddy ACP prompt cannot be empty");
        if (sessionId && options.sessionMode === "new")
            throw new Error("A bound sessionId cannot be combined with new-session mode");
        let endpoint = AcpLiveClient.discover(this.config, sessionId);
        if (!endpoint.desktopVisible)
            throw new Error(endpoint.registrationReason ?? "WorkBuddy desktop registration was not verified");
        const workspace = options.workspace ? path.resolve(options.workspace) : undefined;
        if (options.sessionMode !== "new" && workspace && endpoint.sessionCwd && path.resolve(endpoint.sessionCwd) !== workspace) {
            throw new Error("The requested workspace differs from the bound WorkBuddy conversation. Open a dedicated conversation for that workspace and provide its sessionId.");
        }
        if (workspace && !fs.statSync(workspace).isDirectory())
            throw new Error("WorkBuddy workspace must be an existing directory");
        try {
            await this.connect(endpoint);
            const initialized = await this.rpc(endpoint, "initialize", {
                protocolVersion: 1,
                clientInfo: { name: "codex-workbuddy-gateway", version: "0.2.0" },
                clientCapabilities: {},
            }, 30_000);
            if (typeof initialized?.connectionId === "string")
                this.credentials.connectionId = initialized.connectionId;
            if (options.sessionMode === "new") {
                const newCwd = workspace ?? endpoint.sessionCwd ?? endpoint.cwd ?? "";
                const isPlayground = !newCwd;
                const created = await this.rpc(endpoint, "session/new", {
                    cwd: newCwd, mcpServers: [], _meta: { "codebuddy.ai": { welcomeMode: isPlayground ? "working" : "coding", isPlayground } },
                }, 60_000);
                if (typeof created?.sessionId !== "string" || !created.sessionId)
                    throw new Error("WorkBuddy did not return a new conversation ID");
                const evidence = await waitForDesktopSession(this.config.workbuddyConfigDir, created.sessionId);
                const reconnectable = AcpLiveClient.listSessions(this.config).some((candidate) => candidate.sessionId === created.sessionId && candidate.baseUrl === endpoint.baseUrl && candidate.pid === endpoint.pid);
                endpoint = { ...endpoint, sessionId: created.sessionId, desktopVisible: evidence.registered, isPlayground: evidence.isPlayground, sessionCwd: evidence.cwd, registrationReason: evidence.reason, workspaceBinding: evidence.cwd ? "native_cwd" : "absolute_paths", reconnectable };
                this.connectedEndpoint = endpoint;
                await options.onSession?.(endpoint);
                if (!evidence.registered)
                    return { text: "", status: "blocked", sessionId: endpoint.sessionId, error: "WorkBuddy created an ACP session but did not register it as a desktop conversation. No task was dispatched. Open a dedicated desktop conversation and bind its sessionId." };
                if (!reconnectable)
                    return { text: "", status: "blocked", sessionId: endpoint.sessionId, error: "WorkBuddy registered the new conversation but its exact interactive runtime is not discoverable for continuation. No task was dispatched. Open this conversation in WorkBuddy before binding it." };
                if (workspace && evidence.cwd && path.resolve(evidence.cwd) !== workspace)
                    throw new Error("WorkBuddy registered the new conversation with a different workspace; no task was dispatched");
            }
            // This callback must succeed before dispatch: the worker stores the exact
            // session and acquires a lease before mutating any shared model setting.
            if (options.sessionMode !== "new")
                await options.onSession?.(endpoint);
            if (options.model)
                await this.rpc(endpoint, "session/set_model", { sessionId: endpoint.sessionId, modelId: options.model }, 30_000);
            const actualPrompt = workspace && !endpoint.sessionCwd ? `工作目录（所有文件操作请使用此绝对路径）：${workspace}\n\n${prompt}` : prompt;
            try {
                return await this.prompt(endpoint, actualPrompt, timeoutMs, options);
            }
            catch (error) {
                // Load only the same registered idle/prewarmed session. An explicit
                // pre-dispatch Session not found error is the only replay condition.
                if (!(error instanceof PreDispatchSessionMissing))
                    throw error;
                const loaded = await this.rpc(endpoint, "session/load", {
                    sessionId: endpoint.sessionId, cwd: endpoint.sessionCwd ?? endpoint.cwd ?? "", mcpServers: [],
                    _meta: { "codebuddy.ai": { welcomeMode: endpoint.isPlayground ? "working" : "coding", isPlayground: endpoint.isPlayground === true } },
                }, 60_000);
                if (typeof loaded?.sessionId === "string" && loaded.sessionId !== endpoint.sessionId)
                    throw new Error("WorkBuddy loaded a different conversation; the task was not replayed");
                return await this.prompt(endpoint, actualPrompt, timeoutMs, options);
            }
        }
        finally {
            await this.close();
        }
    }
    async cancel(sessionId) {
        if (this.connectedEndpoint && this.connectedEndpoint.sessionId !== sessionId)
            throw new Error("Cancellation target differs from the bound WorkBuddy conversation");
        if (this.credentials && this.connectedEndpoint) {
            const response = await this.postRpc(this.connectedEndpoint, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }, AbortSignal.timeout(this.config.requestTimeoutMs));
            if (!response.ok)
                throw new Error(`WorkBuddy ACP cancellation failed (${response.status})`);
            await response.body?.cancel();
        }
        this.aborted = true;
        this.activeController?.abort();
    }
    async close() {
        const endpoint = this.connectedEndpoint;
        const credentials = this.credentials;
        this.credentials = undefined;
        this.connectedEndpoint = undefined;
        if (!endpoint || !credentials)
            return;
        await this.fetchImpl(`${endpoint.baseUrl}/api/v1/acp`, {
            method: "DELETE", headers: this.headers(credentials), signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        }).catch(() => undefined);
    }
    headers(credentials = this.credentials) {
        const headers = { accept: "application/json, text/event-stream", "content-type": "application/json", "x-codebuddy-request": "1" };
        if (credentials) {
            headers["acp-connection-id"] = credentials.connectionId;
            if (credentials.sessionToken)
                headers["acp-session-token"] = credentials.sessionToken;
        }
        return headers;
    }
    async connect(endpoint) {
        const response = await this.fetchImpl(`${endpoint.baseUrl}/api/v1/acp/connect`, {
            method: "POST", headers: this.headers(), signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!response.ok)
            throw new Error(`WorkBuddy ACP connect failed (${response.status})`);
        const body = asRecord(await parseJson(response));
        const data = asRecord(body.data ?? body);
        if (typeof data.connectionId !== "string" || !data.connectionId)
            throw new Error("WorkBuddy ACP connect returned no connectionId");
        this.credentials = { connectionId: data.connectionId, sessionToken: typeof data.sessionToken === "string" ? data.sessionToken : undefined };
        this.connectedEndpoint = endpoint;
        this.aborted = false;
    }
    async rpc(endpoint, method, params, timeoutMs) {
        const id = this.nextId++;
        const signal = AbortSignal.timeout(timeoutMs);
        const response = await this.postRpc(endpoint, { jsonrpc: "2.0", id, method, params }, signal);
        if (!response.ok)
            throw new Error(`WorkBuddy ACP ${method} failed (${response.status})`);
        const terminal = await collectSseOrJson(response, id, undefined, signal);
        if (terminal.error !== undefined)
            throw new AcpRpcError(terminal.error, method);
        return terminal.result && typeof terminal.result === "object" ? terminal.result : undefined;
    }
    async prompt(endpoint, prompt, timeoutMs, options) {
        const controller = new AbortController();
        this.activeController = controller;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const id = this.nextId++;
        let text = "";
        let receivedExecutionActivity = false;
        try {
            const response = await this.postRpc(endpoint, {
                jsonrpc: "2.0", id, method: "session/prompt",
                params: { sessionId: endpoint.sessionId, prompt: [{ type: "text", text: prompt }], _meta: { "codebuddy.ai": { conversationId: endpoint.sessionId, isPlayground: endpoint.isPlayground === true, clientSendTime: Date.now() } } },
            }, controller.signal);
            if (!response.ok)
                throw new Error(`WorkBuddy ACP prompt failed (${response.status})`);
            const terminal = await collectSseOrJson(response, id, async (message) => {
                const params = asRecord(message.params);
                if (typeof params.sessionId === "string" && params.sessionId !== endpoint.sessionId)
                    return;
                if (message.method && message.id !== undefined) {
                    receivedExecutionActivity = true;
                    const request = { id: message.id, method: message.method, params };
                    let answer;
                    if (message.method === "session/request_permission" || message.method === "requestPermission")
                        answer = this.permissionResult(params);
                    if (!answer) {
                        await options.onEvent?.({ type: "input_required", status: "waiting_input", data: { id: request.id, method: request.method, params: redact(params) } });
                        answer = await options.onRequest?.(request);
                        if (!answer)
                            throw new WaitingForInput(request);
                    }
                    const reply = await this.postRpc(endpoint, { jsonrpc: "2.0", id: message.id, result: answer }, controller.signal);
                    if (!reply.ok)
                        throw new Error(`WorkBuddy ACP input response failed (${reply.status})`);
                    await reply.body?.cancel();
                    await options.onEvent?.({ type: "input_resolved", status: "running", data: { id: request.id, method: request.method } });
                }
                if (message.method === "session/update" || message.method === "sessionUpdate") {
                    receivedExecutionActivity = true;
                    const update = asRecord(params.update);
                    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "unknown";
                    const content = asRecord(update.content);
                    if (kind === "agent_message_chunk" && typeof content.text === "string") {
                        const chunk = content.text.slice(0, MAX_OUTPUT_CHARS - text.length);
                        text += chunk;
                        await options.onEvent?.({ type: "message_chunk", text: chunk });
                    }
                    else if (kind !== "agent_thought_chunk") {
                        await options.onEvent?.({ type: kind, status: typeof update.status === "string" ? update.status : undefined, data: redact(update) });
                    }
                }
                else if (message.method && message.id === undefined) {
                    await options.onEvent?.({ type: message.method, data: redact(params) });
                }
            }, controller.signal);
            if (terminal.error !== undefined) {
                const error = new AcpRpcError(terminal.error, "session/prompt");
                if (!receivedExecutionActivity && /session not found/i.test(error.message))
                    throw new PreDispatchSessionMissing(error.message);
                throw error;
            }
            const result = asRecord(terminal.result);
            const stopReason = typeof result.stopReason === "string" ? result.stopReason : undefined;
            const status = stopReason === "cancelled" || this.aborted ? "cancelled" : stopReason === "end_turn" && text.trim() ? "completed" : "blocked";
            const error = status === "blocked" ? (stopReason === "end_turn" ? "WorkBuddy ended the turn without a final answer. Check the recorded tool events and artifacts before continuing." : `WorkBuddy did not produce a completed turn (stopReason=${stopReason ?? "missing"}).`) : undefined;
            await options.onEvent?.({ type: "turn_end", status, data: { stopReason, hasText: !!text.trim() } });
            return { text, stopReason, status, sessionId: endpoint.sessionId, error };
        }
        catch (error) {
            if (error instanceof WaitingForInput)
                return { text, sessionId: endpoint.sessionId, status: "waiting_input", error: error.message, pendingInput: error.request };
            if (controller.signal.aborted)
                throw new Error(this.aborted ? "WorkBuddy ACP task cancelled" : "WorkBuddy ACP task timed out; completion was not verified");
            throw error;
        }
        finally {
            clearTimeout(timer);
            if (this.activeController === controller)
                this.activeController = undefined;
        }
    }
    async postRpc(endpoint, body, signal) {
        if (!this.credentials)
            throw new Error("WorkBuddy ACP is not connected");
        return this.fetchImpl(`${endpoint.baseUrl}/api/v1/acp`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    }
    permissionResult(params) {
        const kind = this.permissionMode === "allow_once" ? "allow_once" : "reject_once";
        const options = Array.isArray(params.options) ? params.options : [];
        const option = options.find((item) => item && typeof item === "object" && item.kind === kind && typeof item.optionId === "string");
        return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
    }
}
export function validateLoopbackUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "http:" || !url.port || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
        throw new Error("WorkBuddy ACP endpoint must be an HTTP loopback URL");
    return `http://${url.hostname}:${url.port}`;
}
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function redact(value) {
    const walk = (value) => Array.isArray(value) ? value.map(walk) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|token|cookie|authorization/i.test(key) ? "[redacted]" : walk(item)])) : value;
    return walk(value);
}
async function parseJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error("WorkBuddy ACP returned malformed JSON");
    }
}
/** Ends only at this POST's matching result, never an unrelated broadcast or input reply. */
export async function collectSseOrJson(response, requestId, onMessage, signal) {
    const isTerminal = (message) => message.id === requestId && !message.method && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
    const validate = (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("WorkBuddy ACP returned an invalid protocol frame");
        const message = value;
        if (message.jsonrpc !== "2.0")
            throw new Error("WorkBuddy ACP returned an incompatible JSON-RPC frame");
        return message;
    };
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const message = validate(await parseJson(response));
        await awaitWithSignal(Promise.resolve(onMessage?.(message)), signal);
        if (!isTerminal(message))
            throw new Error("WorkBuddy ACP response did not contain the matching request result");
        return message;
    }
    if (!response.body)
        throw new Error("WorkBuddy ACP returned an empty SSE stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal;
    const handle = async (block) => {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data)
            return;
        let value;
        try {
            value = JSON.parse(data);
        }
        catch {
            throw new Error("WorkBuddy ACP returned malformed SSE JSON");
        }
        const message = validate(value);
        await awaitWithSignal(Promise.resolve(onMessage?.(message)), signal);
        if (isTerminal(message))
            terminal = message;
    };
    const onAbort = () => { void reader.cancel().catch(() => undefined); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        if (signal?.aborted)
            throw new DOMException("ACP request aborted", "AbortError");
        while (!terminal) {
            const part = await reader.read();
            if (signal?.aborted)
                throw new DOMException("ACP request aborted", "AbortError");
            buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
            if (buffer.length > MAX_FRAME_CHARS)
                throw new Error("WorkBuddy ACP SSE frame exceeds the local size limit");
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
                await handle(block);
                if (terminal)
                    break;
            }
            if (part.done) {
                if (!terminal && buffer.trim())
                    await handle(buffer);
                break;
            }
        }
        if (!terminal)
            throw new Error("WorkBuddy ACP stream ended before the matching request result; completion was not verified");
        return terminal;
    }
    finally {
        signal?.removeEventListener("abort", onAbort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
function awaitWithSignal(promise, signal) {
    if (!signal)
        return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("ACP request aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted)
            abort();
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
//# sourceMappingURL=acp-live.js.map