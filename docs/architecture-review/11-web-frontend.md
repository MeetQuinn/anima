# 11 · web 前端：客户端重实现服务端投影逻辑 + 巨型组件

**严重度：中。** 先说好的：前后端类型契约是真的（web/src/api/* 直接 import
`@shared/*` 类型，没有手抄的响应形状）；轮询策略合理（agent 状态 2s/5s
自适应、activity 3s，批量查询无 N+1）；UI 里的平台分支收敛在展示边界
（feed item 按 kind 多态、connect stepper 各自独立），没有扩散。

## 1. activity-feed 投影逻辑在客户端重实现（主要问题）

`web/src/lib/activity-feed.ts`（912 行）+ `lib/activities.ts`（810 行）在
浏览器端做的事：

- 按类型过滤不可见事件（`runtime.stream.*`、`provider.reasoning` 等）
  ——过滤规则是业务规则，服务端 `listActivityFeed` 才是该拥有它的地方。
- 按 parentToolCallId 把子 activity 分组成 subagent stream（:143-161）。
- 预扫描 reminder-fire 给 message-in 行补 `wakeMeta`（:166-180）。
- 把 `AgentMessageRecord` **反向重建**成 `InboxItem` / `ActivityRecord` 形状
  （:403-565）——客户端在伪造服务端的内部数据结构。

风险：服务端改 activity 类型名、payload 字段或可见性规则时，客户端这 ~250 行
没有任何编译期契约保护，会静默坏掉。另外
`web/src/api/agents.ts:278-313` 已经出现了 `LegacyAgentActivitiesResponse`
归一化垫片——这是投影逻辑放错边的早期症状。

**方向**：feed 的过滤、分组、排序、message→activity 形状桥接移到服务端 API，
客户端只保留 `showAllSteps` 这类纯展示态的二次过滤。

## 2. 巨型组件

- `views/kb/FileViewer.tsx`（1659 行）：frontmatter 解析、TOC 提取、语法高亮、
  Mermaid 渲染 + SVG 消毒、KB 相对链接解析、lightbox、视图切换全在一个组件。
  解析类纯逻辑（`parseMarkdown`、链接解析）应抽成可测的工具模块。
- `views/onboarding/index.tsx`（1070 行）：步骤状态机 + 表单状态 + Feishu
  注册轮询定时器 + API 变更全部内联；步骤抽组件、流程抽
  `useOnboardingFlow()`。
- `views/agents/activity/index.tsx`（859 行）：取数、去重合并、过滤、滚动
  加载混在容器里（行渲染已拆到 MessageRows/AuditRows，是好的）；
  抽 `useActivityFeed()`。

## 建议方向

优先做 1（它和服务端 `messages/` 投影层的边界问题是同一件事，见 05 的
inbox/messages 边界）；2 属于渐进式整理，改到哪个页面顺手拆哪个。
