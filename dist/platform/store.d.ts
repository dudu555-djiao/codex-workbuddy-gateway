import { type HubRun, type HubEvent } from "./contracts.js";
/** Platform records never replace provider-owned execution history. */
export declare class HubStore {
    private readonly db;
    constructor(file: string);
    close(): void;
    get(id: string): HubRun | undefined;
    byKey(key: string, fingerprint: string): HubRun | undefined;
    create(run: HubRun, fingerprint: string): {
        run: HubRun;
        created: boolean;
    };
    list(limit?: number, offset?: number): HubRun[];
    all(): HubRun[];
    save(run: HubRun): HubRun;
    event(runId: string, type: string, data: unknown, key?: string): void;
    private stateEvent;
    events(runId: string, after?: number, limit?: number): HubEvent[];
}
