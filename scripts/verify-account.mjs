import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

// All client tokens, PKCE state and profile data stay in this process.
const endpoint = new URL(
  process.argv[2] ?? "https://steam-mcp.oratisoratisoratisoratis.workers.dev/account/mcp"
);
if (endpoint.protocol !== "https:") throw new Error("Use an HTTPS account endpoint.");
const communityGame = process.argv[3] ?? "Portal2";
const state = randomUUID();
const callback = Promise.withResolvers();
let authUrl, grant, registration, verifier;
let localOrigin;
const listener = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET" || req.headers.host !== new URL(localOrigin).host) {
    res.writeHead(400).end();
    return;
  }
  const url = new URL(req.url, localOrigin);
  if (url.pathname === "/start" && authUrl) {
    res.writeHead(302, { Location: authUrl.href }).end();
    return;
  }
  if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
    res.writeHead(400).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.end("Sign-in cancelled. You can close this tab.");
    callback.reject(new Error("Sign-in cancelled"));
    return;
  }
  res.end("Steam returned to the local verifier. You can close this tab.");
  callback.resolve(code);
});
await new Promise((resolve, reject) =>
  listener.once("error", reject).listen(0, "127.0.0.1", resolve)
);
localOrigin = "http://127.0.0.1:" + listener.address().port;
const provider = {
  redirectUrl: localOrigin + "/callback",
  clientMetadata: {
    client_name: "AI Agent Steam Connector local verification",
    redirect_uris: [localOrigin + "/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "steam.read",
  },
  state: () => state,
  clientInformation: () => registration,
  saveClientInformation: (v) => {
    registration = v;
  },
  tokens: () => grant,
  saveTokens: (v) => {
    grant = v;
  },
  redirectToAuthorization: (url) => {
    authUrl = url;
  },
  saveCodeVerifier: (v) => {
    verifier = v;
  },
  codeVerifier: () => verifier,
};
const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
const client = new Client({ name: "steam-account-verifier", version: "1" });
const deadline = AbortSignal.timeout(300000);
try {
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  assert.ok(authUrl, "The account endpoint did not start browser authorization.");
  console.log("Open " + localOrigin + "/start in your browser within five minutes.");
  const code = await Promise.race([
    callback.promise,
    new Promise((_, reject) =>
      deadline.addEventListener("abort", () => reject(new Error("Browser sign-in timed out.")), {
        once: true,
      })
    ),
  ]);
  await transport.finishAuth(code);
  await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const [name, args] of [
    ["my_account", {}],
    ["my_game_stats", { community_game: communityGame, limit: 1 }],
    ["my_library", { limit: 1 }],
  ]) {
    if (!names.includes(name)) {
      console.log(name, "not enabled");
      continue;
    }
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) {
      console.log(name, "unavailable for this lookup");
      if (name === "my_account") process.exitCode = 1;
      continue;
    }
    const data = r.structuredContent;
    if (name === "my_account")
      console.log(
        name,
        "verified; two-week hours field present:",
        data.hours_last_two_weeks_reported != null
      );
    else if (name === "my_game_stats")
      console.log(
        name,
        "achievement field present:",
        data.achievements != null,
        "playtime field present:",
        data.game_time_reported != null
      );
    else console.log(name, "library returned:", Array.isArray(data.items));
  }
} finally {
  listener.closeAllConnections();
  listener.close();
  await client.close();
  if (grant && registration) {
    const resp = await fetch(new URL("/token", endpoint), {
      method: "POST",
      body: new URLSearchParams({
        client_id: registration.client_id,
        token: grant.refresh_token ?? grant.access_token,
      }),
      redirect: "error",
    });
    assert.ok(resp.ok, "Temporary grant revocation failed");
    console.log("Temporary verifier token revoked.");
  }
}
