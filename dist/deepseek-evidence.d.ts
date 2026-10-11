import type { DeepSeekEvent } from "./deepseek-client.js";
/** A bounded view of persisted execution evidence, excluding model/system streams. */
export declare function summarizeDeepSeekEvents(events: DeepSeekEvent[]): {
    truncatedFields?: string[] | undefined;
    fullRecord?: string | undefined;
    seq: number;
    requestId: string;
    turnId: string | undefined;
    type: "completed" | "waiting_input" | "cancelled" | "failed" | "accepted" | "progress" | "started";
    rawType: string | undefined;
    timestamp: string | undefined;
    name: string | undefined;
    callId: string | undefined;
    isError: boolean | undefined;
    text: string | undefined;
    arguments: string | undefined;
    result: string | undefined;
    error: string | undefined;
    endReason: unknown;
    artifacts: string[] | undefined;
}[];
