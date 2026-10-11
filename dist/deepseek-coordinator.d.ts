import { type DeepSeekTransport } from "./deepseek-client.js";
import { DeepSeekStore, type DeepSeekTask } from "./deepseek-store.js";
export interface DeepSeekSendInput {
    taskId?: string;
    hostId?: string;
    sessionId: string;
    objective: string;
    workspace?: string;
    constraints?: string[];
    acceptanceCommands?: string[];
    timeoutSeconds?: number;
}
export declare class DeepSeekCoordinator {
    readonly store: DeepSeekStore;
    readonly client: DeepSeekTransport;
    constructor(store: DeepSeekStore, client: DeepSeekTransport);
    requireTask(taskId: string): DeepSeekTask;
    send(input: DeepSeekSendInput): Promise<{
        ok: boolean;
        created: boolean;
        task: DeepSeekTask;
        next: string;
        error?: undefined;
        dispatchUncertain?: undefined;
    } | {
        ok: boolean;
        created: boolean;
        task: DeepSeekTask;
        error: string;
        dispatchUncertain: boolean;
        next?: undefined;
    } | {
        ok: boolean;
        created: boolean;
        task: DeepSeekTask;
        message: string;
    } | {
        ok: boolean;
        created: boolean;
        task: DeepSeekTask;
        message?: undefined;
    }>;
    private dispatch;
    sync(taskId: string, limit?: number): Promise<DeepSeekTask>;
    wait(taskId: string, timeoutSeconds?: number): Promise<{
        ok: boolean;
        task: DeepSeekTask;
        next: string;
    }>;
    continue(input: {
        taskId: string;
        feedback: string;
        acceptanceCommands?: string[];
        acceptanceMode?: "append" | "replace";
        timeoutSeconds?: number;
    }): Promise<{
        ok: boolean;
        created: boolean;
        task: DeepSeekTask;
        next: string;
        error?: undefined;
        dispatchUncertain?: undefined;
    } | {
        ok: boolean;
        created: boolean;
        task: DeepSeekTask;
        error: string;
        dispatchUncertain: boolean;
        next?: undefined;
    }>;
    cancel(taskId: string, reason?: string): Promise<{
        ok: boolean;
        task: DeepSeekTask;
        cancellationRequested: boolean;
        remoteStopped: boolean;
        message: string;
        error?: undefined;
    } | {
        ok: boolean;
        task: DeepSeekTask;
        cancellationRequested: boolean;
        remoteStopped: boolean;
        message?: undefined;
        error?: undefined;
    } | {
        ok: boolean;
        task: DeepSeekTask;
        cancellationRequested: boolean;
        remoteStopped: boolean;
        error: string;
        message?: undefined;
    }>;
    accept(taskId: string, note: string, evidence: string[], artifactPaths?: string[]): Promise<DeepSeekTask>;
}
export declare function buildDeepSeekPrompt(task: DeepSeekTask, feedback?: string): string;
