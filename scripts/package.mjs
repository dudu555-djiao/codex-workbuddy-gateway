#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const ROOT_FILES = new Set(["README.md", ".gitignore", ".env.example", "package.json", "package-lock.json", "tsconfig.json", "LICENSE"]);
const SKILL_FILES = ["skills/workbuddy-executor/SKILL.md", "skills/workbuddy-executor/agents/openai.yaml", "skills/workbuddy-executor/references/setup.md"];
const REQUIRED_FILES = ["README.md", ".env.example", "package.json", "package-lock.json", "tsconfig.json", "src/server.ts", "dist/server.js", "bin/workbuddy-gateway", "bin/workbuddy-worker", "dist/desktop-worker-cli.js", "bin/workbuddy-service", "src/persistent-service.ts", "src/service-cli.ts", "src/native-desktop-trigger.ts", "dist/persistent-service.js", "dist/service-cli.js", "dist/native-desktop-trigger.js", "docs/QUEUE_WORKER.md", "scripts/install-skill.mjs", ...SKILL_FILES];
const DIRECTORY_RULES = new Map([
  ["src", /\.ts$/],
  ["test", /\.test\.ts$/],
  ["docs", /^(?:video-explanation|FAILURE_REVIEW|USER_ACCEPTANCE|CODEX_WORKFLOW|QUEUE_WORKER)\.md$/],
  ["scripts", /^(?:package|install-skill)\.mjs$/],
  ["bin", /^workbuddy-(?:gateway|cli|doctor|worker|service)$/],
  ["dist", /\.(?:js|js\.map)$/],
  ["skills", /^(?:SKILL\.md|openai\.yaml|setup\.md)$/],
]);
const PRIVATE_DIRS = new Set(["data", "outputs", "node_modules", "work", "logs", ".git", ".workbuddy", ".codex"]);

function allowed(relative) {
  const segments = relative.split("/");
  if (segments.some((segment) => PRIVATE_DIRS.has(segment))) return false;
  if (segments.length === 1) return ROOT_FILES.has(relative);
  if (segments[0] === "skills") return SKILL_FILES.includes(relative);
  const rule = DIRECTORY_RULES.get(segments[0]);
  if (!rule || segments.slice(1).some((segment) => segment.startsWith("."))) return false;
  return rule.test(segments.at(-1));
}

/** A standalone skill archive contains instructions only, never a live MCP configuration. */
export async function createSkillPackage(sourceDir, outputDir, version) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Release version must be a safe semantic version.");
  sourceDir = path.resolve(sourceDir);
  outputDir = path.resolve(outputDir);
  const archive = path.join(outputDir, `workbuddy-executor-v${version}.zip`);
  const checksum = `${archive}.sha256`;
  await fs.mkdir(outputDir, { recursive: true });
  for (const filename of [archive, checksum]) {
    try { await fs.lstat(filename); throw new Error(`Refusing to overwrite release output: ${path.basename(filename)}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-skill-release-"));
  try {
    for (const relative of SKILL_FILES) {
      const filename = path.join(sourceDir, relative);
      if (!(await fs.lstat(filename)).isFile()) throw new Error(`Expected regular skill file: ${relative}`);
      const content = await fs.readFile(filename);
      assertSafeContent(relative, content.toString("utf8"));
      const target = path.join(stage, relative.slice("skills/".length));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { mode: 0o644 });
    }
    await execute("zip", ["-q", "-r", "-X", archive, "workbuddy-executor"], { cwd: stage });
    const digest = crypto.createHash("sha256").update(await fs.readFile(archive)).digest("hex");
    await fs.writeFile(checksum, `${digest}  ${path.basename(archive)}\n`, { flag: "wx" });
    return { archive, checksum, files: SKILL_FILES.length, sha256: digest };
  } catch (error) {
    await Promise.all([archive, checksum].map((filename) => fs.rm(filename, { force: true })));
    throw error;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

export async function collectReleaseFiles(sourceDir) {
  const files = [];
  async function visit(relative) {
    const full = path.join(sourceDir, relative);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Release allowlist contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(full)).sort()) {
        if (!name.startsWith(".") && !PRIVATE_DIRS.has(name)) await visit(path.posix.join(relative, name));
      }
    } else if (stat.isFile() && allowed(relative)) files.push(relative);
  }
  for (const name of [...ROOT_FILES, ...DIRECTORY_RULES.keys()].sort()) {
    try { await visit(name); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) throw new Error(`Missing release file ${required}; build the complete source project first.`);
  }
  return files.sort();
}

function assertSafeContent(relative, content) {
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/.test(content)) {
    throw new Error(`Possible access token in release file: ${relative}`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    throw new Error(`Private key in release file: ${relative}`);
  }
  if (/\/Users\/(?!example(?:\/|\b)|YOUR_NAME(?:\/|\b))[A-Za-z0-9._-]+\//.test(content) || /\/private\/var\/folders\//.test(content)) {
    throw new Error(`Private machine path in release file: ${relative}`);
  }
  if (relative === ".env.example") {
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:#\s*)?(WORKBUDDY_(?:CLIENT_SECRET|ACCESS_TOKEN|GATEWAY_PASSWORD))\s*=\s*(.*)$/);
      if (match && match[2].trim().replace(/^(?:""|'')$/, "")) throw new Error(`Nonempty secret in example configuration: ${match[1]}`);
    }
  }
}

export async function createPackage(sourceDir, outputDir, version) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Release version must be a safe semantic version.");
  sourceDir = path.resolve(sourceDir);
  outputDir = path.resolve(outputDir);
  const files = await collectReleaseFiles(sourceDir);
  const releaseName = `codex-workbuddy-gateway-v${version}`;
  const archive = path.join(outputDir, `${releaseName}.zip`);
  const manifestPath = path.join(outputDir, `${releaseName}.manifest.json`);
  const checksumPath = `${archive}.sha256`;
  await fs.mkdir(outputDir, { recursive: true });
  for (const target of [archive, manifestPath, checksumPath]) {
    try { await fs.lstat(target); throw new Error(`Refusing to overwrite release output: ${path.basename(target)}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-release-"));
  const entries = [];
  try {
    for (const relative of files) {
      const source = path.join(sourceDir, relative);
      const content = await fs.readFile(source);
      assertSafeContent(relative, content.toString("utf8"));
      const target = path.join(stage, releaseName, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { mode: relative.startsWith("bin/") ? 0o755 : 0o644 });
      entries.push({ path: relative, bytes: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    }
    const manifest = `${JSON.stringify({ project: "codex-workbuddy-gateway", version, videoAcceptance: "pending_user_verification", files: entries }, null, 2)}\n`;
    await fs.writeFile(path.join(stage, releaseName, "RELEASE_MANIFEST.json"), manifest);
    await execute("zip", ["-q", "-r", "-X", archive, releaseName], { cwd: stage });
    const digest = crypto.createHash("sha256").update(await fs.readFile(archive)).digest("hex");
    await fs.writeFile(manifestPath, manifest, { flag: "wx" });
    await fs.writeFile(checksumPath, `${digest}  ${path.basename(archive)}\n`, { flag: "wx" });
    return { archive, manifest: manifestPath, checksum: checksumPath, files: entries.length, sha256: digest };
  } catch (error) {
    await Promise.all([archive, manifestPath, checksumPath].map((filename) => fs.rm(filename, { force: true })));
    throw error;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(await fs.readFile(path.join(sourceDir, "package.json"), "utf8"));
  const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(sourceDir, "outputs", "release");
  const result = await createPackage(sourceDir, outputDir, pkg.version);
  const skill = await createSkillPackage(sourceDir, outputDir, pkg.version);
  console.log(JSON.stringify({ project: result, skill }, null, 2));
}
