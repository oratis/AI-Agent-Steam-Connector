import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { verifySteam } from "../src/openid.ts";

const origin = "https://steam-mcp.test";
const resource = origin + "/account/mcp";
const callback = "http://127.0.0.1:29375/callback";
const owner = "76561198000000001";
const other = "76561198000000002";

function assertion(returnTo: string) {
  const url = new URL(returnTo);
  const claim = "https://steamcommunity.com/openid/id/" + owner;
  const params = {
    ns: "http://specs.openid.net/auth/2.0",
    mode: "id_res",
    identity: claim,
    claimed_id: claim,
    op_endpoint: "https://steamcommunity.com/openid/login",
    return_to: returnTo,
    response_nonce: new Date().toISOString().slice(0, 19) + "Zunique",
    assoc_handle: "test",
    sig: "test",
    signed: "op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set("openid." + k, v);
  return url;
}
test("reject unbound or unsigned Steam responses and require Valve confirmation", async () => {
  const good = assertion(origin + "/steam/callback?state=local");
  for (const [key, value] of [
    ["openid.identity", "https://steamcommunity.com/openid/id/" + other],
    ["openid.signed", "claimed_id"],
    ["openid.return_to", origin + "/steam/callback?state=wrong"],
  ]) {
    const changed = new URL(good);
    changed.searchParams.set(key, value);
    let calls = 0;
    await assert.rejects(
      verifySteam(changed, origin, async () => {
        calls++;
        return new Response("");
      })
    );
    assert.equal(calls, 0);
  }
  await assert.rejects(verifySteam(good, origin, async () => new Response("is_valid:false")));
});

test("worker flow from discovery through consent, account reads and revocation", async () => {
  const bundle = await build({
    entryPoints: ["src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    write: false,
    logLevel: "silent",
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-11-24",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      kvNamespaces: ["OAUTH_KV"],
      bindings: { PUBLIC_ORIGIN: origin, STEAM_WEB_API_KEY: "fixture-key" },
      outboundService: async (req) => {
        const u = new URL(req.url);
        if (u.href === "https://steamcommunity.com/openid/login" && req.method === "POST") {
          const fields = new URLSearchParams(await req.text());
          assert.equal(fields.get("openid.mode"), "check_authentication");
          return new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n");
        }
        if (u.hostname === "api.steampowered.com") {
          assert.equal(req.headers.get("x-webapi-key"), "fixture-key");
          assert.equal(JSON.parse(u.searchParams.get("input_json")!).steamid, owner);
          return Response.json({
            response: {
              game_count: 1,
              games: [{ appid: 620, name: "Portal 2", playtime_forever: 73 }],
            },
          });
        }
        assert.equal(u.href, "https://steamcommunity.com/profiles/" + owner + "/?xml=1");
        assert.equal(req.headers.get("authorization"), null);
        return new Response(
          "<profile><steamID64>" +
            owner +
            "</steamID64><steamID>Fixture</steamID><privacyState>public</privacyState></profile>"
        );
      },
    })
  );
  const dispatch = (url: string, init: RequestInit = {}) =>
    mf.dispatchFetch(new URL(url, origin).href, { ...init, redirect: "manual" });
  const cookie = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  try {
    const challenge = await dispatch(resource, { method: "POST" });
    assert.equal(challenge.status, 401);
    const metadata = challenge.headers
      .get("www-authenticate")!
      .match(/resource_metadata="([^"]+)"/)![1];
    assert.equal((await (await dispatch(metadata)).json()).resource, resource);
    const registration = await dispatch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test client",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    assert.equal(registration.status, 201);
    const clientId = (await registration.json()).client_id;
    const verifier = "z".repeat(48);
    const authorize = new URL("/authorize", origin);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: callback,
      resource,
      scope: "steam.read",
      state: "client-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const consent = await dispatch(authorize.href);
    assert.equal(consent.status, 200);
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];
    const approve = await dispatch("/authorize", {
      method: "POST",
      headers: { origin, cookie: cookie(consent) },
      body: new URLSearchParams({ decision: "allow", handle }),
    });
    assert.equal(approve.status, 303);
    const signIn = new URL(approve.headers.get("location")!);
    assert.equal(signIn.origin, "https://steamcommunity.com");
    const signed = assertion(signIn.searchParams.get("openid.return_to")!);
    assert.equal((await dispatch(signed.href)).status, 400);
    const finish = await dispatch(signed.href, { headers: { cookie: cookie(approve) } });
    assert.equal(finish.status, 303);
    const returned = new URL(finish.headers.get("location")!);
    assert.equal(returned.searchParams.get("state"), "client-state");
    const tokens = await dispatch("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: returned.searchParams.get("code")!,
        redirect_uri: callback,
        resource,
        code_verifier: verifier,
      }),
    });
    assert.equal(tokens.status, 200);
    const token = await tokens.json();
    const call = async (name: string, args: object) => {
      const response = await dispatch(resource, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token.access_token,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return (await response.json()).result;
    };
    assert.equal((await call("my_account", {})).structuredContent.steam_id, owner);
    assert.equal(
      (await call("my_library", { steam_id: other })).structuredContent.items[0].total_minutes,
      73
    );
    const revoked = await dispatch("/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        token: token.refresh_token ?? token.access_token,
      }),
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      (
        await dispatch(resource, {
          method: "POST",
          headers: { authorization: "Bearer " + token.access_token },
        })
      ).status,
      401
    );
  } finally {
    await mf.dispose();
  }
});
