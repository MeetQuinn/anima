# 08 · 依赖图：两条反向/循环边，一个归属模糊的模块

**严重度：中。** 整体依赖方向是健康的：`storage/` 不向上依赖
services/runtime/inbox，`shared/` 不依赖 `server/`。问题集中在两条边和
一个模块的归属。

## 1. providers → inbox 的反向依赖

`server/providers/claude-channel.ts:8` 直接 import
`WakeQueueService`（来自 `../inbox/wake-queue.service.js`）。

按分层声明，provider adapter 只该拥有自己的 CLI 协议；它对 inbox 业务层的
依赖应该反转——由 runtime 装配时把所需能力（或一个窄回调）注入 adapter，
而不是 adapter 自己去够队列服务。

（核查说明：只有 claude-channel 有这条边；codex/kimi 没有。）

## 2. inbox ↔ slack-interactions 循环

- `server/inbox/slack-subscriber.ts:13` import
  `defaultSlackShortcutService`（来自 `../slack-interactions/shortcut.service.js`）
- `server/slack-interactions/shortcut.service.ts:8` import
  `WakeQueueService`（来自 `../inbox/wake-queue.service.js`）

目前能跑（一边拿单例、一边拿类），但模块初始化顺序是隐式约束。

## 3. slack-interactions/ 的归属模糊

shortcut.service 同时依赖 agents、activities、inbox、reminders、runtime、
slack——它横跨了"事件摄入"（inbox 的职责）和"控制面"（runtime 的职责），
在分层图里没有明确的位置。按现有词汇表，Slack shortcut 是一种入站事件，
更自然的归属是 inbox/ 的一个 handler，或者升格为一个明确的 service。

## 附带观察（已核实）

- 类型安全整体很好：全仓库只有 ~7 处 `as unknown as` / 非空断言，集中在
  `feishu/client.ts:890`（SDK 类型不匹配）和
  `runtime/runtime-session.service.ts:226,245,262,286`
  （`ProviderSessionStatsSummary` 形状转换，4 处同模式）。后者值得用 Zod
  校验替代裸 cast。

## 建议方向

1. claude-channel 改为构造时注入所需的队列操作（最小接口），删掉对 inbox 的
   直接 import。
2. 打破 inbox ↔ slack-interactions 循环：把 shortcut 处理并入
   `inbox/`（如 `inbox/slack-shortcut-handler.ts`），或抽出共享类型模块。
3. 给 CLAUDE.md 的分层图补上 slack-interactions 的位置（见 06）。
