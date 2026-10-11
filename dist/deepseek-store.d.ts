import type { DeepSeekEvent } from "./deepseek-client.js";
export type DeepSeekTaskState = "queued" | "working" | "blocked" | "failed" | "cancelled" | "needs_review" | "accepted";
export interface DeepSeekTask {
    taskId: string;
    objective: string;
    hostId: string;
    sessionId: string;
    workspace?: string;
    constraints: string[];
    acceptanceCommands: string[];
    state: DeepSeekTaskState;
    attemptId: string;
    attempt: number;
    requestId: string;
    turnId?: string;
    runOpen: boolean;
    dispatchState: "reserved" | "accepted" | "uncertain" | "rejected";
    createdAt: string;
    updatedAt: string;
    deadlineAt: string;
    lastEventSeq: number;
    lastProgress?: string;
    report?: string;
    artifacts: string[];
    evidence: string[];
    blockingReason?: string;
    blockingKind?: "transport" | "dispatch_unknown" | "deadline" | "waiting_input" | "cancel_requested" | "executor";
    syncError?: string;
    eventPageLimit?: number;
    cancelRequested?: boolean;
    cancelNote?: string;
    cancelledAt?: string;
    reviewNote?: string;
    reviewedAt?: string;
}
export interface DeepSeekAttempt extends DeepSeekTask {
    feedback?: string;
}
export declare class DeepSeekStore {
    readonly file: string;
    private readonly db;
    constructor(file: string);
    close(): void;
    get(taskId: string): DeepSeekTask | undefined;
    list(limit?: number): DeepSeekTask[];
    attempts(taskId: string): DeepSeekAttempt[];
    events(attemptId: string, limit?: number): DeepSeekEvent[];
    /** Identity and session lock commit before the remote prompt can be sent. */
    reserve(task: DeepSeekTask, feedback?: string): {
        created: boolean;
        task: DeepSeekTask;
    };
    update(taskId: string, attemptId: string, patch: Partial<DeepSeekTask>, options?: {
        expectedOpen?: boolean;
        expectedDispatchStates?: DeepSeekTask["dispatchState"][];
    }): DeepSeekTask;
    /** Store raw envelopes locally; only matching request AND turn may update a task. */
    applyEvents(taskId: string, attemptId: string, events: DeepSeekEvent[], cursor: number): DeepSeekTask;
    /** An empty successful page still proves transport recovered, without bypassing input/cancel/deadline blockers. */
    syncSucceeded(taskId: string, attemptId: string, eventPageLimit: number): DeepSeekTask;
    syncFailed(taskId: string, attemptId: string, message: string): DeepSeekTask;
    accept(taskId: string, attemptId: string, note: string, evidence: string[], artifacts: string[]): DeepSeekTask;
    private require;
    private write;
    private transaction;
}
