import path from "node:path";
function optional(name) {
    const value = process.env[name]?.trim();
    return value || undefined;
}
function integer(name, fallback) {
    const value = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
export function loadConfig() {
    return {
        apiBaseUrl: (optional("WORKBUDDY_API_BASE_URL") ?? "https://www.workbuddy.cn/openapi/v2").replace(/\/$/, ""),
        clientId: optional("WORKBUDDY_CLIENT_ID"),
        clientSecret: optional("WORKBUDDY_CLIENT_SECRET"),
        accessToken: optional("WORKBUDDY_ACCESS_TOKEN"),
        tokenFile: path.resolve(optional("WORKBUDDY_TOKEN_FILE") ?? "./data/credentials.json"),
        dbFile: path.resolve(optional("WORKBUDDY_DB_FILE") ?? "./data/tasks.sqlite"),
        oauthRedirectUri: optional("WORKBUDDY_OAUTH_REDIRECT_URI") ?? "http://127.0.0.1:8787/oauth/callback",
        oauthPort: integer("WORKBUDDY_OAUTH_PORT", 8787),
        oauthScopes: optional("WORKBUDDY_OAUTH_SCOPES") ?? "user.localassistant.invokable user.localassistant.readable",
        requestTimeoutMs: integer("WORKBUDDY_REQUEST_TIMEOUT_MS", 30_000),
    };
}
export function requireOAuthConfig(config) {
    if (!config.clientId || !config.clientSecret) {
        throw new Error("OAuth requires WORKBUDDY_CLIENT_ID and WORKBUDDY_CLIENT_SECRET. Run the auth setup after creating an enabled WorkBuddy app.");
    }
    return { clientId: config.clientId, clientSecret: config.clientSecret };
}
//# sourceMappingURL=config.js.map