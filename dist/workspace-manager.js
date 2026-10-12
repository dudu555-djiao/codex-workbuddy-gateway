import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeDesktopRpcTrigger } from "./native-desktop-trigger.js";
import { readServiceRegistration, registeredServiceConfig } from "./persistent-service.js";
import { installService } from "./service-cli.js";
import { WorkspaceWorkers, readWorkspaceWorkers } from "./workspace-workers.js";
import { readDesktopSession } from "./desktop-runtime.js";
import { TaskStore } from "./task-store.js";
import { RunJournal, runsDirectory } from "./run-journal.js";
import fs from "node:fs";
export function workerRegistration(config) {
    const file = config.serviceConfigFile ?? path.join(path.dirname(config.dbFile), "persistent-service.json");
    const registration = readServiceRegistration(file);
    if (registration && path.resolve(registration.dbFile) !== path.resolve(config.dbFile))
        throw new Error("The persistent service uses another task database; fix the bridge configuration before connecting projects");
    return registration;
}
export async function ensureWorkspace(config, input) {
    if (config.backend !== "desktop-queue")
        throw new Error("Automatic native workspaces require desktop-queue");
    const registration = workerRegistration(config);
    const bound = registration ? registeredServiceConfig(config, registration) : config;
    const workers = new WorkspaceWorkers(bound);
    const trigger = new NativeDesktopRpcTrigger(bound, registration?.cdpPort ?? 18491);
    try {
        if (registration)
            workers.seed(registration);
        const result = await workers.ensure(input, {
            createWorker: (...args) => trigger.createWorker(...args),
            async setModel(sessionId, model) {
                // Configuration must not change the model underneath queued or unclosed attempts.
                const store = new TaskStore(bound.dbFile);
                try {
                    for (let offset = 0;; offset += 500) {
                        const tasks = store.listTasks({ limit: 500, offset });
                        for (const task of tasks) {
                            if (task.sessionId !== sessionId || !task.attemptId)
                                continue;
                            const journal = new RunJournal(runsDirectory(bound), task.attemptId), snapshot = journal.snapshot();
                            if (snapshot && (['queued', 'working'].includes(snapshot.status) || (!snapshot.stopReason && fs.existsSync(path.join(journal.dir, 'claim.json')))))
                                throw new Error('The session has queued or unfinished tasks; wait before changing its bound model, or bind another idle session');
                        }
                        if (tasks.length < 500)
                            break;
                    }
                }
                finally {
                    store.close();
                }
                return trigger.setModel(sessionId, model);
            },
        });
        if (!registration) {
            const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
            installService({ config, projectDir, workspace: result.worker.workspace, sessionId: result.worker.sessionId, cdpPort: 18491 });
        }
        return { ok: true, ...result, workspace: result.worker.workspace, sessionId: result.worker.sessionId, next: "Pass this workspace to send_task; the persistent service routes and wakes its native WorkBuddy session automatically." };
    }
    finally {
        workers.close();
        trigger.close();
    }
}
export async function listModels(config, sessionId) {
    if (config.backend !== "desktop-queue")
        throw new Error("Native model discovery requires desktop-queue");
    const registration = workerRegistration(config), bound = registration ? registeredServiceConfig(config, registration) : config;
    const trigger = new NativeDesktopRpcTrigger(bound, registration?.cdpPort ?? 18491);
    try {
        return { ok: true, ...await trigger.listModels(sessionId) };
    }
    finally {
        trigger.close();
    }
}
export function listWorkspaces(config) {
    const registration = workerRegistration(config);
    const bound = registration ? registeredServiceConfig(config, registration) : config;
    return readWorkspaceWorkers(bound, registration).map(worker => ({ ...worker, desktopRegistered: readDesktopSession(bound.workbuddyConfigDir, worker.sessionId).registered }));
}
//# sourceMappingURL=workspace-manager.js.map