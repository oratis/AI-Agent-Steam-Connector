import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(
  process.argv[2] ?? "https://steam-mcp.oratisoratisoratisoratis.workers.dev/mcp"
);
const client = new Client({ name: "connector-smoke", version: "1" });

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, name + " failed: " + JSON.stringify(response.content));
  assert.ok(response.structuredContent, name + " returned no structured data");
  console.log("OK", name);
  return response.structuredContent;
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  assert.equal(client.getServerVersion()?.name, "ai-agent-steam-connector");
  assert.equal(client.getServerVersion()?.title, "AI Agent Steam Connector");
  const { tools } = await client.listTools();
  console.log(endpoint.href, tools.map((t) => t.name).join(", "));
  const list = await call("search_store", { query: "Portal 2" });
  assert.ok(list.games.some((g) => g.app_id === 620));
  const game = await call("game_details", { app_id: 620 });
  assert.equal(game.name, "Portal 2");
  const players = await call("current_players", { app_id: 620 });
  assert.ok(players.current_players >= 0);
  const news = await call("game_news", { app_id: 620, limit: 1 });
  assert.ok(news.items.length === 1);
  const profile = await call("public_profile", { steam_id: "76561197960287930" });
  assert.equal(profile.steam_id, "76561197960287930");
} finally {
  await client.close();
}
