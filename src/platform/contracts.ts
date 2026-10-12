import { z } from "zod";

export const requestSchema = z.object({
  provider: z.string().min(1).max(80).default("workbuddy"),
  task: z.string().trim().min(1).max(100_000),
  workspace: z.string().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  output: z.enum(["text", "json", "artifacts"]).default("text"),
  idempotencyKey: z.string().min(1).max(200).optional(),
  constraints: z.array(z.string().min(1).max(4000)).max(100).default([]),
  timeoutSeconds: z.number().int().min(10).max(86_400).default(1800),
}).strict();
export type RunInput = z.infer<typeof requestSchema>;
export type RunRequestInput = z.input<typeof requestSchema>;
export type RunStatus = "queued" | "dispatching" | "submitted" | "running" | "completed" | "blocked" | "failed" | "cancel_requested" | "cancelled" | "uncertain";
export interface Artifact { path: string; name: string; bytes: number; }
export interface HubRun {
  id: string; input: RunInput; workspace: string; providerTaskId: string;
  status: RunStatus; review: "pending" | "accepted"; holdsCapacity: boolean;
  round: number; resultFile: string; previousAttemptId?: string; feedback?: string;
  attemptId?: string; sessionId?: string; runtimeSource?: string;
  result?: { text: string; json?: unknown; artifacts: Artifact[] };
  error?: { code: string; message: string }; lastPollError?: string;
  usage: { credits: null; source: "unavailable" };
  createdAt: string; updatedAt: string; deadline: string;
}
export interface HubEvent { id: number; runId: string; type: string; data: unknown; createdAt: string; }
export interface ProviderEvent { key: string; type: string; text: string; }
export interface ProviderSnapshot {
  status: "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  holdsCapacity: boolean; attemptId?: string; sessionId?: string; runtimeSource?: string;
  error?: string; accepted?: boolean; events: ProviderEvent[];
}
export interface AgentProvider {
  readonly id: string; readonly label: string;
  readonly capabilities: Record<string, unknown>;
  health(): Promise<{ state: string; message: string; usage: HubRun["usage"]; [key: string]: unknown }>;
  submit(run: HubRun): Promise<void>;
  poll(run: HubRun): Promise<ProviderSnapshot | undefined>;
  cancel(run: HubRun): Promise<void>;
  rework(run: HubRun): Promise<void>;
  accept(run: HubRun, input: { note: string; evidence: string[] }): Promise<void>;
  models?(sessionId?:string):Promise<unknown>;
  workspaces?():unknown;
  bindWorkspace?(input:{workspace:string;sessionId?:string;model?:string;title?:string}):Promise<unknown>;
}
export class HubError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 400) { super(message); }
}
export const waitingStates = new Set<RunStatus>(["queued", "dispatching", "submitted", "running"]);
