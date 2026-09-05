# ADR-0001：Agent RunEngine 与 Agents SDK Runner 的所有权边界

- 状态：Accepted
- 日期：2026-08-18
- 决策者：地理智能平台维护者
- 参考：[架构总览](overview.md)

## 背景

现有运行时已经实现 steering、审批、checkpoint、工作流、Goal、MCP、Skill、Sandbox 和子智能体，但平台事实、SDK RunState 与 UI 投影之间存在多处同步。继续让 SDK Runner 同时承担持久 Run 生命周期，会迫使平台接触 SDK 私有字段或序列化内部布局。

## 决策

采用 **Codex-inspired, Agents-SDK-native** 分层：

1. 地理智能平台 RunEngine 拥有持久 Run、Turn、Runner segment、输入邮箱、领域目标、终态竞争、child Run、审计和投影。
2. OpenAI Agents SDK Runner 是单个 segment 内唯一的 model/tool/handoff/Agent-as-tool 微循环。
3. 同一 Run 任一时刻最多一个活动 Runner segment；不同 child Run 可以在根预算内并行。
4. SDK RunState 作为 opaque 的公开恢复载荷保存。平台只能使用 SDK 公开 history、interruption 和恢复 API；不得解析内部 JSON 字段。
5. 仍未被 SDK 公开 API 覆盖的活动 Runner steering 写回被限制在一个有架构守卫的防腐文件中，并在 segment 化迁移完成后删除。

## 后果

- 可以逐步引入 StepContext、GeoWorldState、tool ledger 和 durable child Run，而不复制 SDK 的模型调用循环。
- SDK 升级必须先通过版本锁定、checkpoint、steering、approval、MCP、sandbox 和打包回归。
- 新代码不得直接访问 SDK 内部状态；架构测试会阻止边界回流。
- 跨 SDK 版本 checkpoint 默认拒绝恢复，不做 best-effort。

## 被拒绝的方案

- 完全照搬 Codex Rust runtime：会重复 Agents SDK 已有能力，并扩大维护面。
- 继续把 SDK Runner 视为整个平台 Run 的唯一所有者：无法清晰表达持久 child Run、segment 重装配和平台事实源。
- 手写 Responses function-call loop：与 Agents SDK 重复并容易造成两套工具/审批状态机。
