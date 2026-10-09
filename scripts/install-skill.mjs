#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "skills", "workbuddy-executor");
const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const parent = path.join(home, "skills");
const target = path.join(parent, "workbuddy-executor");
const files = ["SKILL.md", "agents/openai.yaml", "references/setup.md"];

// Explicit copy list prevents configuration, task history or local artifacts
// from entering a skill installation.
const contents = await Promise.all(files.map(async (name) => {
  const filename = path.join(source, name);
  if (!(await fs.lstat(filename)).isFile()) throw new Error(`Expected regular skill file: ${name}`);
  return { name, bytes: await fs.readFile(filename) };
}));
await fs.mkdir(parent, { recursive: true });
let exists = false;
try {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Existing skill target must be a regular directory");
  exists = true;
} catch (error) { if (error.code !== "ENOENT") throw error; }
if (exists) {
  const same = (await Promise.all(contents.map(async ({ name, bytes }) => {
    try { return bytes.equals(await fs.readFile(path.join(target, name))); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }))).every(Boolean);
  if (same) {
    console.log(JSON.stringify({ installed: true, unchanged: true, path: target }));
    process.exit(0);
  }
}
const stage = await fs.mkdtemp(path.join(parent, ".workbuddy-executor-install-"));
let backup;
try {
  for (const { name, bytes } of contents) {
    const filename = path.join(stage, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes, { flag: "wx", mode: 0o644 });
  }
  if (exists) {
    // Keep older instructions recoverable outside the discoverable skills tree.
    const backups = path.join(home, "skill-backups");
    await fs.mkdir(backups, { recursive: true });
    backup = await fs.mkdtemp(path.join(backups, "workbuddy-executor-"));
    await fs.rename(target, path.join(backup, "workbuddy-executor"));
  }
  try { await fs.rename(stage, target); }
  catch (error) {
    if (backup) await fs.rename(path.join(backup, "workbuddy-executor"), target);
    throw error;
  }
  console.log(JSON.stringify({ installed: true, path: target, backup }));
} finally { await fs.rm(stage, { recursive: true, force: true }); }
