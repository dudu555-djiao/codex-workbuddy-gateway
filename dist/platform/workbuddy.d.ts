import type { Config } from "../config.js";
import { TaskStore } from "../task-store.js";
import { TaskCoordinator } from "../coordinator.js";
import { WorkBuddyClient } from "../workbuddy-client.js";
import { type AgentProvider, type HubRun, type ProviderSnapshot } from "./contracts.js";
export declare class WorkBuddyProvider implements AgentProvider {
    readonly config: Config;
    readonly id = "workbuddy";
    readonly label = "WorkBuddy";
    readonly capabilities: {
        outputs: string[];
        execution: string;
        sessionIsolation: string;
        modelSelection: boolean;
        workspaceBinding: boolean;
        creditUsage: boolean;
        cancellation: string;
        fullToolTrace: boolean;
    };
    readonly store: TaskStore;
    readonly client: WorkBuddyClient;
    readonly coordinator: TaskCoordinator;
    constructor(config: Config);
    close(): void;
    models(sessionId?: string): Promise<{
        models: Array<{
            id: string;
            name: string;
        }>;
        currentModel?: string;
        sessionId?: string;
        ok: boolean;
    }>;
    workspaces(): {
        ok: boolean;
        workers: {
            desktopRegistered: boolean;
            sessionId: string;
            workspace: string;
            state: "creating" | "ready" | "uncertain";
            selected: boolean;
            createdAt: string;
            updatedAt: string;
            error?: string;
        }[];
    };
    bindWorkspace(input: {
        workspace: string;
        sessionId?: string;
        model?: string;
        title?: string;
    }): Promise<{
        workspace: string;
        sessionId: string;
        next: string;
        created: boolean;
        worker: import("../workspace-workers.js").WorkspaceWorker;
        model?: string;
        ok: boolean;
    }>;
    health(): Promise<{
        state: string;
        message: string;
        login: string;
        model: string;
        usage: {
            readonly credits: null;
            readonly source: "unavailable";
        };
    }>;
    private instructions;
    submit(run: HubRun): Promise<void>;
    poll(run: HubRun): Promise<ProviderSnapshot | undefined>;
    cancel(run: HubRun): Promise<void>;
    rework(run: HubRun): Promise<void>;
    accept(run: HubRun, input: {
        note: string;
        evidence: string[];
    }): Promise<void>;
}
