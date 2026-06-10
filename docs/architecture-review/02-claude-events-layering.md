# 02 · claude-events.ts 越界：解析器做文件 I/O、持有会话状态

**严重度：高。** 这是最明确的一处层级违规——设计声明里 provider adapter
"只拥有自己的 CLI 协议"，但事件解析器在做运行时层的事。

## 现状

`server/providers/claude-events.ts`（1121 行）名义上是 Claude 事件解析，
实际内容大致三分：

- ~30% 真正的解析：JSON 事件提取、subtype 分类。
- ~40% 格式化/映射：字段重命名、activity 截断、stats 聚合。
- ~30% 业务逻辑，其中两块明显越界：

### 1. subagent ingest 在解析器里做磁盘 I/O（:691-822）

`ingestPendingClaudeSubagentResultsFromTranscript`、`readClaudeSubagentIdForToolId`
等函数直接读 transcript 文件（`claudeTranscriptPath`）、遍历目录找 agent 日志。
这把"解析协议"和"Claude 会话目录的文件系统结构"耦合进了 provider 层。

### 2. 解析器持有跨次解析的会话状态（:900-922）

`ClaudeJsonlMapperState`（`subagentMetadataByKey`、`pendingSubagentResultsByAgentId`）
在解析器内部创建和维护。状态的归属应该是 adapter（`claude.ts` 的 controller），
解析器应当是无状态的纯函数，状态作为入参传进来。

## 附带观察

- `claude.ts:29-37` 的 `CLAUDE_DISALLOWED_TOOLS` 被 `claude-channel.ts` 跨文件
  import，协议共享常量应放 `contract.ts`。
- `claude.ts`（stream-json stdin/stdout）与 `claude-channel.ts`（HTTP channel）
  双 adapter 的拆分本身是干净合理的——不同传输方式各自实现 `AgentRuntime`。

## 建议方向

1. subagent ingest（transcript 读取、目录遍历）整体移到 `server/runtime/`
   下的独立模块（如 `claude-subagent-ingester.ts`），解析器只暴露回调。
2. `ClaudeJsonlMapperState` 移到 `claude.ts` 的 controller 持有，作为参数传入
   解析函数；解析器改为无状态。
3. `CLAUDE_DISALLOWED_TOOLS` 移到 `contract.ts`。

行为不变的重构，`pnpm test:runtime` 可以兜底。
