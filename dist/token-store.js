import fs from "node:fs/promises";
import path from "node:path";
export class TokenStore {
    file;
    constructor(file) {
        this.file = file;
    }
    async read() {
        try {
            const raw = await fs.readFile(this.file, "utf8");
            const parsed = JSON.parse(raw);
            if (typeof parsed.accessToken !== "string" || !parsed.accessToken)
                return undefined;
            return parsed;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw new Error(`Unable to read token file ${this.file}: ${String(error)}`);
        }
    }
    async write(tokens) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, this.file);
        await fs.chmod(this.file, 0o600);
    }
}
//# sourceMappingURL=token-store.js.map