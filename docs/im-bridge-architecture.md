# DeerFlow × dsh-im 多渠道多 Bot 架构设计方案

> 适用范围：本文描述 **im-bridge**——一个独立 Node.js 服务，把微信(iLink)/飞书(Lark) 等 IM 渠道以「多渠道、多 bot」的方式桥接进 DeerFlow Gateway。DeerFlow 核心源码尽量不动，仅在「设置 → 渠道」页用 iframe 嵌入 im-bridge 管理 UI（这是刻意的 DeerFlow 侧定制）。
>
> 本文仅描述**已落地**的能力，不含未实现的规划项。

---

## 1. 目标与设计原则

### 1.1 目标
- DeerFlow 通过统一桥接层接入多个 IM 渠道，且每个渠道支持**多 bot 并发管理**（如：每个用户绑定自己的个人微信 = 一个 bot 实例）。
- 每个终端用户登录 DeerFlow 网页后，可**绑定自己的微信**，并只在自己的 DeerFlow 账号下看到对应的会话 thread。
- 渠道会话在 DeerFlow 网页中以「渠道徽标」标识，并复用 DeerFlow 原生的 per-user 线程隔离。
- 运维可在管理 UI 中管理共享渠道（如飞书 bot 的 App ID/Secret）。

### 1.2 设计原则
- **不修改 DeerFlow 运行时/agent 核心**：渠道能力全部在 im-bridge 侧实现；DeerFlow 仅作为 Gateway 与 Web UI 被复用。
- **复用 DeerFlow 原生能力**：thread 的 `user_id` 隔离、PAT 鉴权、`channel_source` 徽标渲染，全部直接利用，不在 im-bridge 重复造轮子。
- **dsh-im 管理 UI 整体 vendored**：预编译 bundle 放在 `im-bridge/public/`，im-bridge 只写「RPC 适配层」与少量托管逻辑，不改动 UI 源码。
- **凭据不出 im-bridge 边界**：PAT、飞书 App Secret 等在 im-bridge 数据卷内加密存储。

---

## 2. 系统拓扑

```
                          ┌──────────────────────────────────────────────┐
  浏览器(终端用户) ───────►│  Nginx :2026 (唯一公网入口)                   │
                          │   /                  → frontend   :3000       │
                          │   /im-bridge/         → im-bridge  :10010     │
                          │   /api/langgraph/*    → gateway    :8001       │
                          └───────────────┬────────────────┬─────────────┘
                                          │                │
                                  ┌───────▼──────┐  ┌──────▼─────────────────┐
                                  │  Frontend    │  │  im-bridge (Node ESM)    │
                                  │  (Next.js)   │  │  :10010                 │
                                  │             │  │  ├─ admin UI (dsh-im)    │
                                  │ 设置→渠道   │  │  ├─ /api/admin/rpc        │
                                  │ (iframe)    │  │  ├─ connectors/          │
                                  │             │  │  └─ core/ store/         │
                                  └───────┬──────┘  └───┬───────────┬─────────┘
                                          │              │           │
                                  ┌───────▼──────┐ ┌─────▼─────┐ ┌─▼──────────┐
                                  │ Gateway      │ │ WeChat    │ │ Feishu    │
                                  │ :8001        │ │ (iLink    │ │ (Lark WS) │
                                  │ REST + SSE   │ │  QR 扫码) │ │           │
                                  └──────────────┘ └───────────┘ └───────────┘
```

- **im-bridge 发布端口**固定容器内 `10010`，宿主机通过 `IM_BRIDGE_PUBLISH_PORT`（默认 10010）暴露；nginx 以 `/im-bridge/` 反代到 `im-bridge:10010`。
- **同源性**是关键：im-bridge 与 DeerFlow 网页同 origin（都经 nginx `:2026`），因此用户登录 DeerFlow 后，浏览器访问 `/im-bridge/` 的 iframe 会带上 `access_token` / `csrf_token` cookie，im-bridge 据此识别「当前是哪个 DeerFlow 用户」。
- **默认绑定地址**：compose 中 `IM_BRIDGE_PUBLISH_PORT` 发布为 `127.0.0.1`（或运维指定的 `BIND_HOST`）；生产建议只经 nginx + TLS 的 `:2026/im-bridge/` 访问，并用 `IM_BRIDGE_ADMIN_TOKEN` 保护写操作。

---

## 3. 模块划分（im-bridge 侧）

| 模块 | 文件 | 职责 |
|------|------|------|
| 配置 | `src/config.js` | 读 `DEERFLOW_PAT`(兜底 PAT)、`IM_BRIDGE_ADMIN_TOKEN`、`IM_BRIDGE_SECRET`、网关地址、发布端口 |
| 存储 | `src/store.js` | bot 注册表（含 per-bot PAT 与加密凭据）、会话缓存 `sessions`、AES-256-GCM 加解密、各类 bot 配置读写 |
| 微信连接器 | `src/connectors/weixin/index.js` | iLink 个人号长轮询、二维码登录、消息收发、bot 启停 |
| 飞书连接器 | `src/connectors/feishu/index.js` + `message-utils.mjs` | Lark `WSClient` 长连接、事件分发、消息解析、卡片流式引擎、图片/文件下载 |
| 编排 | `src/core/conversation.js` | 会话↔thread 映射、stream 进 DeerFlow、slash 命令、404/409 自愈、渠道徽标 metadata |
| Gateway 客户端 | `src/deerflow/client.js` | 封装 `createThread` / `streamRun` / `getHistory`，按 PAT 鉴权，SSE `values` 增量 diff |
| 管理 API | `src/admin/server.js` | dsh-im UI 静态托管 + `/api/admin/rpc` + 微信绑定端点 + 鉴权中间件 |
| RPC 适配 | `src/admin/dshImRpc.js` | 把 dsh-im 的 `rpcCall(channel, endpoint, payload)` 映射到 store/connectors，返回 `{ok, value\|error}` 信封 |
| 管理 UI | `im-bridge/public/` | vendored dsh-im React bundle（只读，不改动） |

### 3.1 存储层 `store.js` 关键接口
- `makeBot` / `upsertBot` / `getBot` / `deleteBot` / `listBots`：bot 生命周期；`listBots` 对外把 PAT 等凭据脱敏为 `********`。
- `setBotDeerflowUser(id, { deerflowUserId, deerflowPat })` / `getBotDeerflowPat(id)`：per-bot DeerFlow 身份与 PAT。
- `setSession` / `getSession` / `clearSession(platform, botId, chatId, topicId)`：会话→thread 缓存。
- `encrypt` / `decrypt`：基于 `IM_BRIDGE_SECRET` 的 AES-256-GCM；飞书 App Secret、per-bot PAT 均以加密形式落盘。
- `decryptCredentials(bot)`：供连接器读取飞书 App ID/Secret。
- 持久化：以上数据落在 im-bridge 数据卷（容器内 `/data`，compose 挂载 `im-bridge-data` 卷），重启不丢。

---

## 4. 身份与鉴权模型

DeerFlow 用 **PAT（Personal Access Token）** 鉴权 API 调用。im-bridge 的核心设计是：**每个 bot 可以携带「绑定它的 DeerFlow 用户自己的 PAT」**，从而它创建的 thread 归该用户所有，并只在该用户的 DeerFlow 网页出现。

### 4.1 PAT 的两种来源
1. **per-bot PAT（微信已落地）**：用户在 DeerFlow 网页登录后，于 im-bridge 管理 UI 发起微信扫码绑定；im-bridge 用该用户的会话 cookie 调 DeerFlow `/api/v1/auth/pats` 为其签发 PAT，存入 `store.setBotDeerflowUser(botId, { deerflowUserId, deerflowPat })`。
2. **全局兜底 PAT（飞书共享模式已落地）**：环境变量 `DEERFLOW_PAT`（对应 `config.pat`）。无 per-bot PAT 的 bot（飞书）回落到此 PAT 所属账号。运营只需在 `.env` 填入真实 `dfp_...` 即可启用飞书共享模式。

### 4.2 同域会话解析 `resolveDeerFlowUser`
- 读请求 `cookie` 头里的 `access_token` → 调 `GET {gateway}/api/v1/auth/me` → 解析出 `{ userId, email, isAdmin, cookie, csrfToken }`（`isAdmin` 来自 `system_role === "admin"`）。
- 带 60s 进程内缓存（按 `access_token` 维度），降低对 Gateway 的反复请求。
- 失败或无 cookie 返回 `null`，调用方据此判定「非登录用户」。

### 4.3 PAT 签发 `signDeerflowPat`
- 用 `resolveDeerFlowUser` 得到的会话 `cookie` + `X-CSRF-Token: csrf_token` 双提交，调 `POST {gateway}/api/v1/auth/pats`。
- 关键约束：DeerFlow 的 `/api/v1/auth/pats` **不在** `_AUTH_EXEMPT_PATHS` 内，必须经过 CSRF 双提交校验；若只带 `access_token` 而缺 `csrf_token` 头会返回 403。这是实现里最容易踩的坑，已在 `resolveDeerFlowUser` 中一并转发 `csrf_token` cookie 解决。
- 申请的最小作用域：`threads:read`、`threads:write`、`runs:create`、`runs:read`，有效期 `expires_in_days: 365`。

### 4.4 鉴权中间件
- `requireAdmin`：校验 `IM_BRIDGE_ADMIN_TOKEN`（运维写操作：bot 增删、飞书凭据配置、bot 启停）。
- `requireBindAuth`：admin token **或** 已解析的 DeerFlow 用户（普通用户扫码绑自己微信）。`bindUserContext(req)` 在放行后从 `req.dfUser` 或重新解析会话拿到 `{ deerflowUserId, deerflowPat }`，供微信 `provision.begin` 把 bot 归属到当前用户。
- 微信绑定专用端点 `/api/admin/weixin/login/begin`、`/:attemptId`、`/:attemptId/cancel` 使用 `requireBindAuth`；飞书/ bot 管理写操作使用 `requireAdmin`。

### 4.5 凭据安全
- `store.js` 的 `encrypt/decrypt` 以 `IM_BRIDGE_SECRET` 为密钥做 AES-256-GCM；PAT 存为 `__deerflowPat` 加密凭据，`listBots` 对外脱敏为 `********`。
- PAT 作用域最小化（见 4.3）。

---

## 5. 渠道接入模型（多渠道 + 多 bot）

### 5.1 微信（iLink，个人号，per-user 多 bot）
- 每个 DeerFlow 用户**各自扫码**绑定自己的个人微信 → 生成一个 bot 实例，归属该用户（`deerflowUserId` + 该用户的 PAT）。
- 绑定流程：`beginLogin({ deerflowUserId, deerflowPat })` 生成二维码；`activateAccount` 激活时调 `store.setBotDeerflowUser(identity.botId, { deerflowUserId, deerflowPat })`。
- 天然「多 bot」：N 个用户 = N 个微信 bot，彼此隔离；各自的 thread 只出现在各自 DeerFlow 账号下。

### 5.2 飞书（Lark，组织共享 bot，共享模式已落地）
- 单一组织 bot（App ID/Secret），通过 Lark `WSClient` 长连接收消息（`im.message.receive_v1`）。`domainOf()` 区分 `feishu` / `lark`。
- **共享模式（Model A，已落地）**：所有飞书消息回落到全局 `DEERFLOW_PAT` 所属账号，thread 归该运营账号；普通用户在自己 DeerFlow 网页看不到这些飞书 thread。
- 飞书 bot 由运维在管理 UI 用 App ID/Secret 手动接入（`bot.bind-credentials`），支持 `bot.reconnect` / `delete` / `workspace.set` / `preset.set` / `group-response-mode.set` / `disconnect`。
- 连接状态经 `onReady` / `onError` / `onReconnecting` / `onReconnected` 回写 `store.updateBotStatus`。

### 5.3 发送者身份的可用性（已落地的现状）
- 飞书事件仅提供 `sender.sender_id.open_id`（及 `user_id`），**不含邮箱**；消息由飞书服务器推送，**不携带 DeerFlow 会话 cookie**。
- 因此飞书侧当前采用共享模式（所有消息归全局 PAT 账号）；如需「按发消息的人分归属」，需要额外的绑定环节（本期未纳入实现范围，详见第 12 节能力清单边界）。

---

## 6. 会话与线程生命周期

`conversation.js` 把「一个 IM 会话」映射成「一个 DeerFlow thread」，并按渠道选择 PAT。

### 6.1 PAT 选择
- `clientForBot(botId)`：`store.getBotDeerflowPat(botId) || config.pat`。微信走 per-bot PAT，飞书走全局兜底 PAT。
- 该 client 构造 `new DeerFlowClient({ pat })`，所有 `createThread` / `streamRun` 均带此 PAT。

### 6.2 会话缓存与 thread 解析
- `resolveThread(ctx)`：以 `(platform, botId, chatId, topicId)` 为键查 `store.getSession`；命中且有 `threadId` 则复用，否则 `client.createThread()` 新建并写回。
- topic 维度：飞书群聊按 `thread_id` / `root_id` 区分话题，保证同一群不同话题互不串台；单聊 `topicId` 为 `null`。
- 缓存失效：`clearSession` 会丢弃某会话的 thread 映射，下一次消息将开新 thread（对应 `/new`、`/reset` 命令与自愈逻辑）。

### 6.3 渠道徽标 metadata
- `resolveThread` 建 thread 时透传 `metadata.channel_source`：
  ```js
  { type: "im_channel", provider: "wechat"|"feishu", connection_id: botId, topic_id: chatId }
  ```
- 平台名映射：`weixin → wechat`（前端 `CHANNEL_PROVIDER_LABELS` 只认 `wechat`/`feishu` 等），确保徽标显示「WeChat / Feishu」而非原始内部 id。
- DeerFlow 前端 `channelSourceOfThread()`（`frontend/src/core/threads/utils.ts`）读 `metadata.channel_source` 并在会话列表/侧边栏渲染 `ThreadChannelBadge`。
- 该 key **不在** DeerFlow 的 `_SERVER_RESERVED_METADATA_KEYS`（仅 `owner_id` / `user_id`），故 PAT 调用可写、不被剥掉；thread 列表 API 也会原样返回，前端即可渲染。

### 6.4 运行与自愈
- `runThread`：先 `resolveThread` 取 threadId，`streamInto` 流式调用 `client.streamRun`；捕获异常时：
  - `isActiveRunError`（409 / "already has an active run"）：清缓存、开新 thread、重试一次（防止上一条还在流式时新消息被静默吞掉）。
  - `isThreadGoneError`（404 / "not found"）：thread 在服务端已失效（如容器重置但缓存未清），同样清缓存、开新 thread、重试一次，避免永久卡死必须手动 `/new`。
  - 其他错误向上抛出。
- `isAuthError`（401 / "Invalid token" / "Unauthorized"）：在 `handleInbound` 的 catch 中给出明确提示（检查 `DEERFLOW_PAT`），而非裸的错误原文。

### 6.5 slash 命令
- `/new`、`/reset`：清会话缓存，开新对话。
- `/model <名称>`、`/preset <agent>`：切换该会话的模型 / 智能体（存于 `store.setProfile`，作用于 `activeModelAgent`）。
- `/status`：显示平台、bot、thread、模型、智能体。
- `/compact`：调用 `summarize` 总结并压缩对话（用临时 thread 跑摘要，再清缓存）。
- `/help`：列出上述命令。

---

## 7. 管理 UI（dsh-im vendored）

- `im-bridge/public/` 为预编译的 dsh-im React bundle；`server.js` 托管静态文件，并在 `/` 与 `/index.html` 注入 `window.IM_BRIDGE_ADMIN_TOKEN`（供 vendored UI 的 RPC 鉴权头使用）。
- UI 通过**单一 RPC 传输**调 `POST /api/admin/rpc`，body 为 `{ channel, endpoint, payload }`；`dshImRpc.js` 的 `dispatchRpc` 映射到 `weixinDispatch` / `feishuDispatch`，返回 `{ ok: true, value } | { ok: false, error }` 信封。
- 端点覆盖：
  - 微信：`connection.status`、`provision.begin/poll/verify/cancel`、`bot.reconnect/delete/workspace.set/preset.set/context-enhancement.set`。
  - 飞书：`connection.status`、`bot.bind-credentials`、`bot.reconnect/delete/workspace.set/preset.set/context-enhancement.set/group-response-mode.set/disconnect`；飞书扫码授权（QR provisioning）当前不受支持，UI 提示改走手动接入。
- DeerFlow 前端 `channels-settings-page.tsx` 用 iframe 嵌入 `/im-bridge/`；`settings-access.ts` 的 `REGULAR_USER_SETTINGS_SECTIONS` 已加入 `"channels"`，普通用户也能打开此页、绑自己的微信。
- 平台描述（`/api/admin/platforms`）由 `platformDescriptors` 提供（weixin / feishu）。

---

## 8. 数据持久化

| 数据 | 位置 | 说明 |
|------|------|------|
| bot 注册表 + per-bot PAT + 加密凭据 | im-bridge 数据卷（`store.js` 持久化） | 重启不丢 |
| 会话↔thread 缓存 | `sessions.json`（im-bridge 数据卷） | 清缓存即「开新会话」 |
| DeerFlow thread / 历史 | Gateway `thread_meta`（DeerFlow 原生） | 按 `user_id` 隔离 |
| 飞书长连接状态 | 内存 `active` Map | 重启自动重连 |

---

## 9. 部署与运维

### 9.1 服务编排
- `make up` / `docker compose` 起 nginx + gateway + frontend + im-bridge；im-bridge 容器内固定 `:10010`，宿主机 `IM_BRIDGE_PUBLISH_PORT`（默认 10010）。
- compose 中 im-bridge 同时 `env_file: ../.env` 并显式注入 `DEERFLOW_PAT` / `IM_BRIDGE_ADMIN_TOKEN` / `IM_BRIDGE_SECRET` / `IM_BRIDGE_DATA_DIR=/data` / `IM_BRIDGE_LOG_LEVEL`。

### 9.2 环境变量（根 `.env`，gitignored）
- `DEERFLOW_PAT`：全局兜底 PAT（飞书共享模式必需，填真实 `dfp_...`）。
- `IM_BRIDGE_ADMIN_TOKEN`：管理写操作令牌。
- `IM_BRIDGE_SECRET`：凭据加密密钥。
- `IM_BRIDGE_PUBLISH_PORT`：宿主机发布端口（默认 10010）。
- `NEXT_PUBLIC_IM_BRIDGE_URL`：前端渠道页 iframe 地址，默认走 nginx 反代 `/im-bridge/`；仅本地 dev 才单独指 `http://localhost:10010`。

### 9.3 常见运维动作
- 换 PAT / 加飞书凭据后：`docker compose up -d --force-recreate im-bridge`。
- 飞书 401 排查：`docker compose exec im-bridge printenv DEERFLOW_PAT` 确认非占位符。
- 某会话卡死：`/new` 清缓存；或依赖 6.4 的 404/409 自愈自动恢复。

---

## 10. 线程隔离与可见性小结

- DeerFlow thread 按 `user_id` 隔离；Web UI 仅列出当前登录用户的 thread，API 层也强制隔离（`test_owner_isolation` 验证）。
- 微信 per-bot PAT → thread 归绑定用户 → 仅该用户可见（符合「每人看自己的 thread」）。
- 飞书共享模式 → thread 归全局 PAT 账号 → 仅该运营账号可见，普通用户不可见。
- 渠道徽标（`channel_source`）对所有可见该 thread 的人展示，便于区分「微信 / 飞书」来源。

---

## 11. 已实现能力清单

| 能力 | 落地情况 |
|------|----------|
| im-bridge 服务 + 多渠道管理 UI（微信/飞书） | ✅ 已落地 |
| 微信 per-user 归属（每用户自己的 PAT，自己的 thread） | ✅ 已落地 |
| 飞书共享模式（全局 PAT，组织共享 bot） | ✅ 已落地（需运营填真实 `DEERFLOW_PAT`） |
| 渠道徽标（`channel_source` → 前端 WeChat/Feishu 徽标） | ✅ 已落地 |
| 普通用户可见「设置 → 渠道」tab（iframe 嵌入 im-bridge UI） | ✅ 已落地 |
| 404 / 409 自愈（清缓存开新 thread 重试） | ✅ 已落地 |
| 鉴权失败（401）给出明确运维提示 | ✅ 已落地 |
| 凭据 AES-256-GCM 加密存储 + PAT 脱敏 | ✅ 已落地 |
| slash 命令（/new /model /preset /status /compact /help） | ✅ 已落地 |

---


