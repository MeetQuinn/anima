# 07 · tools 层堆积业务逻辑，违反"CLI 只解析 + 调服务"

**严重度：高（分层问题）。** 仓库自己的分层规则是：CLI/路由层解析输入、调服务、
整形输出，到此为止；业务语义和跨 store 编排属于 service 层。tools/ 下的
agent-facing 命令没有遵守——它们既是 CLI 解析层，又是业务层。

## 证据

### ask.ts（397 行）

`server/tools/ask.ts` 的 `runAsk`（:72-183）里混着：

- 目标频道解析（:83-89，`resolveAskTarget` :265-291 直接从 `WakeQueueService`
  取当前 inbox item）
- 应答策略解析（:90-95）
- Slack 消息发布（:116-161）
- ask 记录持久化（:150）
- item → surface 的形状转换（`slackSurfaceFromItem` :293-335）

约 120 行业务逻辑应该在一个 `AskService` 里；现在它们只能通过 CLI 子进程
集成测试覆盖，没法单测。

### messages.ts（512 行）

`server/tools/messages.ts` 的 `runMessageSend`（:71-171）里混着：

- Feishu/Slack 平台分发（:75-91，见 01）
- 频道解析、内容格式化（:116-125）
- 订阅管理副作用（:136-145）
- `runFeishuMessageSend`（:173-240）里还有 owner greeting 状态变更（:215-219）
  ——一个"发消息"命令在改 agent 配置状态。

### 命令模式重复

每个命令各自重复一套：Zod options schema（`AskCommandSchema`、
`MessageSendInput`、env-cli 的若干 schema）、agent 上下文解析、audit 发射、
输出写入。共享的只有零散的 `SharedFlags.extend()`。

## 为什么值得修

- 这是和 01（平台抽象）耦合的问题：业务逻辑下沉到 service 后，
  平台分发自然有了统一的落点。
- tools 层的逻辑目前只能靠 `pnpm test:runtime` 的子进程测试覆盖（慢、粗粒度）；
  下沉后可以单测。

## 建议方向

1. 抽 `AskService`、`MessageSendService`（或并入 01 的平台操作接口实现），
   tools/ 退化为薄 CLI 包装：解析 → 调服务 → 打印。
2. `cli/shared.ts` 定义 `BaseToolOptions` / 共享的 agent 解析 + audit 包装，
   消掉每个命令的重复模板。
