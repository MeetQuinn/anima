# 05 · 持久化整文件重写 + 全轮询架构的扩展性天花板

**严重度：中。** 当前消息量下都能工作；量上来后最先疼的是这里。
JSON 文件 + 文件锁的选型本身适合本地运行时，问题在几个具体模式。

## 整文件重写

以下 store 每次变更都全量重写整个 JSON 文件：

- `server/storage/schema/subscription.store.ts:87-99` — `replace` / `remove`
- `server/storage/schema/interactive-ask.store.ts:73,80`
- `server/storage/schema/session.store.ts:79,87`
- `server/storage/schema/reminder.store.ts:44-62`

订阅会随频道数累积，asks 在 prune 前无界增长。

## O(n) 热路径

- `server/storage/schema/message.store.ts:24-35` — `appendIfRecent` 每次 append
  读最近 1 万条做去重，JSONL 越大越慢。
- `server/storage/schema/activity.store.ts:49` — `readBefore` 反向分页要读全文件
  （jsonl-log.ts 的 seek-from-end 优化只帮正向）。
- `server/inbox/wake-queue.service.ts:60-80` — `claimNext` 全量读 inbox 再在内存里
  找第一个 queued；`claimNextFollowup` 调了两次 `listRunnable`。

## 全轮询，无事件驱动

同一个 agent 进程内的组件之间也靠定时器轮询通信：

- worker 每 1s tick 一次（`runtime-worker.ts:92-94`）。
- followup appender 每 100ms 轮询（`followup-appender.ts:36-54`）。
- host 每 30s reconcile、每 5s 发健康快照（`host.ts:129-138`），不管有没有变化。
- 文件锁 25ms 自旋等待（`storage/lock.ts:14-24`），stale 锁只在碰撞时清理。

## 双队列边界模糊：inbox.json vs messages.jsonl

- `inbox.json`（wake-queue.store）既是瞬态工作队列又是持久账本
  （wake-queue.service.ts:194-203 有 30 天保留策略）。
- `messages.jsonl` 是只读投影，却在**首次读取时惰性回填**
  （`server/messages/message.service.ts:55-73`，同时读 WakeQueueStore 和
  ActivityStore），与队列变更之间存在微妙竞态。

## 其他

- 跨 store 无事务：如 `agent.service.ts:157-160` 先改 session 再记 activity，
  中间失败则不一致。单文件内的 RMW 有锁保护，是安全的。
- 15+ 个 `defaultXxxService` 模块级单例，初始化顺序是隐式的；
  `kb.service.ts:25-35` 的实例缓存不感知 ANIMA_HOME 变化（测试要手动
  `clearCaches`）。
- `client-error-routes.ts:81-95` 的 maxArchives 上限设置在路由层而不是 store 层，
  各日志的留存策略不一致。

## 建议方向

1. 明确声明：`inbox.json` = 瞬态工作队列，`messages.jsonl` = 不可变追加账本；
   回填改为 agent 初始化时急切执行，而不是首次 list 时。
2. `appendIfRecent` 去重窗口加上限或在内存里索引最近消息。
3. 进程内轮询改为 event emitter 唤醒（同进程组件不需要靠磁盘+定时器通信）；
   健康快照改为变化时发布。
4. 高频变更的 store（subscription）若成为瓶颈再考虑 append-only / WAL 模式——
   先量化再动。
