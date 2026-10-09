import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectReleaseFiles, createPackage, createSkillPackage } from "../scripts/package.mjs";

const execute = promisify(execFile);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-package-test-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  const files: Record<string, string> = {
    "README.md": "# Fixture\n",
    ".env.example": "WORKBUDDY_BACKEND=desktop-acp\nWORKBUDDY_GATEWAY_PASSWORD=\n",
    ".gitignore": "data/\n.env\n",
    "package.json": JSON.stringify({ name: "codex-workbuddy-gateway", version: "0.2.0" }),
    "package-lock.json": "{}\n",
    "tsconfig.json": "{}\n",
    "src/server.ts": "export {};\n",
    "src/persistent-service.ts": "export {};\n",
    "src/service-cli.ts": "export {};\n",
    "src/native-desktop-trigger.ts": "export {};\n",
    "dist/server.js": "export {};\n",
    "dist/desktop-worker-cli.js": "export {};\n",
    "dist/persistent-service.js": "export {};\n",
    "dist/service-cli.js": "export {};\n",
    "dist/native-desktop-trigger.js": "export {};\n",
    "bin/workbuddy-gateway": "#!/bin/sh\nexit 0\n",
    "bin/workbuddy-worker": "#!/bin/sh\nexit 0\n",
    "bin/workbuddy-service": "#!/bin/sh\nexit 0\n",
    "docs/QUEUE_WORKER.md": "# Queue\n",
    "docs/USER_ACCEPTANCE.md": "# Pending\n",
    "docs/CODEX_WORKFLOW.md": "# Supervision\n",
    "scripts/package.mjs": "// Fixture packaging source\n",
    "scripts/install-skill.mjs": "// Fixture installer\n",
    "skills/workbuddy-executor/SKILL.md": "---\nname: workbuddy-executor\ndescription: Delegate to desktop WorkBuddy.\n---\n# Skill\n",
    "skills/workbuddy-executor/agents/openai.yaml": "interface:\n  display_name: WorkBuddy\n",
    "skills/workbuddy-executor/references/setup.md": "# Setup\n",
    "skills/workbuddy-executor/private-log.md": "private task history\n",
    "skills/unrelated/SKILL.md": "unrelated personal skill\n",
    ".env": "private configuration\n",
    "data/tasks.sqlite": "private database\n",
    "data/runs/run.json": "private execution events\n",
    "data/persistent-service.json": "private worker session registration\n",
    "data/persistent-service-status.json": "private daemon heartbeat\n",
    "data/service-logs/stdout.log": "private daemon logs\n",
    "docs/private-log.md": "private notes\n",
    "src/private.log": "private log\n",
    "outputs/old.zip": "private archive\n",
    "node_modules/private/index.js": "private dependency\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(source, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return { root, source, output };
}

test("release archive uses a file allowlist and hashes every included file", async () => {
  const value = await fixture();
  try {
    const selected = await collectReleaseFiles(value.source);
    assert.ok(selected.includes("src/server.ts"));
    assert.ok(selected.includes(".env.example"));
    assert.ok(selected.includes("docs/CODEX_WORKFLOW.md"));
    assert.ok(selected.includes("bin/workbuddy-worker"));
    assert.ok(selected.includes("dist/desktop-worker-cli.js"));
    for (const filename of ["bin/workbuddy-service", "dist/persistent-service.js", "dist/service-cli.js", "dist/native-desktop-trigger.js"]) assert.ok(selected.includes(filename));
    assert.ok(selected.includes("docs/QUEUE_WORKER.md"));
    assert.ok(!selected.some((name: string) => /^(?:data|outputs|node_modules)\//.test(name)));
    assert.ok(!selected.includes(".env"));
    assert.ok(!selected.includes("docs/private-log.md"));
    assert.ok(!selected.includes("src/private.log"));
    assert.ok(selected.includes("skills/workbuddy-executor/SKILL.md"));
    assert.ok(!selected.includes("skills/workbuddy-executor/private-log.md"));
    assert.ok(!selected.includes("skills/unrelated/SKILL.md"));

    const result = await createPackage(value.source, value.output, "0.2.0");
    const listing = (await execute("unzip", ["-Z1", result.archive])).stdout.split("\n");
    const prefix = "codex-workbuddy-gateway-v0.2.0/";
    const files = listing.filter((name) => name && !name.endsWith("/")).map((name) => name.slice(prefix.length));
    assert.deepEqual(files.sort(), [...selected, "RELEASE_MANIFEST.json"].sort());
    const manifest = JSON.parse(await fs.readFile(result.manifest, "utf8"));
    assert.equal(manifest.videoAcceptance, "pending_user_verification");
    for (const entry of manifest.files) {
      const bytes = await fs.readFile(path.join(value.source, entry.path));
      assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
      assert.equal(entry.bytes, bytes.length);
    }
    const digest = crypto.createHash("sha256").update(await fs.readFile(result.archive)).digest("hex");
    assert.equal(result.sha256, digest);
    assert.equal(await fs.readFile(result.checksum, "utf8"), `${digest}  ${path.basename(result.archive)}\n`);
    await assert.rejects(createPackage(value.source, value.output, "0.2.0"), /overwrite/);
    assert.ok((await fs.stat(result.archive)).size > 0);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("release collection requires the persistent service wrapper and complete native runtime", async () => {
  const value = await fixture();
  try {
    for (const relative of ["bin/workbuddy-service", "dist/persistent-service.js", "dist/service-cli.js", "dist/native-desktop-trigger.js"]) {
      const filename = path.join(value.source, relative);
      const content = await fs.readFile(filename);
      await fs.rm(filename);
      await assert.rejects(collectReleaseFiles(value.source), new RegExp(`Missing release file ${relative.replaceAll(".", "\\.")}`));
      await fs.writeFile(filename, content);
    }
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("standalone skill archive contains only the three portable instruction files", async () => {
  const value = await fixture();
  try {
    const result = await createSkillPackage(value.source, value.output, "0.3.1");
    const listing = (await execute("unzip", ["-Z1", result.archive])).stdout.split("\n").filter((name) => name && !name.endsWith("/"));
    assert.deepEqual(listing.sort(), ["workbuddy-executor/SKILL.md", "workbuddy-executor/agents/openai.yaml", "workbuddy-executor/references/setup.md"].sort());
    assert.equal(result.sha256, crypto.createHash("sha256").update(await fs.readFile(result.archive)).digest("hex"));
    await assert.rejects(createSkillPackage(value.source, value.output, "0.3.1"), /overwrite/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("release collection rejects symlinks so files cannot escape the allowlist", async () => {
  const value = await fixture();
  try {
    await fs.symlink(path.join(value.source, ".env"), path.join(value.source, "src", "leak.ts"));
    await assert.rejects(collectReleaseFiles(value.source), /symbolic link/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("release refuses a populated example secret and removes partial output", async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.source, ".env.example"), "WORKBUDDY_GATEWAY_PASSWORD=private-value\n");
    await assert.rejects(createPackage(value.source, value.output, "0.2.0"), /Nonempty secret/);
    assert.deepEqual(await fs.readdir(value.output), []);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("release refuses token-like content in an allowed source file", async () => {
  const value = await fixture();
  try {
    const token = ["ghp", "x".repeat(30)].join("_");
    await fs.writeFile(path.join(value.source, "src/server.ts"), `export const example = "${token}";\n`);
    await assert.rejects(createPackage(value.source, value.output, "0.2.0"), /Possible access token/);
    assert.deepEqual(await fs.readdir(value.output), []);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});
