import type { Config } from "./config.js";
import type { NativeDesktopTrigger } from "./persistent-service.js";
export declare const RENDERER_BRIDGE: string;
export interface NativeDesktopProcessControl {
    run(file: string, args: string[], timeoutMs: number): string;
    launch(executable: string, cdpPort: number): void;
    pause(milliseconds: number): Promise<void>;
}
export declare class NativeDesktopRpcTrigger implements NativeDesktopTrigger {
    private readonly config;
    readonly cdpPort: number;
    private readonly autoLaunch;
    private readonly processControl;
    private socket?;
    private sequence;
    private pending;
    private connection?;
    constructor(config: Config, cdpPort: number, autoLaunch?: boolean, processControl?: NativeDesktopProcessControl);
    private portState;
    private ownerIsNative;
    private nativePids;
    private rootPidExists;
    private canEnablePortWithoutInterruptingWork;
    private discover;
    private connect;
    private evaluateConnected;
    private call;
    createWorker(workspace: string, sessionId: string, title?: string): Promise<{
        sessionId: string;
        workspace: string;
    }>;
    inspect(sessionId: string): ReturnType<NativeDesktopTrigger["inspect"]>;
    findWake(sessionId: string, wakeId: string): Promise<boolean>;
    wakeIdle(sessionId: string, wakeId: string, prompt: string): ReturnType<NativeDesktopTrigger["wakeIdle"]>;
    close(): void;
}
export declare function createNativeDesktopTrigger(config: Config, options: {
    cdpPort: number;
}): NativeDesktopRpcTrigger;
