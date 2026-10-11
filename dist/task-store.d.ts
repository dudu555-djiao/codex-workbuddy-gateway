import type { LocalMessage } from "./workbuddy-client.js";
export type TaskState = "queued" | "working" | "completed" | "blocked" | "failed" | "cancelled" | "needs_review" | "accepted";
export interface StoredTask {
    taskId: string;
    messageId: string;
    objective: string;
    workspace?: string;
    constraints?: string[];
    acceptanceCommands?: string[];
    state: TaskState;
    createdAt: string;
    updatedAt: string;
    lastMessageId?: string;
    report?: TaskReport;
    cancelNote?: string;
    reviewNote?: string;
    reviewedAt?: string;
    sessionId?: string;
    /** A backend/source identifier. Credentials must never be stored here. */
    runtimeSource?: string;
    attemptId?: string;
    attempt?: number;
    lastEventSeq?: number;
    artifacts?: string[];
    evidence?: string[];
    blockingReason?: string;
}
export interface TaskReport {
    status?: string;
    filesChanged: string[];
    commandsRun: string[];
    testResult?: string;
    remainingProblems?: string;
    rawText: string;
}
type NullableTaskFields = "report" | "reviewNote" | "reviewedAt" | "sessionId" | "runtimeSource" | "attemptId" | "attempt" | "lastEventSeq" | "artifacts" | "evidence" | "blockingReason" | "constraints" | "acceptanceCommands" | "cancelNote";
export type TaskUpdate = Partial<Pick<StoredTask, "state" | "messageId" | "lastMessageId">> & {
    [Field in NullableTaskFields]?: StoredTask[Field] | null;
};
export interface AttemptReservation {
    attemptId: string;
    messageId: string;
    sessionId?: string;
    runtimeSource?: string;
    state?: "queued" | "working";
    acceptanceCommands?: string[];
}
export interface StoredAttempt {
    taskId: string;
    attemptId: string;
    attempt: number;
    messageId: string;
    sessionId?: string;
    runtimeSource?: string;
    state: TaskState;
    lastEventSeq: number;
    artifacts: string[];
    evidence: string[];
    report?: TaskReport;
    blockingReason?: string;
    reviewNote?: string;
    reviewedAt?: string;
    cancelNote?: string;
    createdAt: string;
    updatedAt: string;
}
export declare class TaskStore {
    readonly file: string;
    private readonly db;
    constructor(file: string);
    close(): void;
    createOrGet(task: Omit<StoredTask, "createdAt" | "updatedAt"> & {
        createdAt?: string;
    }): {
        task: StoredTask;
        created: boolean;
    };
    get(taskId: string): StoredTask | undefined;
    listTasks(options?: {
        state?: TaskState;
        states?: TaskState[];
        limit?: number;
        offset?: number;
    }): StoredTask[];
    /** Reserve before spawning a worker, atomically across MCP processes. */
    beginAttempt(taskId: string, reservation: AttemptReservation): StoredTask;
    update(taskId: string, patch: TaskUpdate): StoredTask;
    /** A late old worker cannot overwrite a newer rework attempt. */
    updateAttempt(taskId: string, attemptId: string, patch: Omit<TaskUpdate, "attemptId" | "attempt">, options?: {
        expectedStates?: TaskState[];
        preserveTerminal?: boolean;
    }): {
        task: StoredTask;
        applied: boolean;
    };
    listAttempts(taskId: string): StoredAttempt[];
    addMessages(taskId: string, messages: LocalMessage[]): number;
    /** Read recent events for the current attempt, with history explicitly selectable. */
    listMessages(taskId: string, limit?: number, attemptId?: string): LocalMessage[];
    private writeUpdate;
    private saveAttempt;
    private transaction;
}
export {};
