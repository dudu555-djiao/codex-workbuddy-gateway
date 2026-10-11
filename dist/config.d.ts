export interface Config {
    backend: "cli" | "api" | "gateway" | "desktop-acp" | "desktop-queue";
    apiBaseUrl: string;
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    tokenFile: string;
    dbFile: string;
    oauthRedirectUri: string;
    oauthPort: number;
    oauthScopes: string;
    requestTimeoutMs: number;
    cliElectronPath: string;
    cliScriptPath: string;
    cliPermissionMode: string;
    acpPermissionMode: "deny" | "allow_once";
    gatewayUrl: string;
    gatewayPassword?: string;
    workbuddyConfigDir: string;
    runsDir?: string;
    taskTimeoutSeconds?: number;
    serviceConfigFile?: string;
}
export declare function loadConfig(): Config;
export declare function requireOAuthConfig(config: Config): {
    clientId: string;
    clientSecret: string;
};
