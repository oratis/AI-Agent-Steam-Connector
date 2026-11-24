import {
  OAuthProvider,
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  insufficientScope,
  type OAuthHelpers,
  type OAuthResourceContext,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { handler } from "./index.ts";
import { installAccount } from "./account.ts";
import { InvalidAssertion, steamLogin, verifySteam } from "./openid.ts";

type Bindings = Env & { STEAM_WEB_API_KEY?: string; OAUTH_PROVIDER?: OAuthHelpers };
const permission = "steam.read";
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

function page(d: ConsentDescription, handle: string, libraryEnabled: boolean) {
  const client = escape(d.clientName);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Steam to ${client}</title><main><h1>Connect Steam to ${client}</h1>
<p>${d.clientDomain ? "Client domain: " + escape(d.clientDomain) : "This client supplied its own display name."}
Access returns to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p>Continue only if you started this connection in an app on this computer.</p>" : ""}
<p>Grant <code>steam.read</code> to read your verified SteamID, visible profile, reported playtime and supported games' achievements.
${libraryEnabled ? "This deployment can also query visible owned games and playtime by title." : "This deployment has no Steam Web API key for owned-game lists."}
 Your Steam privacy settings apply. The connector issues its own agent credentials for up to seven days.</p>
<form action="/authorize" method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="allow">Continue to Steam</button> <button name="decision" value="deny">Cancel</button></form></main></html>`;
}

function redirect(headers: Headers, location: string) {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(null, { status: 303, headers });
}

async function authorize(req: Request, env: Bindings) {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) throw new Error("OAuth helpers unavailable");
  const url = new URL(req.url);
  if (url.pathname === "/authorize" && req.method === "GET") {
    const request = await oauth.parseAuthRequest(req);
    if (request.codeChallengeMethod !== "S256" || !request.codeChallenge)
      return new Response("S256 PKCE is required.", { status: 400 });
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    consent.headers.set("Referrer-Policy", "no-referrer");
    consent.headers.set(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );
    return new Response(page(details, consent.handle, Boolean(env.STEAM_WEB_API_KEY)), {
      headers: consent.headers,
    });
  }
  if (url.pathname === "/authorize" && req.method === "POST") {
    if (req.headers.get("Origin") !== env.PUBLIC_ORIGIN)
      return new Response("Invalid consent origin", { status: 403 });
    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "allow") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 303, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(req, handle, { scope: [permission] });
    const upstream = await oauth.beginUpstream(approved.request, { headers: approved.headers });
    return redirect(upstream.headers, steamLogin(env.PUBLIC_ORIGIN, upstream.state));
  }
  if (url.pathname === "/steam/callback" && req.method === "GET") {
    const completed = await oauth.finishUpstream(req);
    if (url.searchParams.get("openid.mode") === "cancel")
      return redirect(
        completed.headers,
        authorizationErrorRedirect(completed.request, "access_denied")
      );
    const id = await verifySteam(url, env.PUBLIC_ORIGIN);
    const grant = await oauth.completeAuthorization({
      request: completed.request,
      userId: id,
      props: {},
      metadata: {},
      scope: [permission],
    });
    return redirect(completed.headers, grant.redirectTo);
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/mcp") return handler(fetch)(request);
    if (url.origin !== env.PUBLIC_ORIGIN)
      return new Response("Unknown account endpoint origin", { status: 404 });
    const provider = new OAuthProvider<Bindings>({
      apiRoute: "/account/mcp",
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      resourceMetadata: {
        resource: env.PUBLIC_ORIGIN + "/account/mcp",
        authorization_servers: [env.PUBLIC_ORIGIN],
      },
      requiredScopes: [permission],
      scopesSupported: [permission],
      clientIdMetadataDocumentEnabled: true,
      refreshTokenTTL: 7 * 86400,
      accessTokenTTL: 1800,
      clientRegistrationTTL: 30 * 86400,
      apiHandler: {
        async fetch(req, bindings, context) {
          const { auth } = context as OAuthResourceContext<unknown>;
          if (!auth.scope.includes(permission)) return insufficientScope(auth, [permission]);
          const subject = auth.userId;
          if (!subject || !/^7656\d{13}$/.test(subject))
            return new Response("Invalid account grant", { status: 403 });
          const response = await handler(fetch, (server) =>
            installAccount(server, fetch, subject, bindings.STEAM_WEB_API_KEY)
          )(req);
          response.headers.set("Cache-Control", "private, no-store");
          return response;
        },
      },
      defaultHandler: {
        async fetch(req, bindings) {
          try {
            return await authorize(req, bindings);
          } catch (error) {
            if (error instanceof AuthorizationError && error.redirectTo)
              return redirect(new Headers(), error.redirectTo);
            if (
              error instanceof AuthorizationError ||
              error instanceof CimdFetchError ||
              error instanceof InvalidAssertion
            )
              return new Response(
                "Steam authorization could not be completed. Restart from your MCP client.",
                { status: 400, headers: { "Cache-Control": "no-store" } }
              );
            throw error;
          }
        },
      },
    });
    return provider.fetch(request, env, ctx);
  },
};
