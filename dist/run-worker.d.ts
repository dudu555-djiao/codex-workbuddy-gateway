import { type Config } from "./config.js";
import { type RunStatus } from "./run-journal.js";
interface EndpointBinding {
    sessionId: string;
    cwd?: string;
    runtimeSource?: string;
    desktopVisible?: boolean;
    reconnectable?: boolean;
}
interface Progress {
    type: string;
    text?: string;
    status?: string;
    data?: Record<string, unknown>;
}
interface WorkerResult {
    text: string;
    stopReason?: string;
    status?: string;
    artifacts?: string[];
}
export interface WorkerTransport {
    run(prompt: string, sessionId: string | undefined, timeoutMs: number, options: {
        workspace?: string;
        model?: string;
        sessionMode?: "existing" | "new";
        onSession: (endpoint: EndpointBinding) => void;
        onEvent: (event: Progress) => void;
        onRequest: (request: {
            id: string | number;
            method: string;
            params: Record<string, unknown>;
        }) => Promise<Record<string, unknown> | undefined>;
    }): Promise<WorkerResult>;
    cancel(sessionId: string): Promise<void>;
}
/** A lease protects a desktop conversation from overlapping prompts by this bridge. */
export declare function acquireSessionLease(root: string, sessionId: string, attemptId: string): () => void;
export declare function classifyResult(result: WorkerResult): {
    status: RunStatus;
    error?: string;
    artifacts: string[];
};
export declare function runWorker(root: string, attemptId: string, config: Config, transport: WorkerTransport): Promise<void>;
export {};
