import { type HubRun, type HubEvent, type RunRequestInput } from "./contracts.js";
export type { HubRun, HubEvent, RunRequestInput } from "./contracts.js";
export declare class AgentHubClient {
    readonly url: string;
    private readonly token;
    constructor(url: string, token: string);
    static local(directory?: string): AgentHubClient;
    request<T = unknown>(route: string, method?: string, data?: unknown, signal?: AbortSignal): Promise<T>;
    submit(input: RunRequestInput): Promise<{
        run: HubRun;
        created: boolean;
    }>;
    get(id: string): Promise<HubRun>;
    events(id: string, after?: number): Promise<{
        events: HubEvent[];
    }>;
    cancel(id: string): Promise<HubRun>;
    rework(id: string, feedback: string): Promise<HubRun>;
    accept(id: string, note: string, evidence: string[]): Promise<HubRun>;
    wait(id: string, options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<HubRun>;
    run(input: RunRequestInput, options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<HubRun>;
}
