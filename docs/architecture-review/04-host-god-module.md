# 04 · host.ts 上帝模块；runtime 层就地实例化服务

**严重度：中-高。**

## host.ts 一个类管五件事（906 行）

`server/runtime/host.ts` 同时负责：

1. agent 装配与生命周期（start/stop/reconcile）。
2. config 文件 watch + 150ms debounce（`syncConfigWatchers`）。
3. 健康快照发布（每 5s，`publishKnownHealthSnapshots`，不管状态有没有变）。
4. 重启编排（`forceRestartAgent`、`writeRestartPending`）。
5. 重启前的 stale item 恢复（`resolveStaleRestartItem`，:533-547）。

composition root 本身应该只做装配；watch、健康发布、重启编排各是可以独立
拥有的关注点。

## runtime 层就地 new 服务，而不是注入

- `server/runtime/active-item.ts:35,43` — `findActiveRuntimeItem` /
  `findToolAuditRuntimeItem` 每次调用都 new 一个 `WakeQueueService` 并全量读
  item 列表。
- `server/runtime/context.ts:13` — `runtimeContextForItemId` 同样就地实例化。
- `server/runtime/host.ts:535` — `resolveStaleRestartItem` 再来一次。

依赖方向是对的（runtime → inbox service），但绕过了注入，既浪费 I/O 也让
测试只能整体 stub。

## "item 卡住"的判定散落三处

- `runtime-worker.ts:31` — `STALE_RUNNING_RECOVERY_MS = 30min`（运行中超时恢复）。
- `active-item.ts:15` — `TOOL_AUDIT_SETTLED_ITEM_GRACE_MS = 2min`（settled 后的
  tool audit 宽限期）。
- `host.ts:533-547` — 重启前独立的 stale 恢复逻辑。

三个超时服务于重叠的关注点，没有单一的状态判定来源。另外
`active-item.ts` 既读状态（find）又写状态（`setActiveRuntimeItem` 直接调
`queue.markRunning`），worker 也直接调 `queue.complete`——双写者，契约是隐式的。

## runtime-management/runtime-upgrade.ts（759 行）

托管升级是可选功能，但一个文件里混了：npm registry 版本检查、版本比较、
升级状态机（check/apply/poll）、worker 进程拉起、dashboard 健康验证、
settings 持久化、锁协调。它通过重启间接耦合到 host.ts。

## 建议方向

1. host 拆为：装配（composition root 本体）、ConfigWatcher、HealthPublisher、
   RestartOrchestrator。
2. `WakeQueueService` 经 `RuntimeWorkerConfig` / host handle 注入，消灭三处
   就地实例化。
3. stale/恢复超时收敛为一个 ItemStatePolicy（`recoverIfStale`、
   `isToolAuditEligible`），item 状态变更收敛为单一写入方。
4. runtime-upgrade 拆出明确的接口（UpgradeAvailability / UpgradeExecutor），
   让核心 host 在没有它时也完整可用。
