import type { Config } from "./config.js";
export interface WorkspaceWorker {
    sessionId: string;
    workspace: string;
    state: "creating" | "ready" | "uncertain";
    selected: boolean;
    createdAt: string;
    updatedAt: string;
    error?: string;
}
export interface NativeWorkerCreator {
    createWorker(workspace: string, sessionId: string, title?: string): Promise<{
        sessionId: string;
        workspace: string;
    }>;
}
export declare function readWorkspaceWorkers(config: Config, fallback?: {
    workspace: string;
    sessionId: string;
}): WorkspaceWorker[];
/** This is our routing registry, never WorkBuddy's own database. */
export declare class WorkspaceWorkers {
    readonly config: Config;
    private readonly db;
    constructor(config: Config);
    private decode;
    selected(workspace: string): WorkspaceWorker | undefined;
    list(): WorkspaceWorker[];
    seed(worker: {
        sessionId: string;
        workspace: string;
    }): void;
    select(workspace: string, sessionId: string): WorkspaceWorker;
    private reserve;
    private verify;
    ensure(input: {
        workspace: string;
        sessionId?: string;
        title?: string;
    }, native: NativeWorkerCreator): Promise<{
        created: boolean;
        worker: WorkspaceWorker;
    }>;
    close(): void;
}
