import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { HubEngine, artifactFor } from "./engine.js";
import { HubError, waitingStates } from "./contracts.js";
import { dashboardHtml } from "./ui.js";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new HubError("CONTENT_TYPE", "Use application/json", 415);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 1_048_576) throw new HubError("BODY_TOO_LARGE", "Request exceeds 1 MiB", 413); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HubError("INVALID_JSON", "Request body must be JSON"); }
}
function sameSecret(value: string | undefined, token: string) { return Boolean(value && Buffer.byteLength(value) === Buffer.byteLength(token) && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token))); }
function cursor(value: string | null | undefined): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HubError("INVALID_CURSOR", "Cursor must be a nonnegative integer");
  return Number(value);
}

/** HTTP uses the same engine as the UI, SDK, CLI and MCP clients. */
export function createHubServer(engine: HubEngine, token: string) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    try {
      const address = server.address();
      const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
      if (req.headers.host !== host) throw new HubError("INVALID_HOST", "Use the configured loopback address", 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new HubError("INVALID_ORIGIN", "Cross-origin access is disabled", 403);
      const url = new URL(req.url ?? "/", `http://${host}`);
      const dashboardNavigation = req.method === "GET" && url.pathname === "/" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
      if (req.headers["sec-fetch-site"] === "cross-site" && !dashboardNavigation) throw new HubError("INVALID_ORIGIN", "Cross-site access is disabled", 403);
      if (req.method === "GET" && url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": `agent_hub=${token}; HttpOnly; SameSite=Strict; Path=/` }); res.end(dashboardHtml()); return;
      }
      const cookie = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("agent_hub="))?.slice("agent_hub=".length);
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
      if (!sameSecret(bearer, token) && !sameSecret(cookie, token)) throw new HubError("UNAUTHORIZED", "A local Agent Hub Bearer token is required", 401);
      const segments = url.pathname.split("/").filter(Boolean).map(item => decodeURIComponent(item));
      if (req.method === "GET" && url.pathname === "/v1/health") { json(res, 200, { status: "ok", version: "0.7.0", maxConcurrent: engine.maxConcurrent, capacityScope: "platform_runs", creditUsage: "unavailable" }); return; }
      if (req.method === "GET" && url.pathname === "/v1/providers") { json(res, 200, { providers: await engine.describeProviders() }); return; }
      if(segments[0]==='v1'&&segments[1]==='providers'&&segments[2]&&segments.length===4){
        const provider=engine.provider(segments[2]);
        if(req.method==='GET'&&segments[3]==='models'&&provider.models){json(res,200,await provider.models(url.searchParams.get('sessionId')??undefined));return;}
        if(req.method==='GET'&&segments[3]==='workspaces'&&provider.workspaces){json(res,200,await provider.workspaces());return;}
        if(req.method==='POST'&&segments[3]==='workspaces'&&provider.bindWorkspace){
          const input=z.object({workspace:z.string().min(1),sessionId:z.string().trim().min(1).optional(),model:z.string().trim().min(1).optional(),title:z.string().min(1).max(200).optional()}).strict().parse(await body(req));
          json(res,200,await engine.exclusive(()=>provider.bindWorkspace!(input)));return;
        }
      }
      if (url.pathname === "/v1/runs" && req.method === "POST") { const result = engine.submit(await body(req)); json(res, result.created ? 202 : 200, result); return; }
      if (url.pathname === "/v1/runs" && req.method === "GET") { json(res, 200, { runs: engine.store.list(Math.min(cursor(url.searchParams.get("limit")) || 50, 100), cursor(url.searchParams.get("offset"))) }); return; }
      if (segments[0] !== "v1" || segments[1] !== "runs" || !segments[2]) throw new HubError("NOT_FOUND", "Unknown endpoint", 404);
      const id = segments[2]; const run = engine.get(id); const action = segments[3];
      if (req.method === "GET" && segments.length === 3) { json(res, 200, run); return; }
      if (req.method === "GET" && action === "events" && segments.length === 4) { json(res, 200, { events: engine.store.events(id, cursor(url.searchParams.get("after")), 100) }); return; }
      if (req.method === "GET" && action === "wait" && segments.length === 4) {
        const seconds = Math.min(cursor(url.searchParams.get("timeoutSeconds")) || 45, 50);
        const until = Date.now() + seconds * 1000;
        const timer = setInterval(() => {
          const current = engine.get(id);
          if (!waitingStates.has(current.status) || Date.now() >= until) { clearInterval(timer); json(res, 200, current); }
        }, 200);
        res.on("close", () => clearInterval(timer));
        if (!waitingStates.has(run.status)) { clearInterval(timer); json(res, 200, run); }
        return;
      }
      if (req.method === "GET" && action === "stream" && segments.length === 4) {
        let after = cursor(url.searchParams.get("after") ?? String(req.headers["last-event-id"] ?? "0"));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        let lastHeartbeat = Date.now();
        const send = () => {
          for (const event of engine.store.events(id, after, 100)) { after = event.id; res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
          if (Date.now() - lastHeartbeat >= 15_000) { res.write(": heartbeat\n\n"); lastHeartbeat = Date.now(); }
        };
        send(); const timer = setInterval(send, 300); res.on("close", () => clearInterval(timer)); return;
      }
      if (req.method === "GET" && action === "artifacts" && segments.length === 5) {
        if (!/^\d+$/.test(segments[4]!)) throw new HubError("NOT_FOUND", "Unknown artifact", 404);
        const artifact = run.result?.artifacts[Number(segments[4])];
        if (!artifact) throw new HubError("NOT_FOUND", "Unknown artifact", 404);
        const current = artifactFor(run, artifact.path);
        const file = fs.openSync(current.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(file);
        if (!stat.isFile()) { fs.closeSync(file); throw new HubError("INVALID_ARTIFACT", "Artifact is no longer a file", 409); }
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": stat.size, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(current.name)}`, "cache-control": "no-store" });
        const stream = fs.createReadStream(current.path, { fd: file, autoClose: true }); stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res); return;
      }
      if (req.method === "POST" && segments.length === 4) {
        const raw = await body(req);
        if (action === "cancel") { z.object({}).strict().parse(raw); json(res, 200, await engine.cancel(id)); return; }
        if (action === "rework") { const input = z.object({ feedback: z.string().trim().min(1).max(100_000), model:z.string().trim().min(1).optional() }).strict().parse(raw); json(res, 202, await engine.rework(id, input.feedback,input.model)); return; }
        if (action === "accept") { const input = z.object({ note: z.string().trim().min(1).max(4000), evidence: z.array(z.string().trim().min(1).max(4000)).min(1).max(100) }).strict().parse(raw); json(res, 200, await engine.accept(id, input)); return; }
      }
      throw new HubError("NOT_FOUND", "Unknown endpoint or method", 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HubError ? error.httpStatus : error instanceof z.ZodError || error instanceof URIError || (error as NodeJS.ErrnoException).code === "ENOENT" ? 400 : 500;
      json(res, status, { error: { code: error instanceof HubError ? error.code : status === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) } });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return server;
}
