import type { Config } from "./config.js";
export declare function workerRegistration(config: Config): import("./persistent-service.js").ServiceRegistration | undefined;
export declare function ensureWorkspace(config: Config, input: {
    workspace: string;
    sessionId?: string;
    title?: string;
    model?: string;
}): Promise<{
    workspace: string;
    sessionId: string;
    next: string;
    created: boolean;
    worker: import("./workspace-workers.js").WorkspaceWorker;
    model?: string;
    ok: boolean;
}>;
export declare function listModels(config: Config, sessionId?: string): Promise<{
    models: Array<{
        id: string;
        name: string;
    }>;
    currentModel?: string;
    sessionId?: string;
    ok: boolean;
}>;
export declare function listWorkspaces(config: Config): {
    desktopRegistered: boolean;
    sessionId: string;
    workspace: string;
    state: "creating" | "ready" | "uncertain";
    selected: boolean;
    createdAt: string;
    updatedAt: string;
    error?: string;
}[];
