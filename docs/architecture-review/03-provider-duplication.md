# 03 · 三个 provider adapter 约 300 行可收敛的重复

**严重度：中。** 接口层是干净的（`contract.ts` 定义 `AgentRuntime` /
`AgentRuntimeInput` / `AgentRuntimeEffects`，`factory.ts` 负责实例化，
`child-process.ts` 是共享 spawn 层）；重复在三个 controller 的内部实现。

## 三处各实现了一遍的逻辑

claude.ts / codex-app-server.ts / kimi.ts 各自复制了：

| 模式 | 位置 | 规模 |
|------|------|------|
| `waitForQuiescent` 等待器 | claude.ts:388-412 / codex-app-server.ts:180-203 / kimi.ts:248-271 | 各 ~25 行 |
| quiescent waiter 的 resolve/reject | claude.ts:529-536 / codex-app-server.ts:356-362 / kimi.ts:623-630 | 合计 ~64 行 |
| stdout 行缓冲切分 | claude.ts:289,418-422 / codex-app-server.ts:56,237-240 / kimi.ts:166,227-232 | 各 ~10 行 |
| turn promise 状态机（currentTurn + resolve/reject） | claude.ts:292-299,468-480 / codex-app-server.ts:31-36 / kimi.ts:149-156,590-609 | 合计 ~94 行 |
| `ActiveRuntimeRun` 的使用模式 | 三个文件开头 | 模式完全一致 |

## 哪些是真协议差异（不该抽）

- JSON-RPC 的请求/响应处理：Kimi 用 string ID、Codex 用 number ID，pending map
  类型不同，属于协议事实。
- 事件解析本体（claude-events / codex-events / kimi 内联）处理的是不同的
  wire protocol。
- sessionId / threadId、activeToolIds 等 quiescence 追踪的具体字段是协议特定的。

## 附带观察：provider-usage/

`server/provider-usage/` 与 runtime adapter 解耦得很好（不 import providers/），
唯一的小问题是各 adapter 硬编码凭证文件路径（claude.ts:19-20、codex.ts:7、
kimi.ts:18-20），可以挪到配置。

## 建议方向

提取一个共享的流式控制器基类（或组合用的 helper 集）：

- `LineBufferingInputStream`：行缓冲切分。
- `QuiescentWaiterSet`：等待器注册 + resolve/reject。
- `TurnPromise<T>`：turn 状态机封装。

JSON-RPC ID 类型等协议差异留在各 adapter。预计净减 ~250-300 行，
更重要的是新接 provider 时这些机制不用再写第四遍。
