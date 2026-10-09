import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/task-store.js";
test("persists task identity, idempotency, messages, and state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-gateway-"));
    const store = new TaskStore(path.join(dir, "tasks.sqlite"));
    const first = store.createOrGet({ taskId: "task-1", messageId: "msg-1", objective: "demo", state: "working" });
    const second = store.createOrGet({ taskId: "task-1", messageId: "msg-2", objective: "duplicate", state: "working" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.task.messageId, "msg-1");
    assert.equal(store.addMessages("task-1", [{ message_id: "msg-2", role: "assistant", content: ["done"] }]), 1);
    assert.equal(store.addMessages("task-1", [{ message_id: "msg-2", role: "assistant", content: ["done"] }]), 0);
    const updated = store.update("task-1", { state: "completed", lastMessageId: "msg-2" });
    assert.equal(updated.state, "completed");
    assert.equal(store.listMessages("task-1")[0]?.message_id, "msg-2");
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
//# sourceMappingURL=task-store.test.js.map