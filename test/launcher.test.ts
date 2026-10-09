import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("all Node launchers load the shipped example config even without node on desktop PATH", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-launcher-"));
  const root = path.join(temporary, "fresh install with spaces");
  try {
    await fs.mkdir(path.join(root, "bin"), { recursive: true });
    await fs.mkdir(path.join(root, "dist"));
    const nodePath = path.join(temporary, "node with spaces");
    await fs.symlink(process.execPath, nodePath);
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(path.join(root, ".env"), (await fs.readFile(path.join(source, ".env.example"), "utf8")) + `\nWORKBUDDY_NODE_BIN=${quote(nodePath)}\n`);
    for (const [launcher, script] of [["gateway", "server"], ["worker", "desktop-worker-cli"], ["doctor", "doctor"], ["service", "service-cli"]]) {
      const filename = path.join(root, "bin", `workbuddy-${launcher}`);
      await fs.copyFile(path.join(source, "bin", `workbuddy-${launcher}`), filename);
      await fs.chmod(filename, 0o755);
      await fs.writeFile(path.join(root, "dist", `${script}.js`), "console.log(JSON.stringify({backend:process.env.WORKBUDDY_BACKEND,scopes:process.env.WORKBUDDY_OAUTH_SCOPES,cwd:process.cwd(),args:process.argv.slice(2)}));\n");
      const args = launcher === "worker" ? ["claim", "--session-id", "test-session"] : launcher === "service" ? ["status", "--config", path.join(root, "data", "persistent-service.json")] : [];
      const result = await execute(filename, args, { cwd: temporary, env: { PATH: "/usr/bin:/bin" } });
      const actual = JSON.parse(result.stdout);
      assert.equal(actual.backend, "desktop-queue");
      assert.equal(actual.scopes, "user.localassistant.invokable user.localassistant.readable");
      assert.equal(actual.cwd, await fs.realpath(root));
      assert.deepEqual(actual.args, args);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
