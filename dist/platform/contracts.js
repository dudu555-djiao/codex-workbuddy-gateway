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
export class HubError extends Error {
    code;
    httpStatus;
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}
export const waitingStates = new Set(["queued", "dispatching", "submitted", "running"]);
//# sourceMappingURL=contracts.js.map