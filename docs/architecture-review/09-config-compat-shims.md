# 09 · 配置体系：back-compat shim 违反仓库自己的规则

**严重度：高（规则一致性），实际风险中。** CLAUDE.md 明文规定
"No backwards-compatibility shims"，但 config schema 里有两个长期存活的
兼容垫片。

## 证据（已核实）

`shared/agent-config.ts:431-444`，`agentConfigSchema()` 的 `z.preprocess` 里：

```ts
// Back-compat: `runtime` → `provider`
if (next.provider === undefined && next.runtime !== undefined) {
  next.provider = next.runtime;
}
delete next.runtime;
// Back-compat: `operator` → `owner`
if (next.owner === undefined && next.operator !== undefined) {
  next.owner = next.operator;
}
delete next.operator;
```

这段在**每次读配置**时执行（经 `agent-config-ops.ts` 的 schema 解析），
让旧 key 的配置文件永远能静默通过，旧字段名永远死不掉。

## 其他观察

- **config watcher 的小竞态**：`host.ts` 的 config 文件 watch 带 150ms debounce，
  之后经 `json-file.ts` 的 mtime+size 缓存读取。两次写入落在同一 debounce
  窗口内时，reconcile 可能读到中间状态。低概率，但 watcher 触发后先
  `cacheDelete(path)` 再读可以消除。
- **写路径是收敛的**：配置写入集中在 `agent.service.ts` 的 `saveConfig()`，
  web 路由和平台服务都经它走，加上进程内锁 + 文件锁 + 临时文件原子重命名，
  并发安全性没问题。
- **做得好的部分**（无需动）：prompt 构建干净——standing prompt 用 Mustache
  模板的 `{{#slack}}/{{#feishu}}` 条件块，delivery prompt 按 `event.kind`
  分发，平台差异没有泄漏到别处；`server/env/` 的密钥处理
  （dotenvx 加密、0600 权限、危险 env key 黑名单）设计扎实；
  `agent-skills.ts` 是纯文件系统扫描，归属正确。

## 建议方向

1. 写一次性迁移（或直接在加载失败时报错提示 key 已改名），删除 preprocess
   里的两个 shim。仓库没有外部消费者，按自己的规则应该直接切。
2. config watcher 触发时显式失效缓存。
