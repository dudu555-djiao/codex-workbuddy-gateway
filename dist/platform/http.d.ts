import http from "node:http";
import { HubEngine } from "./engine.js";
/** HTTP uses the same engine as the UI, SDK, CLI and MCP clients. */
export declare function createHubServer(engine: HubEngine, token: string): http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
