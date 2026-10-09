import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export function listDesktopSessions(configDir, limit = 20) {
    let database;
    try {
        const filename = path.join(configDir, "workbuddy.db");
        if (!fs.existsSync(filename))
            return [];
        database = new DatabaseSync(filename, { readOnly: true });
        return database.prepare("SELECT id, cwd FROM sessions WHERE deleted_at IS NULL ORDER BY rowid DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 100)).map((row) => ({ sessionId: String(row.id), workspace: typeof row.cwd === "string" ? row.cwd : undefined }));
    }
    catch {
        return [];
    }
    finally {
        database?.close();
    }
}
/** Read native desktop registration; never create or repair WorkBuddy database rows. */
export function readDesktopSession(configDir, sessionId) {
    const filename = path.join(configDir, "workbuddy.db");
    if (!fs.existsSync(filename))
        return { registered: false, reason: "WorkBuddy desktop history database was not found" };
    let database;
    try {
        database = new DatabaseSync(filename, { readOnly: true });
        const row = database.prepare("SELECT cwd, is_playground, deleted_at FROM sessions WHERE id = ?").get(sessionId);
        if (!row || row.deleted_at !== null)
            return { registered: false, reason: "The session is not registered in WorkBuddy desktop history" };
        return { registered: true, isPlayground: Number(row.is_playground) === 1, cwd: typeof row.cwd === "string" ? row.cwd : undefined };
    }
    catch {
        return { registered: false, reason: "WorkBuddy desktop history could not be verified; this version may use an incompatible schema" };
    }
    finally {
        database?.close();
    }
}
export async function waitForDesktopSession(configDir, sessionId, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const evidence = readDesktopSession(configDir, sessionId);
        if (evidence.registered || Date.now() >= deadline)
            return evidence;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
}
//# sourceMappingURL=desktop-runtime.js.map