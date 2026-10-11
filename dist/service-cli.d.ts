import { type Config } from "./config.js";
import { type ServiceRegistration } from "./persistent-service.js";
interface CommandResult {
    status: number;
    stdout: string;
    stderr?: string;
}
export type LaunchctlRunner = (args: string[]) => CommandResult;
export declare function launchdPlist(registration: ServiceRegistration, configFile: string): string;
export interface InstallServiceOptions {
    config: Config;
    sessionId: string;
    workspace: string;
    projectDir: string;
    nodeBin?: string;
    cdpPort: number;
    intervalMs?: number;
    /** Explicit test/platform injection; production uses the actual macOS account. */
    platform?: NodeJS.Platform;
    homeDir?: string;
    uid?: number;
}
export declare function installService(options: InstallServiceOptions, run?: LaunchctlRunner): {
    ok: true;
    registration: ServiceRegistration;
    configFile: string;
    restartWorkBuddyRequired: boolean;
};
export declare function serviceStatus(configFile: string, run?: LaunchctlRunner, uid?: number | undefined): Record<string, unknown>;
export declare function uninstallService(configFile: string, run?: LaunchctlRunner, uid?: number | undefined): Record<string, unknown>;
export {};
