import { HubStore } from "./store.js";
import { type AgentProvider, type Artifact, type HubRun } from "./contracts.js";
export declare function inside(root: string, file: string): boolean;
export declare function artifactFor(run: HubRun, file: string): Artifact;
export declare function readResult(run: HubRun): NonNullable<HubRun["result"]>;
export declare class HubEngine {
    readonly store: HubStore;
    readonly directory: string;
    readonly maxConcurrent: number;
    readonly providers: Map<string, AgentProvider>;
    private serial;
    constructor(store: HubStore, providers: AgentProvider[], directory: string, maxConcurrent?: number);
    exclusive<T>(fn: () => Promise<T>): Promise<T>;
    get(id: string): HubRun;
    provider(id: string): AgentProvider;
    describeProviders(): Promise<{
        state: string;
        message: string;
        usage: HubRun["usage"];
        id: string;
        label: string;
        capabilities: Record<string, unknown>;
    }[]>;
    submit(raw: unknown): {
        run: HubRun;
        created: boolean;
    };
    private resultFile;
    private synchronize;
    private applySnapshot;
    /** One serialized scheduler; start-up never replays dispatching records. */
    tick(): Promise<void>;
    cancel(id: string): Promise<HubRun>;
    rework(id: string, feedback: string): Promise<HubRun>;
    accept(id: string, input: {
        note: string;
        evidence: string[];
    }): Promise<HubRun>;
}
