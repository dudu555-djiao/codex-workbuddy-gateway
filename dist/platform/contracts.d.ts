import { z } from "zod";
export declare const requestSchema: z.ZodObject<{
    provider: z.ZodDefault<z.ZodString>;
    task: z.ZodString;
    workspace: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    output: z.ZodDefault<z.ZodEnum<["text", "json", "artifacts"]>>;
    idempotencyKey: z.ZodOptional<z.ZodString>;
    constraints: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    timeoutSeconds: z.ZodDefault<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    constraints: string[];
    task: string;
    output: "text" | "artifacts" | "json";
    timeoutSeconds: number;
    provider: string;
    sessionId?: string | undefined;
    workspace?: string | undefined;
    model?: string | undefined;
    idempotencyKey?: string | undefined;
}, {
    task: string;
    sessionId?: string | undefined;
    constraints?: string[] | undefined;
    workspace?: string | undefined;
    model?: string | undefined;
    output?: "text" | "artifacts" | "json" | undefined;
    timeoutSeconds?: number | undefined;
    provider?: string | undefined;
    idempotencyKey?: string | undefined;
}>;
export type RunInput = z.infer<typeof requestSchema>;
export type RunRequestInput = z.input<typeof requestSchema>;
export type RunStatus = "queued" | "dispatching" | "submitted" | "running" | "completed" | "blocked" | "failed" | "cancel_requested" | "cancelled" | "uncertain";
export interface Artifact {
    path: string;
    name: string;
    bytes: number;
}
export interface HubRun {
    id: string;
    input: RunInput;
    workspace: string;
    providerTaskId: string;
    status: RunStatus;
    review: "pending" | "accepted";
    holdsCapacity: boolean;
    round: number;
    resultFile: string;
    previousAttemptId?: string;
    feedback?: string;
    attemptId?: string;
    sessionId?: string;
    runtimeSource?: string;
    result?: {
        text: string;
        json?: unknown;
        artifacts: Artifact[];
    };
    error?: {
        code: string;
        message: string;
    };
    lastPollError?: string;
    usage: {
        credits: null;
        source: "unavailable";
    };
    createdAt: string;
    updatedAt: string;
    deadline: string;
}
export interface HubEvent {
    id: number;
    runId: string;
    type: string;
    data: unknown;
    createdAt: string;
}
export interface ProviderEvent {
    key: string;
    type: string;
    text: string;
}
export interface ProviderSnapshot {
    status: "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
    holdsCapacity: boolean;
    attemptId?: string;
    sessionId?: string;
    runtimeSource?: string;
    error?: string;
    accepted?: boolean;
    events: ProviderEvent[];
}
export interface AgentProvider {
    readonly id: string;
    readonly label: string;
    readonly capabilities: Record<string, unknown>;
    health(): Promise<{
        state: string;
        message: string;
        usage: HubRun["usage"];
        [key: string]: unknown;
    }>;
    submit(run: HubRun): Promise<void>;
    poll(run: HubRun): Promise<ProviderSnapshot | undefined>;
    cancel(run: HubRun): Promise<void>;
    rework(run: HubRun): Promise<void>;
    accept(run: HubRun, input: {
        note: string;
        evidence: string[];
    }): Promise<void>;
    models?(sessionId?: string): Promise<unknown>;
    workspaces?(): unknown;
    bindWorkspace?(input: {
        workspace: string;
        sessionId?: string;
        model?: string;
        title?: string;
    }): Promise<unknown>;
}
export declare class HubError extends Error {
    readonly code: string;
    readonly httpStatus: number;
    constructor(code: string, message: string, httpStatus?: number);
}
export declare const waitingStates: Set<RunStatus>;
