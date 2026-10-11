export interface DeepSeekHost {
    hostId: string;
    socketPath: string;
    token: string;
    pid?: number;
    version?: string;
    profile?: string;
    runtimeSource?: string;
    processAlive?: boolean;
}
export interface DeepSeekSession {
    sessionId: string;
    workspace?: string;
    busy?: boolean;
    activeRequestId?: string;
    title?: string;
}
export interface DeepSeekEvent {
    seq: number;
    requestId: string;
    turnId?: string;
    type: "accepted" | "started" | "progress" | "completed" | "failed" | "cancelled" | "waiting_input";
    text?: string;
    artifacts?: string[];
    error?: string;
    timestamp?: string;
    rawType?: string;
    data?: unknown;
    raw?: unknown;
}
export interface DeepSeekEvents {
    events: DeepSeekEvent[];
    cursor: number;
}
export interface DeepSeekTransport {
    health(hostId?: string): Promise<unknown>;
    sessions(hostId?: string): Promise<{
        sessions: DeepSeekSession[];
    }>;
    create(input: {
        hostId?: string;
        workspace?: string;
        title?: string;
    }): Promise<DeepSeekSession>;
    session(input: {
        hostId?: string;
        sessionId: string;
    }): Promise<DeepSeekSession>;
    prompt(input: {
        hostId: string;
        sessionId: string;
        requestId: string;
        text: string;
    }): Promise<{
        requestId: string;
        turnId?: string;
        accepted: boolean;
    }>;
    events(input: {
        hostId: string;
        sessionId: string;
        requestId: string;
        afterSeq: number;
        limit: number;
    }): Promise<DeepSeekEvents>;
    cancel(input: {
        hostId: string;
        sessionId: string;
        requestId: string;
    }): Promise<{
        requested: boolean;
        stopped?: boolean;
    }>;
    resolveHostId(hostId?: string): string;
}
export declare class DeepSeekRpcError extends Error {
    readonly code: string;
    readonly admissionRejected: boolean;
    constructor(code: string, message: string, admissionRejected?: boolean);
}
export declare class DeepSeekClient implements DeepSeekTransport {
    readonly registryDir: string;
    readonly defaultHostId: string | undefined;
    readonly timeoutMs: number;
    constructor(registryDir?: string, defaultHostId?: string | undefined, timeoutMs?: number);
    hosts(): DeepSeekHost[];
    resolveHostId(hostId?: string | undefined): string;
    rpc<T>(method: string, params?: Record<string, unknown>, hostId?: string): Promise<T>;
    health(hostId?: string): Promise<unknown>;
    sessions(hostId?: string): Promise<{
        sessions: DeepSeekSession[];
    }>;
    create({ hostId, ...input }: {
        hostId?: string;
        workspace?: string;
        title?: string;
    }): Promise<DeepSeekSession>;
    session({ hostId, ...input }: {
        hostId?: string;
        sessionId: string;
    }): Promise<DeepSeekSession>;
    prompt({ hostId, ...input }: {
        hostId: string;
        sessionId: string;
        requestId: string;
        text: string;
    }): Promise<{
        requestId: string;
        turnId?: string;
        accepted: boolean;
    }>;
    events({ hostId, ...input }: {
        hostId: string;
        sessionId: string;
        requestId: string;
        afterSeq: number;
        limit: number;
    }): Promise<DeepSeekEvents>;
    cancel({ hostId, ...input }: {
        hostId: string;
        sessionId: string;
        requestId: string;
    }): Promise<{
        requested: boolean;
        stopped?: boolean;
    }>;
}
