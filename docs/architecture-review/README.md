# 架构审查（2026-06-10）

对仓库做的一次架构层面盘点。每个文件一个主题，按优先级编号。
记录的是"看到的问题 + 证据 + 建议方向"，不是重构计划；行号是审查当天的快照，后续以代码为准。

## 总体印象

分层纪律（routes → service → store → primitives）整体执行得不错：

- `shared/` 是干净的纯类型契约层，无运行时逻辑。
- web 路由不直接碰存储，错误处理集中在 `server/web/http.ts`。
- provider 有统一的 `server/providers/contract.ts` 接口和 factory。
- 存储原语（JsonFile/JsonlLog/锁）与 schema store 的边界清晰。
- CLI 层（runtime-cli、services-cli）只做解析、编排和输出，没有业务逻辑。

架构债集中在以下几处，按优先级排：

| # | 主题 | 严重度 |
|---|------|--------|
| [01](01-platform-abstraction.md) | 平台抽象太薄，Feishu 是平行拷贝而非第二个实现 | 高 |
| [02](02-claude-events-layering.md) | claude-events.ts 越界：解析器做文件 I/O、持有会话状态 | 高 |
| [03](03-provider-duplication.md) | 三个 provider adapter 约 300 行可收敛的重复 | 中 |
| [04](04-host-god-module.md) | host.ts 上帝模块；runtime 层就地实例化服务 | 中-高 |
| [05](05-persistence-and-polling.md) | 持久化整文件重写 + 全轮询架构的扩展性天花板 | 中 |
| [06](06-docs-drift.md) | CLAUDE.md / docs 与代码脱节 | 低（改起来便宜） |
| [07](07-tools-layering.md) | tools 层堆积业务逻辑（ask/messages），违反 CLI 分层规则 | 高 |
| [08](08-dependency-graph.md) | 依赖图：providers→inbox 反向边、inbox↔slack-interactions 循环 | 中 |
| [09](09-config-compat-shims.md) | config schema 里的 back-compat shim 违反仓库自身规则 | 高（规则一致性） |
| [10](10-test-architecture.md) | 测试：巨型文件、helper 缺位、providers/storage 无单测、sleep 依赖 | 中-高 |
| [11](11-web-frontend.md) | web 前端在客户端重实现服务端 activity 投影；巨型组件 | 中 |
| [12](12-observability.md) | 无统一 logger；provider completion 吞错 | 中 |

07-12 为第二轮补充。各文件里的"附带观察：做得好的部分"记录了核查过、
**不需要**动的区域（prompt 构建、env 加密、前后端类型契约、React Query
轮询策略等），避免后续重复审查。

## 如果只做三件事

1. **把平台操作抽象立起来**（01）——决定了 Feishu 的维护成本和接第三个平台的可行性，是大部分重复的根因。07（tools 层业务逻辑下沉）和它是同一刀：业务下沉到 service，平台分发才有统一落点，做 01 时会自然解决。
2. **claude-events.ts 的 I/O 与状态外移**（02）——最明确的一处层级违规。
3. **更新 CLAUDE.md**（06）——这份文档是 agent 改代码时的执法依据，失真会让后续改动放错层，债继续积累。

01 和 02 都是行为不变的重构，可以靠 `pnpm test:runtime` 兜底——但注意 10 指出
providers 解析器和 storage 原语缺单测，动 02/03/05 之前先补这块安全网更稳。

**快速修复**（半小时级，可以随手做）：09 的两个 back-compat shim 删除，是纯纪律
修复，仓库没有外部消费者。

## 核实记录

文档里的发现来自分区探查 + 人工抽查关键断言。已逐条核实为真的：

- agent-config.ts 的 back-compat shim（09）——读过源码确认。
- transports 接口只有 start/stop、tools 层 if-feishu-else-slack 分叉（01）——读过
  message-transport.ts 和 tools/messages.ts 确认。
- providers → inbox 反向依赖（08）——grep 确认，**但只有 claude-channel.ts 一处**，
  初始报告称 codex/kimi 也有，是错的，已修正。

**已推翻的误报**（记录在此避免后续审查重复上当）：

- ~~`botAvatarUrl` / Feishu `avatarUrl` 是零读者的死字段~~ —— 实际被
  agent-slack.service.ts、web 端 SlackConnectStepper.tsx 等多处读取。
- ~~activities/format.ts 的 `copyNumber`/`copyString`/`copyActivityPreview`
  无人引用~~ —— 实际被 providers/{kimi,claude-events,codex-events}.ts 和
  diagnostics 使用。

教训：死代码类断言必须 grep 全仓库（含 web/）核实后才可采信。
