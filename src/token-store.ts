import fs from "node:fs/promises";
import path from "node:path";

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  openId?: string;
  tokenType?: string;
}

export class TokenStore {
  constructor(private readonly file: string) {}

  async read(): Promise<StoredTokens | undefined> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredTokens>;
      if (typeof parsed.accessToken !== "string" || !parsed.accessToken) return undefined;
      return parsed as StoredTokens;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Unable to read token file ${this.file}: ${String(error)}`);
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600);
  }
}
