# 12 · 可观测性：无统一 logger，若干吞错点

**严重度：中。**

## 1. 日志策略是 console + activity store 的混合

server/ 非测试代码里约 127 处 `console.log/warn/error`，与 activity store
的审计写入并存，没有统一的 logger 接口。后果：

- 排障时无法在一个地方关联"agent 进程日志"和"活动审计"。
- 日志去向依赖进程怎么被拉起（supervisor 重定向到
  `$ANIMA_HOME/logs/*.log`），格式无结构，难 grep。

不需要引重型日志库；一个包装 console + 可选 activity 写入的极小接口
（`warn/error` + 模块前缀）就够。

## 2. 吞错的 `.catch(() => {})`

约 11 处空 catch，分两类：

- **可接受**（清理路径，失败无可行动作）：`storage/lock.ts` 的锁清理、
  `providers/child-process.ts` 的进程收尾、services/restart 的清理。
  按仓库规则这类该留——但值得加一行注释说明"为什么可忽略"。
- **值得看**：`providers/claude-channel.ts:164` 等 provider 的 completion
  promise 吞错——turn 失败被静默，排障时只能看到"没反应"。至少应记一条
  activity 或 console.error。

## 3. 类型断言集中点（与 08 重合，列在此处便于跟踪）

- `runtime/runtime-session.service.ts:226,245,262,286` — 4 处
  `as unknown as ProviderSessionStatsSummary`，同一形状转换重复四次，
  应换成一个 Zod 校验函数。
- `feishu/client.ts:890` — SDK 类型不匹配的 cast，包一层类型安全的封装。

## 建议方向

1. 引入最小 logger 接口，replace console 散点（机械替换，可以渐进做）。
2. provider completion 的吞错点改为记录后忽略。
3. 两处 cast 集中点用 Zod/封装收口。
