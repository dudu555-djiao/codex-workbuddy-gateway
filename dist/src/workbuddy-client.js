import { TokenStore } from "./token-store.js";
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
    constructor(config, tokenStore = new TokenStore(config.tokenFile)) {
        this.config = config;
        this.tokenStore = tokenStore;
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
    async health() {
        const raw = await this.request("/localassistant");
        return { online: raw.data?.online === true, raw };
    }
    async sendMessage(content) {
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