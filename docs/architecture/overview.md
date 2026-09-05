# 地理智能平台 架构总览

地理智能平台 是一个中文优先的地理与气象智能平台。仓库采用 npm/Python 混合 monorepo：用户体验、Agent 编排、科学计算、结构化事实和本机运维具有独立所有者，通过严格契约连接。

## 仓库布局

```text
apps/
  server/       Node.js API、WebSocket、Agent 编排与治理
  desktop/      Electron + React + MapLibre 桌面 GIS 工作台
  worker/       FastAPI 科学计算边界
packages/
  db/             Drizzle schema、连接工厂与数据库公共类型
  shared-types/ 跨进程 Zod 契约
  conversation-presentation/ 桌面端与 CLI 共用的只读对话展示投影
  gis-meteorology/  地理与气象领域算法
  operations-supervisor/ TypeScript 进程监督器
infra/          PostgreSQL/PostGIS 权威基线与地图种子
deploy/         systemd、WinSW 和生产环境模板
scripts/        开发、校验、部署与数据维护脚本
tests/          跨应用端到端测试
docs/           当前架构、运维、设计与工具接入说明
```

应用统一位于 `apps/`，可复用能力统一位于 `packages/`。任何运行时不得通过扫描目录猜测插件、服务或工具；扩展必须经过显式注册、schema 和能力清单。

## 能力平面

```mermaid
flowchart LR
  UI["体验平面<br/>Electron 桌面工作台 / 本机 TUI / Agent CLI"]
  GOV["治理平面<br/>Better Auth / RBAC / 审批 / 审计"]
  ORCH["编排平面<br/>Session / Thread / Run / Workflow / Automation"]
  EXEC["执行平面<br/>Agents SDK / ToolProvider / Python Worker"]
  DATA["数据平面<br/>PostgreSQL/PostGIS / 对象存储 / 外部数据"]

  UI -->|"Preload IPC / Main HTTP+WS"| GOV
  GOV -->|"授权后的应用命令"| ORCH
  ORCH -->|"RunState、工具与任务"| EXEC
  EXEC -->|"事务写入 / 内容引用"| DATA
  DATA -->|"查询结果 / Artifact / 地图资源"| UI
```

依赖方向固定为：体验层调用应用服务，应用服务编排领域能力，领域能力通过 Port 使用基础设施。基础设施不得反向决定业务规则；UI、缓存和文件投影不得反向成为平台事实源。

## 权威事实

| 事实 | 唯一事实源 |
|---|---|
| 用户、工作区、RBAC、Session、Thread、Run、Transcript、Workflow、Approval、Audit | PostgreSQL/PostGIS |
| 上传内容、Artifact 二进制、SDK checkpoint 载荷、Markdown 记忆正文 | 内容寻址对象存储；数据库保存引用与生命周期 |
| 桌面 Renderer 实时 run、timeline、连接与工作区状态 | Zustand |
| HTTP 可重取查询缓存 | TanStack Query |
| 服务进程、健康、重启预算、指标和日志 | TypeScript operations supervisor 的内存状态与真实进程句柄 |

`runtime/` 是部署配置决定的运行目录，不是源码模块，也不是 Session/Run 的第二事实源。旧文件会话格式不做静默扫描兼容。

跨进程命令与工具目录直接以共享契约、服务端注册表和 Worker 工具目录为准；
接线一致性由契约测试验证，不再维护独立的生成清单。

## 主要运行链路

### Desktop 与 API

1. `apps/desktop` 的 Main 进程持有 Better Auth、HTTP、WebSocket、文件和导出边界；Renderer 只调用经 Zod 校验的 Preload IPC。
2. `apps/server` 在 HTTP upgrade 阶段验证 Origin 和 Better Auth session，再由命令 registry 执行 Zod、CSRF、RBAC 和限速。
3. 路由与 WS handler 只适配协议；资源写入由应用服务和按资源拆分的 PostgreSQL Store 负责。

### Agent

1. 用户消息进入 canonical Thread/Run 和持久输入邮箱。
2. 地理智能平台 RunEngine 拥有持久 Run/Turn/Runner segment、目标版本、审批等待、终态竞争和 child Run 生命周期。
3. `@openai/agents` Runner 只拥有单个 segment 内的模型—工具—handoff 微循环；公开 RunState 是该 segment 的审批中断和恢复载荷。
4. 地理智能平台 负责工作流、权限、工具注册、`valueRef`、数据库事实、审计与分层记忆；不得解析 SDK checkpoint 的内部 JSON 布局。
5. DeepSeek 使用专属 OpenAI-compatible Chat Completions Model 适配器；Provider descriptor 限定可选模型和真实能力。
6. ToolProvider 经过 manifest/schema 一致性校验后才可注册。Python 工具契约以 Pydantic catalog 为事实源。
7. Desktop Chat 与本机 Agent CLI 都从 `packages/conversation-presentation` 获取消息分类、工具调用配对和公开展示标识；DOM Markdown 与终端 Markdown 只是两个最终渲染目标，不得各自重建业务投影。

### 科学计算

`apps/worker` 只处理 FastAPI 路由、中间件、HMAC 和路径沙箱；领域算法位于 `packages/gis-meteorology`。Worker 无权持有 Session/Thread/Run 状态，只接受 `RUNTIME_ROOT` 内经过验证的相对对象引用。

### 本机运维

`packages/operations-supervisor` 监督固定的 `infra`、`worker`、`api` 三项后台服务。`concurrently` 仅作为子进程执行适配器。Electron 自身不进入 Supervisor；运维 TUI 和 Agent CLI 是本机人工入口，不是网页终端、Shell、Agent Tool 或 Automation 动作。

## 关键边界

- 所有 HTTP、WS、Worker、数据库、文件和模型输出都在进入内部逻辑前经过 schema。
- 公共成员接口只能授予工作区角色；`platform_admin` 使用独立保护边界。
- 本机保留主体不能公开登录。Agent 主体仅在 TCP 对端被证明为 loopback 后可进入 WS。
- 开发者文件工具无条件拒绝 `.env*`、私钥、令牌、密钥和整个运维密钥目录。
- schema 漂移、权限失败、工具失败、对象写入失败和 Worker 失败必须硬失败，不得伪造成功。

## 架构验证

核心结构守卫位于：

- `apps/server/src/architecture.test.ts`
- `apps/desktop/src/renderer/__tests__/architecture.test.ts`
- `packages/operations-supervisor/src/*.test.ts`
- `apps/worker/tests/scan_security.py`

目录迁移、扩展点或事实源变更必须同时更新守卫，并至少证明依赖方向、失败路径和真实运行链路。

## 待完成的稳定版验收

以下是历史重构计划中仍未关闭的验收项；清理计划文档不代表这些项目已经通过。发布须以当前源码和正式应用重新核验，不能复用历史测试数量作为结论。

- 正式 macOS arm64 应用无感启动本地服务，不出现平台地址或登录表单。
- 两个窗口同时编辑运行配置或模型服务时，只有一个版本保存成功，另一窗口保留草稿。
- 至少 200 条历史下连续提问三轮，从当前位置直接到底；流式正文、工具结果、审批、取消、恢复、任务切换及后台重连不丢失、不重复。
- 1024×768 与 1440×900 下检查输入框、滚动、键盘操作和 macOS 标题栏，内容不被系统按钮遮挡。
- 验证持久输入、审批、工具副作用、上下文换窗、沙箱、MCP 工具和子运行的恢复矩阵；未知副作用不得自动重放。
- 使用不同真实问题核验缓存，只报告供应商返回的实际缓存词元；未经授权不读取系统或模型密钥。
- 对同一发布版本完成全量测试、构建、Python 测试、桌面规范检查、死代码检查、端到端测试和打包，分别记录自动化与正式应用验收结果。

统一用户任务树、MCP 资源与资源模板、完整 OAuth、沙箱跨进程恢复属于后续增强，不计入本轮稳定版完成范围。
