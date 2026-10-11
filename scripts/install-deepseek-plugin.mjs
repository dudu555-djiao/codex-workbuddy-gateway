#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argumentsList = process.argv.slice(2);
function option(name, fallback) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return fallback;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
const profile = option("--profile", "desktop");
const application = path.resolve(option("--app", "/Applications/DeepSeek Harness.app"));
if (!new Set(["desktop", "web"]).has(profile)) throw new Error("Supported profiles: desktop, web");
if (process.platform !== "darwin") throw new Error("This installer currently supports the macOS Harness App only");
const binary = path.join(application, "Contents/MacOS/DeepSeek Harness");
const cli = path.join(application, "Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js");
const plugin = path.join(root, "deepseek-plugin");
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8"));
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
const version = spawnSync(binary, ["--expose-internals", cli, "--version"], { env, encoding: "utf8" });
if (version.status !== 0) throw new Error(`Cannot run the selected App's CLI: ${version.stderr || version.error?.message}`);
const expected = manifest.peerDependencies?.["@deepseek-ai/dsh-api-session-controller"];
if (version.stdout.trim() !== expected) throw new Error(`Harness version ${version.stdout.trim()} is not the plugin's supported version ${expected}`);

const harnessHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
const profileDirectory = path.join(harnessHome, "profiles", profile);
const profileManifest = path.join(profileDirectory, "package.json");
if (!fs.existsSync(profileManifest)) throw new Error("Open the selected Harness profile once before installing its bridge");
const backup = path.join(harnessHome, "codex-bridge", "backups", `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
for (const filename of ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"]) {
  const source = path.join(profileDirectory, filename);
  if (fs.existsSync(source)) fs.writeFileSync(path.join(backup, filename), fs.readFileSync(source), { flag: "wx", mode: 0o600 });
}
const installation = spawnSync(binary, ["--expose-internals", cli, "plugin", "--profile", profile, "add", "--ignore-scripts", "--config.auto-install-peers=false", plugin], {
  env, cwd: root, stdio: "inherit",
});
if (installation.status !== 0) throw new Error(`Harness plugin install failed; previous profile files are backed up at ${backup}`);

// The native CLI owns the profile write lock and reconciles bundle activation.
// Read its committed result; never race its lock with a separate manifest edit.
const configured = JSON.parse(fs.readFileSync(profileManifest, "utf8"));
if (!Array.isArray(configured.dsh?.profile?.bundles)) throw new Error(`Profile has no bundle list; inspect the profile and backup at ${backup}`);
if (!configured.dsh.profile.bundles.includes(manifest.name)) {
  throw new Error(`The native installer did not activate ${manifest.name}. Enable the installed bundle in Harness Plugin Manager; existing profile configuration was not overwritten. Backup: ${backup}`);
}
console.log(JSON.stringify({ installed: true, profile, version: version.stdout.trim(), plugin: manifest.name, backup, next: "Reload this Harness profile while idle, then check deepseek_health." }));
