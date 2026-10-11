import { Config } from "./config.js";
export interface LiveEndpoint {
    baseUrl: string;
    pid: number;
    sessionId: string;
    cwd?: string;
    sessionFile: string;
    runtimeSource?: "desktop_interactive";
    desktopVisible?: boolean;
    isPlayground?: boolean;
    sessionCwd?: string;
    workspaceBinding?: "native_cwd" | "absolute_paths";
    registrationReason?: string;
    reconnectable?: boolean;
}
export interface AcpEvent {
    type: string;
    text?: string;
    status?: string;
    data?: Record<string, unknown>;
}
export interface AcpInputRequest {
    id: number | string;
    method: string;
    params: Record<string, unknown>;
}
export interface AcpRunOptions {
    workspace?: string;
    model?: string;
    sessionMode?: "existing" | "new";
    onEvent?: (event: AcpEvent) => void | Promise<void>;
    onSession?: (endpoint: LiveEndpoint) => void | Promise<void>;
    onRequest?: (request: AcpInputRequest) => Promise<Record<string, unknown> | undefined>;
}
export interface AcpRunResult {
    text: string;
    stopReason?: string;
    sessionId?: string;
    status?: "completed" | "waiting_input" | "blocked" | "cancelled";
    error?: string;
    pendingInput?: AcpInputRequest;
}
export type AcpPermissionMode = "deny" | "allow_once";
interface RpcMessage {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}
export declare class AcpRpcError extends Error {
    readonly method: string;
    readonly code?: number;
    constructor(value: unknown, method: string);
}
/** Uses an exact, desktop-registered ACP conversation; never starts an independent CLI fallback. */
export declare class AcpLiveClient {
    private readonly config;
    private readonly permissionMode;
    private readonly fetchImpl;
    private credentials?;
    private connectedEndpoint?;
    private activeController?;
    private aborted;
    private nextId;
    constructor(config: Config, permissionMode?: AcpPermissionMode, fetchImpl?: typeof fetch);
    static listSessions(config: Config): LiveEndpoint[];
    static discover(config: Config, requestedSessionId?: string): LiveEndpoint;
    health(sessionId?: string): Promise<{
        endpoint: LiveEndpoint;
        online: boolean;
        ready: boolean;
        reason?: string;
    }>;
    run(prompt: string, sessionId?: string, timeoutMs?: number, options?: AcpRunOptions): Promise<AcpRunResult>;
    cancel(sessionId: string): Promise<void>;
    close(): Promise<void>;
    private headers;
    private connect;
    private rpc;
    private prompt;
    private postRpc;
    private permissionResult;
}
export declare function validateLoopbackUrl(value: string): string;
/** Ends only at this POST's matching result, never an unrelated broadcast or input reply. */
export declare function collectSseOrJson(response: Response, requestId: number | string, onMessage?: (message: RpcMessage) => Promise<void>, signal?: AbortSignal): Promise<RpcMessage>;
export {};
