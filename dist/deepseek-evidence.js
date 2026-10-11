/** A bounded view of persisted execution evidence, excluding model/system streams. */
export function summarizeDeepSeekEvents(events) {
    return events.filter((event) => event.type !== "progress" || ["tool/call", "tool/result", "tool/ptc-dispatch"].includes(event.rawType ?? "")).map((event) => {
        const data = record(event.data);
        const message = record(data.message);
        const content = Array.isArray(message.content) ? message.content : [];
        const toolResult = event.rawType === "tool/result" ? content.map(record).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : undefined;
        const argumentsText = typeof data.arguments === "string" ? data.arguments : data.arguments === undefined ? undefined : JSON.stringify(data.arguments);
        const fields = { text: event.text, arguments: argumentsText, result: toolResult, error: event.error };
        const truncatedFields = Object.entries(fields).filter(([, value]) => value && value.length > 2000).map(([key]) => key);
        return { seq: event.seq, requestId: event.requestId, turnId: event.turnId, type: event.type, rawType: event.rawType, timestamp: event.timestamp,
            name: typeof data.name === "string" ? data.name : undefined,
            callId: typeof data.callId === "string" ? data.callId : typeof message.toolCallId === "string" ? message.toolCallId : undefined,
            isError: typeof message.isError === "boolean" ? message.isError : undefined,
            text: clip(fields.text), arguments: clip(fields.arguments), result: clip(fields.result), error: clip(fields.error),
            endReason: typeof record(data.reason).kind === "string" ? record(data.reason).kind : undefined,
            artifacts: event.artifacts,
            ...(truncatedFields.length ? { truncatedFields, fullRecord: "deepseek_get_task detail=full" } : {}) };
    });
}
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function clip(value) { return value && value.length > 2000 ? `${value.slice(0, 2000)}\n[truncated]` : value; }
//# sourceMappingURL=deepseek-evidence.js.map