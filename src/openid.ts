const endpoint = "https://steamcommunity.com/openid/login";
const namespace = "http://specs.openid.net/auth/2.0";
const selector = namespace + "/identifier_select";

export function callbackUrl(origin: string, state: string) {
  const url = new URL("/steam/callback", origin);
  url.searchParams.set("state", state);
  return url.href;
}

export function steamLogin(origin: string, state: string) {
  const login = new URL(endpoint);
  login.search = new URLSearchParams({
    "openid.ns": namespace,
    "openid.mode": "checkid_setup",
    "openid.realm": origin + "/",
    "openid.return_to": callbackUrl(origin, state),
    "openid.identity": selector,
    "openid.claimed_id": selector,
  }).toString();
  return login.href;
}

export class InvalidAssertion extends Error {}

export async function verifySteam(url: URL, origin: string, upstream: typeof fetch = fetch) {
  const params = url.searchParams;
  const invalid = () =>
    new InvalidAssertion("Steam sign-in could not be verified. Restart from your MCP client.");
  const state = params.get("state");
  if (!state || new Set(params.keys()).size !== [...params.keys()].length) throw invalid();
  const field = (key: string) => params.get("openid." + key) ?? "";
  const claimed = field("claimed_id").match(
    /^https:\/\/steamcommunity\.com\/openid\/id\/(7656\d{13})$/
  );
  const signed = new Set(field("signed").split(","));
  const required = [
    "op_endpoint",
    "return_to",
    "response_nonce",
    "assoc_handle",
    "claimed_id",
    "identity",
  ];
  const date = field("response_nonce").match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ).+/);
  const age = date ? Date.now() - Date.parse(date[1]) : NaN;
  if (
    !claimed ||
    field("identity") !== field("claimed_id") ||
    field("ns") !== namespace ||
    field("mode") !== "id_res" ||
    field("op_endpoint") !== endpoint ||
    field("return_to") !== callbackUrl(origin, state) ||
    !required.every((k) => signed.has(k) && field(k)) ||
    !field("sig") ||
    !Number.isFinite(age) ||
    age < -60_000 ||
    age > 600_000
  )
    throw invalid();

  const body = new URLSearchParams();
  for (const [key, value] of params) if (key.startsWith("openid.")) body.set(key, value);
  body.set("openid.mode", "check_authentication");
  const response = await upstream(endpoint, {
    method: "POST",
    body,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || !(await response.text()).split(/\r?\n/).includes("is_valid:true"))
    throw invalid();
  return claimed[1];
}
