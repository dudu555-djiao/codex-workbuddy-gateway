export interface StoredTokens {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scope?: string;
    openId?: string;
    tokenType?: string;
}
export declare class TokenStore {
    private readonly file;
    constructor(file: string);
    read(): Promise<StoredTokens | undefined>;
    write(tokens: StoredTokens): Promise<void>;
}
