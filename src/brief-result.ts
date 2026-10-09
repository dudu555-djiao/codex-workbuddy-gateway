export type ResultDetail = "full" | "brief";
export interface BriefResultOptions { messageAttemptId?: string }

const REPORT_LIMIT = 2_000;
const TRUNCATION_MARKER = "\n[Truncated; request detail: full for the complete report.]";
const FULL_DETAIL_HINT = "Use detail: full with workbuddy_get_task or workbuddy_get_messages for complete records. A brief report is not independent acceptance evidence.";
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function pick(value: RecordValue, fields: readonly string[]): RecordValue {
  return Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
}
function paths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function messageText(value: RecordValue): string {
  return Array.isArray(value.content) ? value.content.map((part) => typeof part === "string" ? part : String(record(part)?.text ?? "")).join("") : "";
}
function matchingMessages(messages: RecordValue[], attemptId: unknown): RecordValue[] {
  return messages.filter((message) => {
    const sourceAttempt = record(message.metadata)?.attemptId;
    return sourceAttempt === undefined || attemptId === undefined || sourceAttempt === attemptId;
  });
}
function latestMessage(messages: RecordValue[]): RecordValue | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user" && messageText(message).trim()) return message;
  }
  return undefined;
}
function shortReport(text: string, identity: RecordValue): RecordValue {
  const reportTruncated = text.length > REPORT_LIMIT;
  return { ...identity, text: reportTruncated ? text.slice(0, REPORT_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER : text, reportTruncated };
}
function messageReport(message: RecordValue, fallback: RecordValue = {}): RecordValue {
  const metadata = record(message.metadata) ?? {};
  return shortReport(messageText(message), {
    ...pick(fallback, ["attemptId", "sessionId", "runtimeSource"]),
    ...pick(metadata, ["attemptId", "sessionId", "runtimeSource", "status", "eventSeq"]),
    messageId: message.message_id, reportKind: metadata.type,
  });
}
function briefTask(value: RecordValue, messages: RecordValue[] = []): RecordValue {
  const result = pick(value, ["taskId", "attemptId", "attempt", "sessionId", "runtimeSource", "state", "lastEventSeq", "lastMessageId", "workspace", "createdAt", "updatedAt", "blockingReason", "cancelNote", "reviewNote", "reviewedAt"]);
  const currentMessages = matchingMessages(messages, value.attemptId);
  // Paths are never clipped. Do not attribute earlier-attempt paths to this task.
  result.artifacts = [...new Set([...paths(value.artifacts), ...currentMessages.flatMap((message) => paths(record(message.metadata)?.artifacts))])];
  const latest = latestMessage(currentMessages);
  const report = record(value.report);
  if (latest) result.latestReport = messageReport(latest, value);
  else if (typeof report?.rawText === "string") result.latestReport = shortReport(report.rawText, { ...pick(value, ["attemptId", "sessionId", "runtimeSource"]), status: report.status, reportKind: "result" });
  return result;
}

/** Presentation only: full returns the original result; brief never edits durable records. */
export function resultForDetail(value: unknown, detail: ResultDetail = "full", options: BriefResultOptions = {}): unknown {
  if (detail === "full") return value;
  const input = record(value);
  if (!input) return value;
  const result = pick(input, ["ok", "error", "created", "taskId", "attemptId", "attempt", "sessionId", "runtimeSource", "state", "lastEventSeq", "artifacts", "artifactPaths", "blockingReason", "message", "next", "acceptance", "cancellationRequested", "remoteStopped", "backend", "online", "desktopSupervision", "ready", "status", "sessions", "workerCandidates", "persistentService"]);
  const messages = Array.isArray(input.messages) ? input.messages.map(record).filter((item): item is RecordValue => item !== undefined) : [];
  const task = record(input.task);
  const historicalMessages = options.messageAttemptId !== undefined && options.messageAttemptId !== task?.attemptId;
  if (task) result.task = briefTask(task, historicalMessages ? [] : messages);
  if (Array.isArray(input.tasks)) result.tasks = input.tasks.map((item) => record(item) ? briefTask(record(item)!) : item);
  if (options.messageAttemptId !== undefined) result.selectedAttemptId = options.messageAttemptId;
  if (historicalMessages || (!task && messages.length)) {
    const selected = matchingMessages(messages, options.messageAttemptId);
    const latest = latestMessage(selected);
    if (latest) result.latestReport = messageReport(latest, { attemptId: options.messageAttemptId });
    result.artifacts = [...new Set([...paths(input.artifacts), ...selected.flatMap((message) => paths(record(message.metadata)?.artifacts))])];
  }
  return { ...result, detail: "brief", fullDetail: FULL_DETAIL_HINT };
}
