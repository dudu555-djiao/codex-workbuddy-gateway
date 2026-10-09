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
    const configuredBackend = optional("WORKBUDDY_BACKEND");
    const backend = configuredBackend === "api"
        ? "api"
        : configuredBackend === "cli"
            ? "cli"
            : configuredBackend === "desktop-queue" ? "desktop-queue" : configuredBackend === "desktop-acp" || configuredBackend === "live"
                ? "desktop-acp"
                : configuredBackend === "gateway"
                    ? "gateway"
                    : "desktop-queue";
    return {
        backend,
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
        cliElectronPath: optional("WORKBUDDY_CLI_ELECTRON") ?? "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
        cliScriptPath: optional("WORKBUDDY_CLI_SCRIPT") ?? "/Applications/WorkBuddy.app/Contents/Resources/app.asar/cli/bin/codebuddy",
        cliPermissionMode: optional("WORKBUDDY_CLI_PERMISSION_MODE") ?? "acceptEdits",
        // Allow one explicit WorkBuddy action by default so delegated coding
        // tasks can actually edit files; set WORKBUDDY_ACP_PERMISSION_MODE=deny
        // for read-only review runs.
        acpPermissionMode: optional("WORKBUDDY_ACP_PERMISSION_MODE") === "deny" ? "deny" : "allow_once",
        gatewayUrl: (optional("WORKBUDDY_GATEWAY_URL") ?? "http://127.0.0.1:64523").replace(/\/$/, ""),
        gatewayPassword: optional("WORKBUDDY_GATEWAY_PASSWORD"),
        workbuddyConfigDir: optional("WORKBUDDY_CONFIG_DIR") ?? path.join(process.env.HOME ?? "", ".workbuddy"),
        runsDir: optional("WORKBUDDY_RUNS_DIR") ? path.resolve(optional("WORKBUDDY_RUNS_DIR")) : undefined,
        taskTimeoutSeconds: Math.min(integer("WORKBUDDY_TASK_TIMEOUT_SECONDS", 1800), 86_400),
        serviceConfigFile: path.resolve(optional("WORKBUDDY_SERVICE_CONFIG") ?? "./data/persistent-service.json"),
    };
}
export function requireOAuthConfig(config) {
    if (!config.clientId || !config.clientSecret) {
        throw new Error("OAuth requires WORKBUDDY_CLIENT_ID and WORKBUDDY_CLIENT_SECRET. Run the auth setup after creating an enabled WorkBuddy app.");
    }
    return { clientId: config.clientId, clientSecret: config.clientSecret };
}
//# sourceMappingURL=config.js.map