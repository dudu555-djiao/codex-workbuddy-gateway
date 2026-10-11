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
        creditUsage: boolean;
        cancellation: string;
        fullToolTrace: boolean;
    };
    readonly store: TaskStore;
    readonly client: WorkBuddyClient;
    readonly coordinator: TaskCoordinator;
    constructor(config: Config);
    close(): void;
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
