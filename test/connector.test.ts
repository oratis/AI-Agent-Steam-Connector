import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handler } from "../src/index.ts";
import { name } from "../src/platform.ts";

export async function withClient(upstream: typeof fetch, run: (client: Client) => Promise<void>) {
  const serve = handler(upstream);
  const client = new Client({ name: "test-client", version: "1" });
  const endpoint = new URL("https://test.invalid/mcp");
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: (url, init) => serve(new Request(url, init)),
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, name);
    await run(client);
  } finally {
    await client.close();
  }
}

test("remote SDK client negotiates and discovers read-only tools without platform calls", async () => {
  await withClient(
    () => {
      throw new Error("unexpected fetch");
    },
    async (client) => {
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 3);
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
    }
  );
});

test("HTTP routing rejects foreign origins and does not open idle streams", async () => {
  const serve = handler(fetch);
  const endpoint = "https://test.invalid/mcp";
  assert.equal(
    (
      await serve(
        new Request(endpoint, { method: "POST", headers: { origin: "https://other.invalid" } })
      )
    ).status,
    403
  );
  assert.equal((await serve(new Request(endpoint))).status, 405);
  assert.equal((await serve(new Request(endpoint + "/bad"))).status, 404);
});

test("invalid arguments are rejected before querying the platform", async () => {
  let calls = 0;
  await withClient(
    async () => {
      calls++;
      return new Response();
    },
    async (client) => {
      const response = await client.callTool({
        name: "game_details",
        arguments: { app_id: "../../bad" },
      });
      assert.equal(response.isError, true);
      assert.equal(calls, 0);
    }
  );
});

test("upstream throttling is actionable and does not echo the body", async () => {
  await withClient(
    async () => new Response("debug details", { status: 429 }),
    async (client) => {
      const response = await client.callTool({ name: "game_details", arguments: { app_id: 620 } });
      assert.equal(response.isError, true);
      const text = JSON.stringify(response.content);
      assert.match(text, /429/);
      assert.doesNotMatch(text, /debug details/);
    }
  );
});

test("missing regional offers remain unknown and private profiles expose only public fields", async () => {
  await withClient(
    async (input) =>
      String(input).includes("steamcommunity.com")
        ? new Response(
            "<profile><steamID64>76561190000000000</steamID64><steamID><![CDATA[Player & One]]></steamID><privacyState>private</privacyState></profile>"
          )
        : Response.json({
            "620": { success: true, data: { name: "Portal 2", type: "game", is_free: false } },
          }),
    async (client) => {
      const game = await client.callTool({ name: "game_details", arguments: { app_id: 620 } });
      assert.equal(game.structuredContent?.price_overview, null);
      const profile = await client.callTool({
        name: "public_profile",
        arguments: { steam_id: "76561190000000000" },
      });
      assert.equal(profile.structuredContent?.display_name, "Player & One");
      assert.equal(profile.structuredContent?.visibility, "private");
    }
  );
});
