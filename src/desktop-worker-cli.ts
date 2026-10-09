import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { DesktopQueue } from "./desktop-queue.js";

try {
  const parsed = parseArgs({ allowPositionals: true, options: {
    "session-id": { type: "string" }, "attempt-id": { type: "string" }, "lease-token": { type: "string" },
    "wait-seconds": { type: "string" }, status: { type: "string" }, text: { type: "string" }, artifacts: { type: "string" },
  } });
  const [action] = parsed.positionals;
  const required = (name: keyof typeof parsed.values) => { const value = parsed.values[name]; if (typeof value !== "string" || !value) throw new Error(`Missing --${name}`); return value; };
  const queue = new DesktopQueue(loadConfig());
  const sessionId = required("session-id");
  let result: unknown;
  if (action === "bootstrap") result = queue.prepare(sessionId);
  else if (action === "claim") {
    const seconds = Number(parsed.values["wait-seconds"] ?? "50");
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 55) throw new Error("wait-seconds must be between 0 and 55");
    result = await queue.claim(sessionId, seconds);
  } else if (action === "report" || action === "progress") {
    const base = { sessionId, attemptId: required("attempt-id"), leaseToken: required("lease-token"), text: required("text") };
    if (action === "progress") result = queue.progress(base);
    else {
      const status = required("status");
      if (!["completed", "blocked", "failed", "cancelled"].includes(status)) throw new Error("Report status must be completed, blocked, failed or cancelled");
      const artifacts = JSON.parse(parsed.values.artifacts ?? "[]") as unknown;
      if (!Array.isArray(artifacts) || !artifacts.every((item) => typeof item === "string")) throw new Error("artifacts must be a JSON array of actual paths");
      result = queue.report({ ...base, status: status as "completed" | "blocked" | "failed" | "cancelled", artifacts });
    }
  } else throw new Error("Use bootstrap, claim, progress or report");
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
