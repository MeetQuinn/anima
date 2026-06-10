# 01 · 平台抽象太薄，Feishu 是平行拷贝而非第二个实现

**严重度：高。** 这是仓库最大的一笔架构债，也是多处重复的根因。

## 现状

`server/transports/message-transport.ts` 里的 `MessageTransport` 接口只有
`kind` / `start()` / `stop()` —— 它只抽象了**连接的生命周期**，没有抽象任何消息操作
（发送、读取、回应、发文件、ask）。于是所有业务逻辑都在用
if-feishu-else-slack 的方式分叉。

### tools 层：四个工具各自分叉，且绕过服务抽象

每个工具都是同一个模式：先探测是不是 Feishu 目标，是就走 `runFeishuXxx` 然后
`return`，否则落入 Slack 路径；两条路径各自直接调用
`createFeishuMessageClient` / `createSlackWebClient`：

- `server/tools/messages.ts:76-92` — `runMessageSend`
- `server/tools/file-send.ts:74-107`
- `server/tools/message-read.ts:96-140`
- `server/tools/reactions.ts:31-156` — 有独立的 `runFeishuReactionAdd` / `runSlackReactionAdd`

tools 层合计 40+ 处直接调用平台 client 工厂，没有任何统一的错误处理或日志层。

### agent 服务层：两套几乎相同的服务

- `server/agents/agent-slack.service.ts`（~295 行）
- `server/agents/agent-feishu.service.ts`（~425 行）

display-info 同步、TTL 缓存（`syncDisplayInfoIfStale`）、owner onboarding
（`ensureOwnerOnboardingPrompt`，两边各 ~150 行）结构平行，合计约 700 行平行代码。

### 订阅决策：成对的平行函数

`server/inbox/slack-subscription.service.ts`（文件名还叫 slack-，实际管两个平台）：

- `slackRuntimeDecision`（:176）vs `feishuRuntimeDecision`（:193）
- `activateMentionFollow`（:211）vs `activateFeishuMentionFollow`（:300）
- `consumeChannelFollow`（:269）vs `consumeFeishuChannelFollow`（:321）

核心模式（SubscriptionStore、`noteInboundWake`、`subscriptionDecisionSummary`）是复用的，
但决策函数本体约 65% 重复，~120 行。

### asks 是 Slack-only

`server/asks/interactive-ask.service.ts` 直接 import `WebClient` 和
`SlackWorkspaceDirectoryService`，记录里硬编码 `slackUserId` / `channelId` / `teamId`。
Feishu 没有等价物，也没有可实现的平台无关接口。

### feishu/client.ts 是 1081 行的单体

对比 Slack 侧拆成 client（薄 SDK 封装）/ helper（格式化）/ workspace-directory
（业务）三块的结构，`server/feishu/client.ts` 把 SDK 封装、token 管理、消息格式化
（:227-349）、WebSocket 事件分发（:626-750）、文件上传与类型映射（:761-850）全部
混在一个文件里。

## 代价的标尺

按现状估算，接第三个平台（比如 Discord）需要：

- 新的订阅决策三件套（~120 行新 + ~150 行改动）
- 第三个 ~400 行的 agent-discord.service.ts
- 四个工具各加一个 `if (discordTarget)` 分支 + 一套 `runDiscordXxx`（~200 行）
- 新的 transport 类 + client（~200+ 行）

合计 ~1200 行，其中约 40% 是对现有代码的拷贝。

## 建议方向

1. 把 `MessageTransport` 从生命周期接口升级为**操作接口**：
   send / readThread / react / sendFile / ask。tools 层只做参数解析和目标探测，
   然后委托给统一接口；平台探测收敛为一个 `detectTargetPlatform()`。
2. agent-slack / agent-feishu 服务提取共享基类或组合出平台无关的
   `AgentPlatformService`（display-sync、TTL 缓存、onboarding 入队）。
3. 订阅决策函数用判别联合（discriminated union）合并，平台差异收敛到字段映射。
4. `feishu/client.ts` 按 Slack 侧的结构拆为 client / events / messages / files。
5. asks 先抽出平台无关的持久化与应答记录契约，再分别实现 Slack/Feishu。
