# 10 · 测试架构：巨型文件、helper 缺位、按层看的覆盖缺口

**严重度：中-高。** 测试分层（unit/api/runtime 三档 + fast gate）的设计本身
是有原则的，问题在组织方式和覆盖结构。

## 1. 巨型测试文件没有沿模块边界拆

- `tests/feishu.test.ts`（3328 行，65 个用例）混着：消息规范化、reaction、
  delivery prompt、目录补全、鉴权、应用注册——对应源码里至少三个模块。
- `tests/web-api.test.ts`（2641 行）混着 snapshot、activity feed、token 用量、
  健康、Slack 集成、配置变更。
- `tests/agent-runtime.test.ts`（1880 行）是三个 provider 的测试拼在一起，
  按 provider 拆开各 200-400 行。
- `tests/cli-message.test.ts`（1460 行）混 send/read/订阅/审计/格式化。

后果：定位失败用例、并行跑、只重跑相关测试都变难。

## 2. helper 层只有 145 行，样板到处复制

`tests/helpers/` 只有 state.ts / slack.ts / inbox.ts 三个小文件。与此同时：

- **28 个测试文件**各自重复 `mkdtemp + withAnimaHome` 的环境搭建样板。
- mock Slack HTTP server 在 cli-message.test.ts:1406-1435 和 cli-file.test.ts
  各写一份。
- fake Feishu client（feishu.test.ts:88-122）、10 个 mock runtime 类
  （runtime-worker.test.ts:763-997）都内联在测试文件里。

## 3. 真实计时依赖（脆弱 + 慢）

约 16 处显式 `setTimeout` 等待（10-150ms）代替条件等待：

- runtime-worker.test.ts:144,866,876,893,912,957,960（150ms × 2 的用例，
  22 个用例累计 ~3s 纯睡眠）
- feishu.test.ts:1163、reminders.test.ts:421 等

慢 CI 上这是 flake 的主要来源。worker/appender 改成事件驱动（见 05）后，
测试也能改成等事件而不是睡固定时长。

## 4. 按层看的覆盖缺口

完全没有专属测试的模块：`transports/`、`slack-interactions/`、
`diagnostics/`、`runtime-management/`（仅 runtime-upgrade 有）、
`activities/`、`settings/`、以及最值得注意的：

- **`agents/`**（8 个文件，agent.service / agent-slack.service /
  agent-feishu.service）只通过 web-api 测试间接覆盖。
- **`providers/`** 核心 controller 只通过 agent-runtime 的子进程测试覆盖，
  没有针对解析器/状态机的单测——这正是 02/03 要重构的区域，缺单测会让
  重构风险变高。
- **`storage/`** 原语（json-file、jsonl-log、lock）没有直接测试。

这与 07 是同一个问题的两面：业务逻辑住在 tools/CLI 层，就只能用慢的子进程
测试覆盖；下沉到 service 后才可单测。

## 5. tier 错配

feishu.test.ts 在 unit tier（30s 超时）里，但每个用例 mkdtemp + 全量读状态，
实际是最重的"单元"测试文件；按 1 拆分后规范化部分留 unit，鉴权/注册部分
归 api/runtime。

## 建议方向

1. 巨型测试文件沿源码模块边界拆分。
2. 把 ANIMA_HOME 搭建、mock Slack server、fake Feishu client、mock runtime
   收编进 `tests/helpers/`。
3. sleep 改条件等待（轮询断言或事件钩子）。
4. 给 storage 原语和 provider 解析器补单测——它们是 02/03/05 重构的安全网。
