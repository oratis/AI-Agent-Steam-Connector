# Steam MCP

[English](README.md) · [MIT 许可证](LICENSE)

在对话里找到一款 Steam 游戏，查看指定地区的商店报价、全球同时在线人数和最近新闻，也可以按 SteamID64 读取社区资料页公开的昵称与可见性。

## 直接连接

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

商店文字为英文，默认地区为 `US`，也支持 `GB`、`DE`、`FR`、`CA`、`AU`、`JP`、`CN`、`HK`、`TW`、`BR`、`IN`。价格缺失时返回 `null`，免费状态见 `is_free`。新闻可能来自 Steam 收录的外部媒体。个人游戏库、购买记录和私人成就不在此版本范围内。

## 架构

每个请求在 Cloudflare Worker 中创建独立的 MCP 服务与 HTTP 传输。输入校验通过后才访问平台。客户端可以读取结构化 JSON 或等价的文本结果，上游异常会作为工具错误返回。

搜索与详情读取 Steam 商店端点，人数与新闻来自 Steam Web API，公开资料来自 Steam Community 的 XML 页面。每个结果带来源；资料按请求获取，服务端不保存玩家会话。

查询关键词或标识符会发送到相应平台。服务无需平台账号凭据或账户数据库。

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

直接执行 `npm run smoke` 可验证公开服务。`npm test` 使用离线测试数据。自托管时登录自己的 Cloudflare 账户，执行 `npm run deploy`，把部署地址加上 `/mcp` 即可交给客户端。

## 常见连接问题

- 浏览器直接打开 `/mcp` 会收到 HTTP 405。查看[服务信息](https://steam-mcp.oratisoratisoratisoratis.workers.dev/)可确认地址，完整验证请用上面的 smoke 命令。
- 如果可以列出工具，但查询返回上游错误，请核对地区和标识符后重试。

由 [oratis](https://github.com/oratis) 独立维护。同系列连接器 · [PlayStation MCP](https://github.com/oratis/playstation-mcp) · [Nintendo MCP](https://github.com/oratis/nintendo-mcp)。
