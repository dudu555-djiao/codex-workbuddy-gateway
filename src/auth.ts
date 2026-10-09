import http from "node:http";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { loadConfig, requireOAuthConfig } from "./config.js";
import { WorkBuddyClient } from "./workbuddy-client.js";

const config = loadConfig();
const { clientId } = requireOAuthConfig(config);
const state = crypto.randomBytes(24).toString("hex");
const redirect = new URL(config.oauthRedirectUri);
const authorize = new URL(`${config.apiBaseUrl}/authorize`);
authorize.searchParams.set("response_type", "code");
authorize.searchParams.set("client_id", clientId);
authorize.searchParams.set("redirect_uri", config.oauthRedirectUri);
authorize.searchParams.set("scope", config.oauthScopes);
authorize.searchParams.set("state", state);

const client = new WorkBuddyClient(config);
let finished = false;
const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${config.oauthPort}`}`);
  if (requestUrl.pathname !== redirect.pathname) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (requestUrl.searchParams.get("state") !== state) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid OAuth state");
    return;
  }
  const error = requestUrl.searchParams.get("error");
  const code = requestUrl.searchParams.get("code");
  if (error || !code) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Authorization failed: ${error ?? "missing code"}`);
    await finish(1);
    return;
  }
  try {
    await client.exchangeAuthorizationCode(code, config.oauthRedirectUri);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>WorkBuddy authorization complete</h1><p>You can close this tab and return to Codex.</p>");
    console.error(`Saved WorkBuddy tokens to ${config.tokenFile}`);
    await finish(0);
  } catch (exchangeError) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Token exchange failed: ${String(exchangeError)}`);
    console.error(exchangeError);
    await finish(1);
  }
});

server.listen(config.oauthPort, "127.0.0.1", () => {
  console.error(`Open this URL to authorize WorkBuddy:\n${authorize.toString()}`);
  if (process.platform === "darwin") execFile("open", [authorize.toString()]);
});

async function finish(code: number): Promise<void> {
  if (finished) return;
  finished = true;
  server.close(() => process.exit(code));
}
