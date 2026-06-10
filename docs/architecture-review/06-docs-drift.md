# 06 · CLAUDE.md / docs 与代码脱节

**严重度：低，但修复成本最低、复利最高。** 这个仓库大量靠 agent 改代码，
CLAUDE.md 就是架构边界的执法依据；它失真，后续改动就会放错层，
01-05 描述的债会继续累积。

## 脱节清单

CLAUDE.md（以及它引用的事件流图）完全没有提到以下已存在的模块：

- `server/feishu/` — 第二个聊天平台，1081 行的 client，整个事件流里只画了 Slack。
- `server/transports/` — MessageTransport 抽象层。
- `server/kb/` — 知识库服务。
- `server/messages/` — 消息投影层（inbox items + activities → 统一消息历史）。
- `server/asks/` — 交互式 ask 服务。
- `server/provider-usage/` — provider 用量查询。
- `server/runtime-management/` — 托管运行时安装/升级（759 行的 runtime-upgrade）。
- `server/diagnostics/` — agent 诊断聚合。
- `server/slack-interactions/`、`server/activities/`、`server/settings/`、
  `server/env/` — 均未列入 Key modules。
- provider 列表写的是 "Claude Code, Codex CLI, Kimi CLI adapters"，但没提
  claude-channel（HTTP channel 模式的第二个 Claude adapter）。

另外 `slack-subscription.service.ts` 文件名暗示 Slack-only，实际同时承载
Feishu 的订阅决策（见 01）。

## 建议方向

1. 重写 CLAUDE.md 的 Key modules 与事件流图，纳入 Feishu / transports /
   messages / asks / kb / runtime-management。
2. Vocabulary 一节补充 transport / 平台（Slack context → 泛化为 chat context）。
3. 顺手处理命名：`slack-subscription.service.ts` 改名（或在 01 的重构中自然解决）。
