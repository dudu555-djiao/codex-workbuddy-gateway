import { Config } from "./config.js";
import { TokenStore } from "./token-store.js";
export interface WorkBuddyEnvelope<T> {
    code?: number;
    msg?: string;
    request_id?: string;
    data?: T;
}
export interface LocalMessage {
    message_id: string;
    role: "user" | "assistant" | string;
    content: unknown[];
    msg_type?: string;
    created_at?: string;
    attachments?: unknown[];
    metadata?: Record<string, unknown>;
}
export declare class WorkBuddyApiError extends Error {
    readonly status?: number | undefined;
    readonly body?: unknown | undefined;
    constructor(message: string, status?: number | undefined, body?: unknown | undefined);
}
export interface TokenExchangeResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    open_id?: string;
    token_type?: string;
}
export declare class WorkBuddyClient {
    private readonly config;
    private readonly tokenStore;
    private refreshPromise?;
    private readonly cliRuns;
    private readonly gatewayRuns;
    private readonly durableRuns;
    private readonly desktopQueue;
    constructor(config: Config, tokenStore?: TokenStore);
    saveTokenResponse(response: TokenExchangeResponse): Promise<void>;
    health(sessionId?: string): Promise<{
        online: boolean;
        ready?: boolean;
        sessionId?: string;
        raw: WorkBuddyEnvelope<{
            online: boolean;
        }>;
    }>;
    sendMessage(content: string, workspace?: string, timeoutSeconds?: number, conversationId?: string, options?: {
        taskId?: string;
        attemptId?: string;
        model?: string;
        sessionMode?: "existing" | "new";
    }): Promise<{
        messageId: string;
        raw: WorkBuddyEnvelope<{
            message_id: string;
        }>;
    }>;
    messages(options?: {
        afterMessageId?: string;
        limit?: number;
    }): Promise<LocalMessage[]>;
    exchangeAuthorizationCode(code: string, redirectUri: string): Promise<TokenExchangeResponse>;
    refreshAccessToken(): Promise<string>;
    cancel(messageId: string): boolean;
    private gatewayHealth;
    private acpHealth;
    private acpSendMessage;
    runSnapshot(attemptId: string): import("./run-journal.js").RunSnapshot | undefined;
    respond(attemptId: string, decision: "allow_once" | "reject_once" | "cancel" | "submit", content?: Record<string, unknown>): void;
    private gatewaySendMessage;
    private gatewayMessages;
    private captureGatewayStream;
    private gatewayFetch;
    private cliHealth;
    private cliSendMessage;
    private cliMessages;
    private doRefresh;
    private tokenRequest;
    private accessToken;
    private request;
}
export declare function messageText(message: LocalMessage): string;
