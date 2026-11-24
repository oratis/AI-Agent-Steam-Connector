# Steam MCP

[English](README.md) · [MIT 许可证](LICENSE)

在对话里找到一款 Steam 游戏，查看指定地区的商店报价、全球同时在线人数和最近新闻，也可以按 SteamID64 读取社区资料页公开的昵称与可见性。

## 连接自己的 Steam 账号

在客户端添加以下**个人账号地址**，传输方式选 Streamable HTTP。先在连接器同意页核对请求授权的应用，再到 Steam 官方页面登录。个人工具使用 Steam 确认的 SteamID。密码和 Steam 令牌验证码只在 Steam 官方页面填写。

```text
https://steam-mcp.oratisoratisoratisoratis.workers.dev/account/mcp
```

| 客户端 | 命令 |
| --- | --- |
| Codex | `codex mcp add steam-personal --url https://steam-mcp.oratisoratisoratisoratis.workers.dev/account/mcp` |
| Claude Code | `claude mcp add --transport http --scope user steam-personal https://steam-mcp.oratisoratisoratisoratis.workers.dev/account/mcp` |

如果客户端稍后才启动授权，执行 `codex mcp login steam-personal`，或在 Claude Code 的 `/mcp` 中选择该服务的 **Authenticate**。授权后可问「我连的是哪个 Steam 账号？Steam 显示我近两周玩了多少小时？」也可以试「用社区名称 L4D 查询我的《求生之路》成就」。

| 个人工具 | 托管版可用性及字段 |
| --- | --- |
| `my_account` | 已关联 SteamID、可见昵称、资料可见性，以及 Steam 提供的近两周时长。 |
| `my_game_stats` | 支持的社区统计页面中，按游戏读取成就名、解锁标记和上游报告的时长。传入社区统计名称，例如 `L4D` 或 `Portal2`。缺失字段返回 `null`。 |
| `my_library` | 配置服务端 Steam Web API key 后可查询可见游戏库及每款游戏的累计与近期分钟数。当前托管版未启用。 |
| `my_achievements` | 同样需要服务端 key，可按 AppID 读取玩家可见成就及已知解锁时间。当前托管版未启用。 |

**2026-11-24 验证记录。** 线上地址已返回 OAuth 发现信息，SDK 可以启动授权。用 Valve 文档中的公开样本账号实测，个人数据适配层读到了近两周时长字段，以及《求生之路》的 73 条成就记录和解锁标记。这个样本的单游戏时长由 Steam 报告为 `0s`。无 key 请求游戏库接口返回 HTTP 401。另用模拟的 Steam 签名确认响应测试了回调验证、PKCE 换取令牌、账号隔离和撤销。具体玩家的结果仍需该玩家真实登录确认。Steam OpenID 确认身份，游戏资料的可见范围取决于 Steam 隐私设置、游戏支持和上游接口。Valve 已将社区 XML 标为弃用。 [Steam 登录](https://partner.steamgames.com/doc/features/auth) · [社区数据和公开样本](https://partner.steamgames.com/documentation/community_data) · [游戏库接口](https://partner.steamgames.com/doc/webapi/IPlayerService) · [成就接口](https://partner.steamgames.com/doc/webapi/ISteamUserStats)

**授权与存储。** 个人入口采用逐客户端同意、S256 PKCE、绑定浏览器的 Steam OpenID 流程及 Steam 服务端二次确认。MCP 授权限定到本资源地址。Workers KV 保存客户端注册、授权主体和令牌记录。个人游戏数据按请求读取，关闭缓存。访问令牌有效 30 分钟，刷新授权最长七天，客户端可通过发布的撤销端点撤销令牌。

要用自己的账号验证，运行 `node scripts/verify-account.mjs`，打开它打印的临时本机地址。脚本只输出字段可用性，凭据留在内存中，结束后自动撤销测试令牌。默认测试游戏为 `Portal2`，也可依次传入个人服务地址及另一个游戏的社区统计名称。

## 连接公开工具

在支持远程 MCP 的客户端粘贴这个地址，传输方式选 **Streamable HTTP**。公开查询免登录，无需申请 API Key。

```text
https://steam-mcp.oratisoratisoratisoratis.workers.dev/mcp
```

**Codex**

```sh
codex mcp add steam --url https://steam-mcp.oratisoratisoratisoratis.workers.dev/mcp
```

**Claude Code**

```sh
claude mcp add --transport http --scope user steam https://steam-mcp.oratisoratisoratisoratis.workers.dev/mcp
```

配置后在 Codex 新开对话，或在 Claude Code 输入 `/mcp` 查看连接状态。

## 试一句

> 找到 Steam 上的《传送门 2》，查英国区价格、全球同时在线人数和最新一条新闻，附上来源。

《传送门 2》的 AppID 是 `620`。Agent 可以沿用这个 ID 查询价格、人数和新闻。商店地区传 `GB`，在线人数使用全球口径。

## 工具与数据范围

| 工具 | 参数 | 返回内容 |
| --- | --- | --- |
| `search_store` | `query`, `country`, `limit` | 商店搜索，返回 AppID、标题、支持系统和链接 |
| `game_details` | `app_id`, `country` | 发行日期、发行商、支持系统与当地标价 |
| `current_players` | `app_id` | Steam 报告的全球同时在线人数 |
| `game_news` | `app_id`, `limit` | 带日期、来源和链接的新闻标题 |
| `public_profile` | `steam_id` | 按 17 位 SteamID64 读取公开昵称及资料可见性 |

商店文字为英文，默认地区为 `US`，也支持 `GB`、`DE`、`FR`、`CA`、`AU`、`JP`、`CN`、`HK`、`TW`、`BR`、`IN`。价格缺失时返回 `null`，免费状态见 `is_free`。新闻可能来自 Steam 收录的外部媒体。此公开入口仅查询公开信息。

## 架构

每个请求在 Cloudflare Worker 中创建独立的 MCP 服务与 HTTP 传输。输入校验通过后才访问平台。客户端可以读取结构化 JSON 或等价的文本结果，上游异常会作为工具错误返回。

搜索与详情读取 Steam 商店端点，人数与新闻来自 Steam Web API，公开资料来自 Steam Community 的 XML 页面。每个结果带来源；公开资料按请求获取。

查询关键词或标识符会发送到相应平台。公开工具无需平台账号凭据。

[Steam Store](https://store.steampowered.com/) · [ISteamUserStats](https://partner.steamgames.com/doc/webapi/ISteamUserStats) · [ISteamNews](https://partner.steamgames.com/doc/webapi/ISteamNews) · [Steam Community](https://steamcommunity.com/)

## 本地运行与自托管

需要 Node.js 24 或以上版本。

```sh
git clone https://github.com/oratis/steam-mcp.git
cd steam-mcp
npm ci
npm run check
npm test
npm run dev
```

在另一个终端运行端到端验证。脚本会完成 MCP 握手、发现工具，再调用真实平台数据。

```sh
npm run smoke -- http://localhost:8787/mcp
```

直接执行 `npm run smoke` 可验证公开服务。`npm test` 使用离线测试数据。自托管时在 `wrangler.jsonc` 中把 `vars.PUBLIC_ORIGIN` 设为自己的 HTTPS 域名，创建 Workers KV 命名空间，将其 ID 填入 `kv_namespaces[0].id`。登录自己的 Cloudflare 账户后执行 `npm run deploy`。可选执行 `npx wrangler secret put STEAM_WEB_API_KEY` 启用游戏库与 AppID 成就。个人入口为 `/account/mcp`，公开入口为 `/mcp`。

## 常见连接问题

- 浏览器直接打开 `/mcp` 会收到 HTTP 405。查看[服务信息](https://steam-mcp.oratisoratisoratisoratis.workers.dev/)可确认地址，完整验证请用上面的 smoke 命令。
- 如果可以列出工具，但查询返回上游错误，请核对地区和标识符后重试。

由 [oratis](https://github.com/oratis) 独立维护。同系列连接器 · [PlayStation MCP](https://github.com/oratis/playstation-mcp) · [Nintendo MCP](https://github.com/oratis/nintendo-mcp)。
