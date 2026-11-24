import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseDocument, DomUtils } from "htmlparser2";
import { z } from "zod";
import { annotations, PublicSource, result, SourceError } from "./source.ts";

const page = {
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(100).default(25),
};
const steamId = z.string().regex(/^7656\d{13}$/);
const appId = z.number().int().positive().max(4294967295);
type Nodes = ReturnType<typeof parseDocument>["children"];
function field(nodes: Nodes, name: string) {
  const element = DomUtils.getElementsByTagName(name, nodes, true, 1)[0];
  return element ? DomUtils.textContent(element).trim() : null;
}
function slice<T>(items: T[], offset: number, limit: number) {
  return {
    total: items.length,
    items: items.slice(offset, offset + limit),
    next_offset: offset + limit < items.length ? offset + limit : null,
  };
}

export function installAccount(
  server: McpServer,
  upstream: typeof fetch,
  identity: string,
  apiKey?: string
) {
  const id = steamId.parse(identity);
  const profile = "https://steamcommunity.com/profiles/" + id + "/";
  const source = new PublicSource((url, init) => upstream(url, { ...init, cache: "no-store" }));
  server.registerTool(
    "my_account",
    {
      description:
        "Read your linked SteamID, public display name and Steam's reported hours over the past two weeks. Missing playtime is unknown.",
      annotations,
      inputSchema: {},
    },
    () =>
      result(async () => {
        const doc = parseDocument(await source.text(profile + "?xml=1", 0), { xmlMode: true });
        if (field(doc.children, "steamID64") !== id)
          throw new SourceError("Steam did not return the linked account's profile.");
        return {
          steam_id: id,
          display_name: field(doc.children, "steamID"),
          visibility: field(doc.children, "privacyState"),
          hours_last_two_weeks_reported: field(doc.children, "hoursPlayed2Wk"),
          library_api_configured: Boolean(apiKey),
          source: profile,
        };
      })
  );

  server.registerTool(
    "my_game_stats",
    {
      description:
        "Read your Steam Community achievements and reported game time where published. Pass the game's Steam Community stats name, e.g. L4D or Portal2.",
      annotations,
      inputSchema: { community_game: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), ...page },
    },
    ({ community_game, offset, limit }) =>
      result(async () => {
        const url = profile + "stats/" + community_game + "/?xml=1";
        const doc = parseDocument(await source.text(url, 0), { xmlMode: true });
        if (
          field(doc.children, "steamID64") !== id ||
          !DomUtils.getElementsByTagName("playerstats", doc.children, true, 1).length
        )
          throw new SourceError(
            "Steam did not expose stats for this account and game. Check Game details visibility and the community stats name."
          );
        const group = DomUtils.getElementsByTagName("achievements", doc.children, true, 1)[0];
        const achievements = group
          ? DomUtils.getElementsByTagName("achievement", group.children).map((a) => ({
              name: field(a.children, "name"),
              api_name: field(a.children, "apiname"),
              unlocked: a.attribs.closed === "1" ? true : a.attribs.closed === "0" ? false : null,
            }))
          : null;
        return {
          steam_id: id,
          game: field(doc.children, "gameName"),
          game_time_reported: field(doc.children, "hoursPlayed"),
          achievements: achievements === null ? null : slice(achievements, offset, limit),
          source: url,
        };
      })
  );

  if (!apiKey) return;
  // The platform key is sent only to the two fixed Steam Web API endpoints below.
  const api = new PublicSource((url, init) =>
    upstream(url, { ...init, cache: "no-store", headers: { "x-webapi-key": apiKey } })
  );
  server.registerTool(
    "my_library",
    {
      description:
        "List visible owned games and Steam-reported playtime in minutes for your linked account.",
      annotations,
      inputSchema: page,
    },
    ({ offset, limit }) =>
      result(async () => {
        const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
        url.searchParams.set(
          "input_json",
          JSON.stringify({ steamid: id, include_appinfo: true, include_played_free_games: true })
        );
        const game = z.object({
          appid: appId,
          name: z.string().optional(),
          playtime_forever: z.number().nonnegative().optional(),
          playtime_2weeks: z.number().nonnegative().optional(),
        });
        const { response } = await api.json(
          url,
          z.object({
            response: z.object({
              game_count: z.number().int().nonnegative().optional(),
              games: z.array(game).optional(),
            }),
          }),
          0
        );
        if (response.game_count === undefined || (response.game_count > 0 && !response.games))
          throw new SourceError("Steam did not expose the game library for this account.");
        return {
          steam_id: id,
          unit: "minutes",
          source: profile + "games/",
          ...slice(
            (response.games ?? []).map((g) => ({
              app_id: g.appid,
              name: g.name,
              total_minutes: g.playtime_forever ?? null,
              recent_minutes: g.playtime_2weeks ?? null,
            })),
            offset,
            limit
          ),
        };
      })
  );

  server.registerTool(
    "my_achievements",
    {
      description:
        "Read achievement flags and available unlock timestamps for one AppID on your linked Steam account.",
      annotations,
      inputSchema: { app_id: appId, ...page },
    },
    ({ app_id, offset, limit }) =>
      result(async () => {
        const url = new URL(
          "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/"
        );
        url.search = new URLSearchParams({
          steamid: id,
          appid: String(app_id),
          l: "english",
        }).toString();
        const item = z.object({
          apiname: z.string(),
          achieved: z.union([z.literal(0), z.literal(1)]),
          unlocktime: z.number().optional(),
          name: z.string().optional(),
        });
        const { playerstats } = await api.json(
          url,
          z.object({
            playerstats: z.object({
              success: z.boolean(),
              steamID: steamId.optional(),
              achievements: z.array(item).optional(),
            }),
          }),
          0
        );
        if (!playerstats.success || playerstats.steamID !== id || !playerstats.achievements)
          throw new SourceError("Steam did not expose achievements for this game and account.");
        return {
          steam_id: id,
          app_id,
          source: profile + "achievements/" + app_id,
          ...slice(
            playerstats.achievements.map((a) => ({
              api_name: a.apiname,
              name: a.name,
              unlocked: a.achieved === 1,
              unlock_time_unix: a.unlocktime || null,
            })),
            offset,
            limit
          ),
        };
      })
  );
}
