import { ensureWorkspace } from "./workspace-manager.js";
import type { Config } from "./config.js";
import { TaskStore, type StoredTask, type TaskReport } from "./task-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
export interface SendTaskInput {
    taskId?: string;
    objective: string;
    workspace?: string;
    constraints?: string[];
    acceptanceCommands?: string[];
    timeoutSeconds?: number;
    sessionId?: string;
    model?: string;
    sessionMode?: "existing" | "new";
}
export declare class TaskCoordinator {
    private readonly config;
    readonly store: TaskStore;
    private readonly client;
    private readonly resolveWorkspace;
    constructor(config: Config, store: TaskStore, client: WorkBuddyClient, resolveWorkspace?: typeof ensureWorkspace);
    private requireDesktop;
    send(input: SendTaskInput): Promise<{
        ok: boolean;
        created: boolean;
        task: StoredTask | undefined;
        next: string;
        error?: undefined;
    } | {
        ok: boolean;
        task: StoredTask;
        error: string;
        created?: undefined;
        next?: undefined;
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask;
        message: string;
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask;
        message?: undefined;
    }>;
    private dispatch;
    sync(taskId: string, limit?: number): Promise<StoredTask>;
    continue(input: {
        taskId: string;
        feedback: string;
        acceptanceCommands?: string[];
        timeoutSeconds?: number;
        model?: string;
    }): Promise<{
        ok: boolean;
        created: boolean;
        task: StoredTask | undefined;
        next: string;
        error?: undefined;
    } | {
        ok: boolean;
        task: StoredTask;
        error: string;
        created?: undefined;
        next?: undefined;
    }>;
    accept(taskId: string, note: string, evidence: string[], artifactPaths?: string[]): Promise<StoredTask>;
    respond(taskId: string, decision: "allow_once" | "reject_once" | "cancel" | "submit", content?: Record<string, unknown>): {
        ok: boolean;
        taskId: string;
        message: string;
    };
    cancel(taskId: string, reason?: string): {
        ok: boolean;
        cancellationRequested: boolean;
        remoteStopped: boolean;
        task: StoredTask;
    };
    requireTask(taskId: string): StoredTask;
}
export declare function parseReport(rawText: string): TaskReport;
export declare function buildTaskPrompt(input: SendTaskInput & {
    taskId: string;
}, feedback?: string): string;
