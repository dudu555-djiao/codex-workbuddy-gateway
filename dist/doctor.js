import fs from "node:fs";
import { loadConfig } from "./config.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
// This command intentionally sends no prompt, changes no desktop setting and
// prints no token, cookie, private workspace or session-file path.
const config = loadConfig();
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const nodeSupported = major > 22 || (major === 22 && minor >= 5);
const macOS = process.platform === "darwin";
const applicationPresent = fs.existsSync(config.cliElectronPath);
const desktopRoute = ["desktop-acp", "desktop-queue"].includes(config.backend);
const checks = { nodeSupported, macOS, applicationPresent, desktopRoute };
const nextSteps = [];
let online = false;
let ready = false;
let connectionStatus = "not_checked";
if (!nodeSupported)
    nextSteps.push("Install Node.js 22.5 or later, then build the project again.");
if (!macOS)
    nextSteps.push("This desktop setup is documented for macOS; verify platform support before continuing.");
if (!applicationPresent)
    nextSteps.push("Install WorkBuddy or configure WORKBUDDY_CLI_ELECTRON for its local application.");
if (!desktopRoute)
    nextSteps.push("Set WORKBUDDY_BACKEND=desktop-queue in the project .env and restart the MCP server.");
if (nodeSupported && macOS && applicationPresent && desktopRoute) {
    try {
        const result = await new WorkBuddyClient({ ...config, requestTimeoutMs: Math.min(config.requestTimeoutMs, 10_000) }).health();
        online = result.online;
        ready = result.ready === true;
        connectionStatus = online ? (ready ? "desktop_ready" : "connectable_unverified_desktop") : "offline";
        if (!online)
            nextSteps.push(config.backend === "desktop-queue" ? "Bootstrap the dedicated native WorkBuddy conversation to run bin/workbuddy-worker claim, then retry while it is waiting." : "Keep WorkBuddy logged in and open the intended desktop conversation, then retry this diagnostic.");
        else if (!ready)
            nextSteps.push("Verify that the intended interactive session is registered in WorkBuddy desktop before dispatching a task.");
    }
    catch {
        connectionStatus = "probe_failed";
        nextSteps.push("Retry with WorkBuddy running; inspect the local MCP health response for the connection error without sharing credentials.");
    }
}
console.log(JSON.stringify({
    ok: nodeSupported && macOS && applicationPresent && desktopRoute && online && ready,
    backend: config.backend,
    checks,
    online,
    ready,
    connectionStatus,
    taskSent: false,
    videoAcceptance: "pending_user_verification",
    nextSteps,
    note: "A successful health probe only confirms current connectivity, not task execution or video acceptance.",
}, null, 2));
process.exitCode = nodeSupported && macOS && applicationPresent && desktopRoute && online && ready ? 0 : 1;
//# sourceMappingURL=doctor.js.map