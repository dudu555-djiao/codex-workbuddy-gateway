export interface DesktopSessionEvidence {
    registered: boolean;
    isPlayground?: boolean;
    cwd?: string;
    reason?: string;
}
export declare function listDesktopSessions(configDir: string, limit?: number): Array<{
    sessionId: string;
    workspace?: string;
}>;
/** Read native desktop registration; never create or repair WorkBuddy database rows. */
export declare function readDesktopSession(configDir: string, sessionId: string): DesktopSessionEvidence;
export declare function waitForDesktopSession(configDir: string, sessionId: string, timeoutMs?: number): Promise<DesktopSessionEvidence>;
