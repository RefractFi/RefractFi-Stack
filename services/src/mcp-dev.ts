// Local MCP server for testing: bun --env-file=../.env src/mcp-dev.ts
import { fetchHandler } from "./mcp-server";

Bun.serve({ port: 8790, fetch: fetchHandler });
console.log("[mcp] http://localhost:8790/");
