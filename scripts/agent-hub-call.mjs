#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, argument = "{}"] = process.argv.slice(2);
if (!name || !name.startsWith("agent_hub_")) throw new Error("Usage: node scripts/agent-hub-call.mjs agent_hub_<tool> '<JSON>' (or @arguments.json)");
const parameters = JSON.parse(argument.startsWith("@") ? fs.readFileSync(argument.slice(1), "utf8") : argument);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "agent-hub-local-client", version: "0.7.0" });
const transport = new StdioClientTransport({ command: path.join(root, "bin/agent-hub-mcp"), cwd: root,
  env: Object.fromEntries(Object.entries(process.env).filter(entry => typeof entry[1] === "string")), stderr: "inherit" });
try {
  await client.connect(transport);
  const result = await client.callTool({ name, arguments: parameters }, undefined, { timeout: 120_000 });
  for (const block of result.content) if (block.type === "text") process.stdout.write(block.text + "\n");
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
