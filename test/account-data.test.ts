import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handler } from "../src/index.ts";
import { installAccount } from "../src/account.ts";

const subject = "76561198000000001";
async function connect(upstream: typeof fetch, key?: string) {
  const serve = handler(upstream, (s) => installAccount(s, upstream, subject, key));
  const client = new Client({ name: "fixture", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://test.invalid/account/mcp"), {
      fetch: (u, i) => serve(new Request(u, i)),
    })
  );
  return client;
}
test("keyless account exposes community tools and distinguishes hidden stats from an empty result", async () => {
  const client = await connect(
    async () => new Response("<profile><privacyState>private</privacyState></profile>")
  );
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(
      names.includes("my_game_stats") &&
        !names.includes("my_library") &&
        !names.includes("my_achievements")
    );
    assert.equal(
      (await client.callTool({ name: "my_game_stats", arguments: { community_game: "L4D" } }))
        .isError,
      true
    );
  } finally {
    await client.close();
  }
});
test("AppID achievements use the authorized subject, preserve unknown timestamps and reject a mismatched owner", async () => {
  let returned = subject;
  const client = await connect(async (input, init) => {
    assert.equal(new URL(String(input)).searchParams.get("steamid"), subject);
    assert.equal(new Headers(init?.headers).get("x-webapi-key"), "fixture");
    return Response.json({
      playerstats: {
        steamID: returned,
        success: true,
        achievements: [{ apiname: "A", achieved: 0, unlocktime: 0 }],
      },
    });
  }, "fixture");
  try {
    const call = () => client.callTool({ name: "my_achievements", arguments: { app_id: 620 } });
    const ok = await call();
    assert.deepEqual(ok.structuredContent?.items, [
      { api_name: "A", unlocked: false, unlock_time_unix: null },
    ]);
    returned = "76561198000000002";
    assert.equal((await call()).isError, true);
  } finally {
    await client.close();
  }
});
