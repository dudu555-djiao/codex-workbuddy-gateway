import type { Config } from "./config.js";
import type { LocalMessage } from "./workbuddy-client.js";
export type RunStatus = "queued" | "working" | "needs_review" | "blocked" | "failed" | "cancelled";
export interface RunRequest {
    attemptId: string;
    taskId: string;
    prompt: string;
    workspace?: string;
    sessionId?: string;
    model?: string;
    sessionMode?: "existing" | "new";
    timeoutSeconds: number;
}
export interface RunSnapshot {
    attemptId: string;
    taskId: string;
    status: RunStatus;
    pid?: number;
    driver?: "desktop-acp" | "desktop-queue";
    deadline?: string;
    sessionId?: string;
    runtimeSource?: string;
    text?: string;
    stopReason?: string;
    error?: string;
    waitingInput?: boolean;
    artifacts?: string[];
    updatedAt: string;
}
export interface RunEvent {
    seq: number;
    type: string;
    text: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
}
export declare function runsDirectory(config: Config): string;
export declare function writePrivateJson(file: string, value: unknown): void;
export declare class RunJournal {
    readonly root: string;
    readonly attemptId: string;
    readonly dir: string;
    private seq;
    constructor(root: string, attemptId: string);
    static newId(): string;
    request(): RunRequest;
    snapshot(): RunSnapshot | undefined;
    save(snapshot: RunSnapshot): void;
    append(type: string, text: string, metadata?: Record<string, unknown>): RunEvent;
    events(after?: number, limit?: number): RunEvent[];
    cancel(): void;
    cancellationRequested(): boolean;
    checkWorker(): void;
}
export declare class DurableRuns {
    private readonly config;
    readonly root: string;
    constructor(config: Config);
    start(request: RunRequest): Promise<void>;
    messages(cursor: string, limit?: number): LocalMessage[];
    cancel(attemptId: string): boolean;
    respond(attemptId: string, decision: "allow_once" | "reject_once" | "cancel" | "submit", content?: Record<string, unknown>): void;
}
