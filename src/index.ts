import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { install, name, instructions } from "./platform.ts";
import { PublicSource } from "./source.ts";

export function handler(upstream: typeof fetch) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        name,
        instructions,
        transport: "streamable-http",
        endpoint: new URL("/mcp", url).href,
        repository: "https://github.com/oratis/" + name,
      });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin)
      return new Response("Untrusted origin", { status: 403 });
    if (request.method !== "POST") {
      return new Response("Use an MCP client to POST to /mcp.", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const server = new McpServer({ name, version: "0.1.0" }, { instructions });
    install(server, new PublicSource(upstream));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 65536,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}

export default {
  fetch(request: Request) {
    return handler(fetch)(request);
  },
};
