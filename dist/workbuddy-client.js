import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { TokenStore } from "./token-store.js";
import { AcpLiveClient } from "./acp-live.js";
import { DurableRuns, RunJournal } from "./run-journal.js";
import { DesktopQueue } from "./desktop-queue.js";
export class WorkBuddyApiError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "WorkBuddyApiError";
    }
}
export class WorkBuddyClient {
    config;
    tokenStore;
    refreshPromise;
    cliRuns = new Map();
    gatewayRuns = new Map();
    durableRuns;
    desktopQueue;
    constructor(config, tokenStore = new TokenStore(config.tokenFile)) {
        this.config = config;
        this.tokenStore = tokenStore;
        this.durableRuns = new DurableRuns(config);
        this.desktopQueue = new DesktopQueue(config);
    }
    async saveTokenResponse(response) {
        await this.tokenStore.write({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresAt: response.expires_in ? Date.now() + response.expires_in * 1000 : undefined,
            scope: response.scope,
            openId: response.open_id,
            tokenType: response.token_type,
        });
    }
    async health(sessionId) {
        if (this.config.backend === "cli")
            return this.cliHealth();
        if (this.config.backend === "gateway")
            return this.gatewayHealth();
        if (this.config.backend === "desktop-acp")
            return this.acpHealth(sessionId);
        if (this.config.backend === "desktop-queue") {
            const listeners = this.desktopQueue.listeners();
            const listener = sessionId ? listeners.find((item) => item.sessionId === sessionId) : listeners.length === 1 ? listeners[0] : undefined;
            const ready = Boolean(listener);
            return { online: ready, ready, sessionId: listener?.sessionId, raw: { code: ready ? 0 : 1, msg: ready ? "A native WorkBuddy desktop helper is waiting for queue tasks; actual execution still needs verification." : "No matching desktop queue listener is waiting. Bootstrap the dedicated WorkBuddy worker conversation first.", data: { online: ready } } };
        }
        const raw = await this.request("/localassistant");
        return { online: raw.data?.online === true, raw };
    }
    async sendMessage(content, workspace, timeoutSeconds, conversationId, options = {}) {
        if (this.config.backend === "cli")
            return this.cliSendMessage(content, workspace);
        if (this.config.backend === "gateway")
            return this.gatewaySendMessage(content, workspace, timeoutSeconds, conversationId);
        if (this.config.backend === "desktop-acp")
            return this.acpSendMessage(content, workspace, timeoutSeconds, conversationId, options);
        if (this.config.backend === "desktop-queue") {
            const messageId = options.attemptId ?? RunJournal.newId();
            this.desktopQueue.start({ attemptId: messageId, taskId: options.taskId ?? messageId, prompt: content, workspace, sessionId: conversationId, model: options.model, sessionMode: options.sessionMode, timeoutSeconds: timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800 });
            return { messageId, raw: { code: 0, msg: "Task queued; native WorkBuddy must claim it before execution is confirmed.", data: { message_id: messageId } } };
        }
        const raw = await this.request("/localassistant/message", {
            method: "POST",
            body: JSON.stringify({ content, msg_type: "text" }),
        });
        const messageId = raw.data?.message_id;
        if (!messageId)
            throw new WorkBuddyApiError("WorkBuddy returned no data.message_id", undefined, raw);
        return { messageId, raw };
    }
    async messages(options = {}) {
        if (this.config.backend === "cli")
            return this.cliMessages(options.afterMessageId);
        if (this.config.backend === "gateway")
            return this.gatewayMessages(options.afterMessageId);
        if (this.config.backend === "desktop-acp")
            return options.afterMessageId ? this.durableRuns.messages(options.afterMessageId, options.limit) : [];
        if (this.config.backend === "desktop-queue")
            return options.afterMessageId ? this.desktopQueue.messages(options.afterMessageId, options.limit) : [];
        const params = new URLSearchParams();
        if (options.afterMessageId)
            params.set("message_id", options.afterMessageId);
        else {
            params.set("limit", String(Math.min(Math.max(options.limit ?? 20, 1), 100)));
            params.set("offset", "0");
        }
        const raw = await this.request(`/localassistant/message?${params}`);
        return raw.data?.messages ?? [];
    }
    async exchangeAuthorizationCode(code, redirectUri) {
        const response = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
        await this.saveTokenResponse(response);
        return response;
    }
    async refreshAccessToken() {
        if (this.refreshPromise)
            return this.refreshPromise;
        this.refreshPromise = this.doRefresh().finally(() => { this.refreshPromise = undefined; });
        return this.refreshPromise;
    }
    cancel(messageId) {
        if (this.config.backend === "gateway") {
            const run = this.gatewayRuns.get(messageId);
            if (!run || run.done)
                return false;
            run.error = "Cancelled by Codex";
            run.done = true;
            void this.gatewayFetch(`/api/v1/runs/${encodeURIComponent(run.runId)}/cancel`, { method: "POST" }).catch(() => undefined);
            return true;
        }
        if (this.config.backend === "desktop-acp" || this.config.backend === "desktop-queue")
            return this.durableRuns.cancel(messageId);
        const run = this.cliRuns.get(messageId);
        if (!run || run.closed)
            return false;
        run.child.kill("SIGTERM");
        return true;
    }
    async gatewayHealth() {
        try {
            const response = await this.gatewayFetch("/api/v1/health");
            const raw = await parseJson(response);
            const online = response.ok && raw?.data?.status === "ok";
            return { online, raw: { code: online ? 0 : response.status, msg: online ? "WorkBuddy embedded gateway is online" : "WorkBuddy embedded gateway is offline", data: { online } } };
        }
        catch (error) {
            return { online: false, raw: { code: 1, msg: error instanceof Error ? error.message : String(error), data: { online: false } } };
        }
    }
    async acpHealth(sessionId) {
        try {
            const result = await new AcpLiveClient(this.config, "deny").health(sessionId);
            return { online: result.online, ready: result.ready, sessionId: result.endpoint.sessionId, raw: { code: 0, msg: result.ready ? "WorkBuddy ACP is connectable and its session is registered in desktop history. Model, skill and task success still require verification." : result.reason ?? "ACP is connectable but desktop registration is unverified", data: { online: result.online } } };
        }
        catch (error) {
            return { online: false, raw: { code: 1, msg: error instanceof Error ? error.message : String(error), data: { online: false } } };
        }
    }
    async acpSendMessage(content, workspace, timeoutSeconds, conversationId, options = {}) {
        const messageId = options.attemptId ?? RunJournal.newId();
        await this.durableRuns.start({
            attemptId: messageId, taskId: options.taskId ?? messageId, prompt: content,
            workspace, sessionId: conversationId, model: options.model, sessionMode: options.sessionMode,
            timeoutSeconds: timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800,
        });
        return { messageId, raw: { code: 0, msg: "Desktop task reserved in a durable bridge worker; inspect progress for session binding and execution result", data: { message_id: messageId } } };
    }
    runSnapshot(attemptId) {
        return new RunJournal(this.durableRuns.root, attemptId).snapshot();
    }
    respond(attemptId, decision, content) {
        if (this.config.backend === "desktop-queue")
            throw new Error("Desktop queue permission/input prompts are handled in WorkBuddy's native UI. Inspect that conversation; after a blocked report, continue with specific feedback.");
        this.durableRuns.respond(attemptId, decision, content);
    }
    async gatewaySendMessage(content, workspace, timeoutSeconds, conversationId) {
        const id = `codex-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const taskTimeoutMs = timeoutSeconds
            ? Math.min(Math.max(timeoutSeconds * 1000, 10_000), 86_400_000)
            : undefined;
        const response = await this.gatewayFetch("/api/v1/runs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                id,
                type: "message",
                // Keep one stable conversation id across a task's initial run and
                // rework runs while each run still gets its own unique idempotency id.
                source: { platform: "generic", sender: { id: "codex-gateway" }, conversation: { id: conversationId ?? id, type: "direct" } },
                payload: { text: `${workspace ? `工作目录：${workspace}\n\n` : ""}${content}` },
                ...(taskTimeoutMs ? { timeoutMs: taskTimeoutMs } : {}),
            }),
        });
        const parsed = await parseJson(response);
        const runId = parsed?.data?.runId;
        if (!response.ok || !runId)
            throw new WorkBuddyApiError(`WorkBuddy embedded gateway rejected the task (${response.status})`, response.status, parsed);
        // The stream remains open until the WorkBuddy run finishes. The ordinary
        // request timeout is only suitable for short HTTP calls; using it here
        // caused long-running runs to be reported as failed even after WorkBuddy
        // completed them successfully.
        const streamTimeoutMs = taskTimeoutMs
            ? Math.min(taskTimeoutMs + 30_000, 86_430_000)
            : Math.max(this.config.requestTimeoutMs, 180_000);
        const run = { runId, content: "", done: false, emitted: false, streamTimeoutMs };
        this.gatewayRuns.set(runId, run);
        run.streamPromise = this.captureGatewayStream(run).catch((error) => { run.error = error instanceof Error ? error.message : String(error); run.done = true; });
        return { messageId: runId, raw: { code: 0, msg: "WorkBuddy embedded gateway task started", data: { message_id: runId } } };
    }
    gatewayMessages(afterMessageId) {
        if (!afterMessageId)
            return [];
        const run = this.gatewayRuns.get(afterMessageId);
        if (!run || !run.done || run.emitted)
            return [];
        run.emitted = true;
        const text = run.error ? `TASK_STATUS: failed\n${run.error}` : run.content || "TASK_STATUS: failed\nWorkBuddy returned no text output; completion is unverified.";
        return [{ message_id: `${afterMessageId}:result`, role: "assistant", content: [text], msg_type: "text", created_at: new Date().toISOString(), attachments: [], metadata: { source: "workbuddy-embedded-gateway" } }];
    }
    async captureGatewayStream(run) {
        const response = await this.gatewayFetch(`/api/v1/runs/${encodeURIComponent(run.runId)}/stream`, { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(run.streamTimeoutMs) });
        if (!response.ok)
            throw new Error(`WorkBuddy embedded gateway stream unavailable (${response.status})`);
        const body = await response.text();
        for (const match of body.matchAll(/event: message\ndata: (.+?)(?:\r?\n\r?\n|$)/g)) {
            try {
                const event = JSON.parse(match[1]);
                if (event.content?.chunk)
                    run.content += event.content.chunk;
                if (event.status === "completed")
                    run.content = event.content?.markdown ?? event.content?.text ?? run.content;
                if (event.status === "error")
                    run.error = event.error?.message ?? "WorkBuddy task failed";
            }
            catch { /* ignore malformed SSE frames */ }
        }
        run.done = true;
    }
    async gatewayFetch(path, init = {}) {
        const gateway = discoverGateway(this.config);
        return fetch(`${gateway.url}${path}`, { ...init, headers: { accept: "application/json", authorization: `Bearer ${gateway.password}`, ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(this.config.requestTimeoutMs) });
    }
    cliHealth() {
        const ready = fs.existsSync(this.config.cliElectronPath) && virtualPathExists(this.config.cliScriptPath);
        return {
            online: ready,
            raw: { code: ready ? 0 : 1, msg: ready ? "local CLI available" : "WorkBuddy CLI files not found", data: { online: ready } },
        };
    }
    cliSendMessage(content, workspace) {
        const health = this.cliHealth();
        if (!health.online)
            throw new WorkBuddyApiError(`WorkBuddy CLI not found. Expected ${this.config.cliScriptPath}`);
        const messageId = `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const child = spawn(this.config.cliElectronPath, [
            this.config.cliScriptPath,
            "--print",
            "--output-format",
            "json",
            "--permission-mode",
            this.config.cliPermissionMode,
            content,
        ], {
            cwd: workspace || process.cwd(),
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const run = { child, stdout: "", stderr: "", closed: false, resultMessageId: `${messageId}:result` };
        this.cliRuns.set(messageId, run);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => { run.stdout += chunk; });
        child.stderr?.on("data", (chunk) => { run.stderr += chunk; });
        child.once("error", (error) => { run.stderr += String(error); run.closed = true; run.exitCode = -1; });
        child.once("close", (code) => { run.closed = true; run.exitCode = code ?? -1; });
        return { messageId, raw: { code: 0, msg: "local CLI task started", data: { message_id: messageId } } };
    }
    cliMessages(afterMessageId) {
        if (!afterMessageId)
            return [];
        const run = [...this.cliRuns.values()].find((candidate) => candidate.resultMessageId.startsWith(afterMessageId) || candidate.resultMessageId === `${afterMessageId}:result`);
        if (!run || !run.closed)
            return [];
        if (run.emitted)
            return [];
        run.emitted = true;
        const output = parseCliOutput(run.stdout);
        const cliError = run.exitCode !== 0 || /authentication required|not authenticated|error|failed/i.test(run.stderr);
        const text = cliError ? `TASK_STATUS: failed\n${output}\n${run.stderr}` : output;
        return [{ message_id: run.resultMessageId, role: "assistant", content: [text], msg_type: "text", created_at: new Date().toISOString(), attachments: [], metadata: { source: "workbuddy-cli", exitCode: run.exitCode } }];
    }
    async doRefresh() {
        const stored = await this.tokenStore.read();
        if (!stored?.refreshToken)
            throw new WorkBuddyApiError("No refresh token is configured. Run `npm run auth` or set WORKBUDDY_ACCESS_TOKEN.");
        const response = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: stored.refreshToken });
        await this.saveTokenResponse({ ...response, refresh_token: response.refresh_token ?? stored.refreshToken });
        return response.access_token;
    }
    async tokenRequest(fields) {
        if (!this.config.clientId || !this.config.clientSecret) {
            throw new WorkBuddyApiError("WORKBUDDY_CLIENT_ID and WORKBUDDY_CLIENT_SECRET are required for OAuth token exchange.");
        }
        const body = new URLSearchParams({ ...fields, client_id: this.config.clientId, client_secret: this.config.clientSecret });
        const response = await fetch(`${this.config.apiBaseUrl}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body,
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        const parsed = await parseJson(response);
        if (!response.ok || typeof parsed?.access_token !== "string") {
            throw new WorkBuddyApiError(`WorkBuddy token exchange failed (${response.status})`, response.status, parsed);
        }
        return parsed;
    }
    async accessToken() {
        if (this.config.accessToken)
            return this.config.accessToken;
        const stored = await this.tokenStore.read();
        if (!stored)
            throw new WorkBuddyApiError("No WorkBuddy token found. Set WORKBUDDY_ACCESS_TOKEN or run `npm run auth`.");
        if (stored.expiresAt && stored.expiresAt <= Date.now() + 60_000)
            return this.refreshAccessToken();
        return stored.accessToken;
    }
    async request(path, init = {}, allowRetry = true) {
        const token = await this.accessToken();
        const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
            ...init,
            headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
            signal: init.signal ?? AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        const parsed = await parseJson(response);
        if (response.status === 401 && allowRetry && !this.config.accessToken) {
            await this.refreshAccessToken();
            return this.request(path, init, false);
        }
        if (!response.ok) {
            const message = typeof parsed === "object" && parsed && "msg" in parsed ? String(parsed.msg) : response.statusText;
            throw new WorkBuddyApiError(`WorkBuddy API request failed (${response.status}): ${message}`, response.status, parsed);
        }
        if (typeof parsed !== "object" || parsed === null)
            throw new WorkBuddyApiError("WorkBuddy returned a non-JSON response", response.status, parsed);
        const envelope = parsed;
        if (typeof envelope.code === "number" && envelope.code !== 0)
            throw new WorkBuddyApiError(`WorkBuddy API error ${envelope.code}: ${envelope.msg ?? "unknown error"}`, response.status, parsed);
        return parsed;
    }
}
function virtualPathExists(file) {
    if (fs.existsSync(file))
        return true;
    const marker = ".asar/";
    const index = file.indexOf(marker);
    return index > 0 && fs.existsSync(`${file.slice(0, index)}.asar`);
}
function discoverGateway(config) {
    if (config.gatewayPassword)
        return { url: config.gatewayUrl, password: config.gatewayPassword };
    try {
        const listing = execFileSync("ps", ["eww", "-axo", "pid=,command="], { encoding: "utf8" });
        const line = listing.split("\n").find((entry) => entry.includes("/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy") && entry.includes("--serve"));
        if (line) {
            const password = line.match(/(?:^|\s)CODEBUDDY_GATEWAY_PASSWORD=([^\s]+)/)?.[1];
            const pid = line.trim().split(/\s+/, 1)[0];
            if (!pid)
                return { url: config.gatewayUrl, password: "" };
            const sockets = execFileSync("lsof", ["-Pan", "-p", pid, "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
            const port = sockets.match(/127\.0\.0\.1:(\d+)/)?.[1];
            if (password && port)
                return { url: `http://127.0.0.1:${port}`, password };
        }
    }
    catch { /* fall back to explicit configuration */ }
    return { url: config.gatewayUrl, password: "" };
}
function parseCliOutput(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return "";
    try {
        const parsed = JSON.parse(trimmed);
        for (const key of ["result", "output", "text", "response"]) {
            if (typeof parsed[key] === "string")
                return parsed[key];
        }
        return JSON.stringify(parsed, null, 2);
    }
    catch {
        return trimmed;
    }
}
async function parseJson(response) {
    const text = await response.text();
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
export function messageText(message) {
    return message.content.map((part) => {
        if (typeof part === "string")
            return part;
        if (part && typeof part === "object" && "text" in part)
            return String(part.text ?? "");
        return JSON.stringify(part);
    }).join("");
}
//# sourceMappingURL=workbuddy-client.js.map