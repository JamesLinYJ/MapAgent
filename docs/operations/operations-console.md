# 地理智能平台 本地运维台

地理智能平台 的服务器本机运维入口由 TypeScript 监督后台和 Ink 中文 TUI 组成。它只面向能够登录主机并读取受 ACL 保护密钥的人工运维人员，不提供远程 Shell、网页终端、Agent Tool 或 Automation 动作。

## 使用方式

Windows：

```powershell
.\dev.ps1                     # 启动全部服务并进入 TUI
.\dev.ps1 console             # 只连接 TUI，不改变服务状态
.\dev.ps1 start api           # 无交互启动 API 及缺失依赖
.\dev.ps1 stop worker         # 反向停止仍依赖 Worker 的服务
.\dev.ps1 restart infra       # 按依赖顺序重启原先运行的服务
.\dev.ps1 status --json
.\dev.ps1 logs api --tail 200 --follow
.\dev.ps1 logs all --level error --supervisor
.\dev.ps1 logs all --search "数据库" --supervisor
.\dev.ps1 shutdown            # 停止全部并关闭监督器
```

Linux：

```bash
./dev.sh
./dev.sh console
./dev.sh start api
./dev.sh status --json
./dev.sh logs api --tail 200 --follow
./dev.sh logs all --level error --supervisor
./dev.sh logs all --search 数据库 --supervisor
./dev.sh shutdown
```

在 TUI 中，`q` 和 Ctrl+C 只分离，后台服务继续运行。大写 `Q` 会进入“停止全部并退出”确认，必须完整输入“停止全部”。

## 终端界面与鼠标

界面会依据真实终端视口重排，并对中文宽字符按显示宽度验收：

- `140` 列及以上同时显示服务表、检查器和日志；`100–139` 列通过“详情”在页内展开检查器；`80–99` 列使用紧凑页头、精简表格列和分行操作栏。
- 小于 `80×24` 时停止渲染业务面板，只显示稳定的尺寸提示，避免操作命中错位。
- 鼠标可单击页面标签、服务/账户/审计行和操作按钮；日志、账户和审计区域支持滚轮浏览。悬停、按下、选中和禁用状态都同时使用符号与文字反馈，不只依赖颜色。
- 鼠标使用终端标准的 SGR 1006 坐标帧；Windows Terminal 与支持该协议的现代 Linux 终端可直接使用。输入不是 TTY 或终端不支持时，页头会显示“鼠标不可用”，全部功能仍可通过键盘完成。
- 鼠标协议字节会在进入 Ink 文本框和密码框前被独立解析；无效或超长坐标帧会被丢弃，不会变成搜索词、密码或危险操作确认文本。

常用键盘后备操作：`1–4` 或 Tab 切页，方向键选择，`S/X/R` 启动、停止、重启，`F` 暂停或恢复日志跟随，`Home/End/PgUp/PgDn` 浏览，`?` 查看完整帮助。

开发环境的监督目录使用单进程 `tsx` 入口，由监督状态机统一负责退出、重启和日志；直接运行
`npm run dev --workspace geo-agent-server` 时仍保留文件监听，适合不经过监督器的局部开发。

## 事实源与边界

- `@geo-agent-platform/operations-supervisor` 保存三个固定后台服务的实时状态：`infra`、`worker`、`api`。Electron 桌面窗口不进入监督状态机。
- `concurrently` 只启动命令并提供输出与进程终止能力；依赖、健康、重启、指标、日志与 IPC 都由 地理智能平台 监督器负责。
- 客户端通过 Windows named pipe 或 Linux Unix socket 使用令牌认证的 JSONL 协议。首帧校验协议版本与令牌，单帧最大 64 KiB。
- 写操作携带 `operationId` 并在监督器内串行执行。连接中断后可查询结果，客户端不会自动重放写请求。
- 原生 PostgreSQL/PostGIS 由固定目录与固定启动清单装配；外部端口占用保持 `conflict` 并硬失败，监督器不会把未知进程误认成自己的服务。矢量与栅格瓦片由 Node API 内的窄适配器负责，不再启动额外地图服务。
- CPU 与内存汇总启动进程的完整后代树。无法采集时显示“未知”和原因。
- 日志在进入内存缓冲、IPC 和结构化监督日志前统一脱敏；内存最多保留 10,000 行、8 MiB。Supervisor 将服务、组件、PID、输出流、级别和本机操作事件写入 `runtime/ops/supervisor-<workspace>.<日期>.<序号>.jsonl`，单文件 16 MiB、每日轮转并保留最近 7 个历史文件。
- 桌面端可用 `Ctrl+Shift+L` 打开系统日志；该查看器只连接本机 Supervisor，因此平台 API 或数据库不可用时仍可筛选、暂停跟随和复制当前结果。CLI 与 TUI 使用同一日志事实源，禁止传入任意文件路径。

## 本机账户最高权限

账户页面不要求先知道现有平台管理员密码。授权根是 `GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE` 指向的本机密钥：

- 开发环境首次使用时生成，并在 Windows 上关闭 ACL 继承、仅授予当前用户；Linux 权限固定为 `0600`。
- 生产环境不自动生成，缺失或权限过宽时硬失败。
- 密钥派生不可公开登录、没有平台投影的 Better Auth Console 服务主体。每次账户写操作建立独立短期会话，调用官方 Admin API，完成后立即登出。
- 密钥轮换会派生新主体；旧主体通过官方 Admin API 清理。
- Console 主体不能通过公共认证路由登录、不会出现在普通账户列表，也不能成为账户操作目标。
- 地理智能平台 `platform_admin` 关系继续由事务化 RBAC 仓储维护，并保留最后一个可用管理员保护与失败补偿。

数据库不可用时，账户和审计页会显示真实故障；服务、日志和主机指标仍然可用，可用于恢复基础设施。

账户管理 Console 主体与 [本机 Agent CLI](local-agent-cli.md) 主体是两个不同身份。Console 主体只调用 Better Auth Admin API，永不建立平台投影；Agent 主体的 Better Auth 角色保持普通用户，只在主 API 确认连接来自 loopback 后建立 `platform_admin` 投影。两者都不能通过公共登录进入系统，也不会出现在普通账户列表中。

## 生产部署

生产安装由两个独立事实源组成：WinSW/systemd 管理 `infra`、`worker`、`api` 三项后台服务，Electron 安装包只负责桌面交互。Desktop 不扫描源码树，也不从 Renderer 推导服务地址；打包版本固定读取受保护的 v1 runtime manifest。

### 构建与版本目录

在干净检出中先安装锁定依赖，再生成版本化服务目录和 Desktop 安装包：

```bash
npm ci
npm run build
npm run make --workspace @geo-agent-platform/desktop
```

Desktop 的 Forge `package`/`make` 支持 `package.json` 声明的 Node.js `^22.13.0 || >=24.0.0`；`.node-version` 中的 `24.14.0` 是推荐开发基线，不是专用门禁。该范围取 Electron、Vite、Vitest 等直接工具依赖声明的交集，因此接纳 Node 22 LTS，同时不把依赖未声明支持的 Node 23 误报为可用。Windows ZIP 由项目内 `DesktopZipMaker` 使用 Archiver 生成，不再经过在 Node 25 上调用已移除文件系统接口的 `maker-zip → cross-zip` 链路。`build:desktop` 以及 Desktop 自身的 `package`/`make` 会依次构建 `shared-types`、`conversation-presentation`、`operations-supervisor` 和 Desktop，因此不依赖仓库中残留的 `dist/`。Desktop 版本与平台版本均为 `0.1.0`。服务发布目录必须是不可变的版本目录，例如 Windows 的 `C:\Program Files\地理智能平台\services\0.1.0` 或 Linux 的 `/opt/geo-agent-platform/releases/0.1.0`；升级先安装新目录和新清单，再切换服务，不覆盖正在运行的目录。

Windows `make` 会从 Microsoft 固定 URL 获取 NuGet CLI `6.14.0`，验证仓库内固定的 SHA256 后写入忽略版本控制的 `.squirrel-vendor` 构建缓存。Squirrel 自带的旧 NuGet 只作为其它 vendor 文件来源，不参与 nupkg 打包；下载失败或哈希不符都会硬失败。

普通 `package`/`make` 只用于本机验收：未配置证书时，打包目录、Squirrel nupkg 和 ZIP 都包含 `UNSIGNED-TEST-BUILD.txt`，安装器名为 `地理智能平台-0.1.0-UNSIGNED-TEST-Setup.exe`，可解压测试包名以 `-UNSIGNED-TEST.zip` 结尾，均不得作为生产发布。ZIP maker 只生成 `win32/x64` 测试包。生产发布必须设置 `WINDOWS_CERTIFICATE_FILE`（绝对 PFX 路径）、`WINDOWS_CERTIFICATE_PASSWORD` 和可选的 HTTPS `WINDOWS_TIMESTAMP_SERVER`，再执行：

```powershell
npm run make:release --workspace @geo-agent-platform/desktop
```

该命令启用 Forge 与 Squirrel 的 Authenticode 签名，随后用 `Get-AuthenticodeSignature` 硬校验应用 EXE 和 `地理智能平台-0.1.0-Setup.exe`；缺证书、签名失败、时间戳地址不安全或仍存在 `UNSIGNED TEST` 标记都会失败。

生产主机还必须预先安装 Node.js、Python Worker 的虚拟环境与依赖，以及 PostgreSQL/PostGIS。构建成功不代表这些外部运行时已经安装。

### Runtime manifest 契约

v1 清单字段固定为 `kind`、`schemaVersion`、`projectRoot`、`runtimeRoot`、`apiBaseUrl`、`supervisorTokenFile` 和 `allowedEnvironmentOverrides`。四个路径/地址字段必须通过严格校验，Supervisor 令牌必须位于 `runtimeRoot` 内。未知字段、相对路径、网络路径、API 子路径、重复覆盖项和未知 schema 版本都会阻止 Desktop 启动。

生产 Desktop 的固定清单位置为：

- Windows：`C:\ProgramData\地理智能平台\runtime-manifest.v1.json`
- Linux：`/etc/geo-agent-platform/runtime-manifest.v1.json`

参考 [Windows manifest](../../deploy/runtime/runtime-manifest.v1.windows.json.example) 和 [Linux manifest](../../deploy/runtime/runtime-manifest.v1.linux.json.example)。生产进程不会用 `APP_ENV=development` 绕过清单。`GEO_AGENT_PLATFORM_ROOT`、`RUNTIME_ROOT`、`APP_BASE_URL` 和 `GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE` 只有出现在清单的 `allowedEnvironmentOverrides` 中时才能覆盖对应字段；设置了未授权变量会硬失败。默认应保持空列表。

### Windows 安装

先创建本机 `Geo Agent Platform Operators` 组，把 Desktop 使用者和专用非管理员服务账户加入该组。复制 [生产环境模板](../../deploy/env/supervisor.env.example) 到 `C:\ProgramData\地理智能平台\supervisor.env`，至少确认 `GEO_AGENT_PLATFORM_ROOT`、`RUNTIME_ROOT`、`API_HOST`、`API_PORT`、`DATABASE_URL`、`WORKER_URL`、`APP_BASE_URL`、`BETTER_AUTH_URL`、两个生产密钥和 `ENABLED_TOOL_PROVIDERS` 均为真实生产值。

以管理员 PowerShell 安装令牌和清单：

```powershell
.\scripts\install-desktop-runtime-manifest.ps1 `
  -ProjectRoot 'C:\Program Files\地理智能平台\services\0.1.0' `
  -ServicePrincipal 'HOSTNAME\GeoAgentPlatformService' `
  -RuntimeRoot 'C:\ProgramData\地理智能平台\runtime' `
  -ApiBaseUrl 'http://127.0.0.1:8000' `
  -ServiceEnvironmentFile 'C:\ProgramData\地理智能平台\supervisor.env' `
  -OperatorsPrincipal 'Geo Agent Platform Operators'
```

脚本使用固定 `C:\ProgramData\地理智能平台` 配置根，拒绝链接/reparse point 和越界路径，并为配置根、runtime 根、独立 `runtime\secrets` 目录以及文件分别关闭 ACL 继承。`SYSTEM` 与 Administrators 拥有完全控制；专用服务账户只在 runtime 数据目录拥有修改权，在清单、环境文件和令牌上只有读取权；`Geo Agent Platform Operators` 可读取清单和 Supervisor 令牌，但不能读取包含数据库及服务密钥的 `supervisor.env`。

Supervisor 令牌默认每次安装都重新生成 256 位随机值，并通过临时文件原子替换。只有确认现存令牌来自可信安装时才可显式传入 `-PreserveExistingSupervisorToken`；脚本仍会拒绝链接和非 256 位 base64url 值。清单与 `supervisor.env` 中的 `GEO_AGENT_PLATFORM_ROOT`、`RUNTIME_ROOT`、`APP_BASE_URL`、`GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE` 必须一致。

随后用固定版本且校验 SHA256 的 WinSW 注册 Supervisor：

```powershell
.\scripts\prepare-winsw-services.ps1 -SupervisorEnvironmentFile C:\ProgramData\地理智能平台\supervisor.env
.\scripts\install-winsw-service.ps1 -Service Supervisor -CredentialPrompt
```

WinSW 服务名为 `GeoAgentPlatformSupervisor`。生产服务账户不得使用 LocalSystem、LocalService 或 NetworkService。服务健康后再运行已通过签名校验的 `地理智能平台-0.1.0-Setup.exe`；Squirrel 安装、升级和卸载事件会在获取单实例锁之前创建或删除快捷方式。无签名测试安装器仅可用于隔离测试主机。

### Linux 安装

先把已替换全部占位值的生产环境文件直接安装为 `root:root 0600`，再运行 Linux 安装器。安装器与 Windows 使用同一 v1 字段和受控覆盖白名单，默认轮换 Supervisor 令牌，并拒绝链接、hard link、路径越界、重复覆盖项及环境/清单不一致：

```bash
sudo install -d -o root -g geo-agent-platform-ops -m 0750 /etc/geo-agent-platform
sudo install -o root -g root -m 0600 geo-agent-platform.env /etc/geo-agent-platform/geo-agent-platform.env
sudo bash ./scripts/install-desktop-runtime-manifest.sh \
  --project-root /opt/geo-agent-platform/releases/0.1.0 \
  --service-user geo_platform \
  --operators-group geo-agent-platform-ops \
  --runtime-root /var/lib/geo-agent-platform/runtime \
  --api-base-url http://127.0.0.1:8000 \
  --service-environment-file /etc/geo-agent-platform/geo-agent-platform.env
```

`geo-agent-platform.env` 必须保持 `root:root 0600`（systemd 在降权前读取），清单与令牌使用 `root:geo-agent-platform-ops 0640`，runtime 数据目录由服务账户拥有；三者不得是符号链接。只有确认现有 256 位 base64url 令牌可信时才可使用 `--preserve-existing-supervisor-token`。

保证 `GEO_AGENT_PLATFORM_ROOT` 与替换后的 systemd `@@GEO_AGENT_PLATFORM_ROOT@@` 一致。安装 [systemd 模板](../../deploy/systemd/geo-agent-platform-supervisor.service) 后执行 daemon reload 和启动；模板显式把 `GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE` 作为 `--token-file` 传给 Supervisor，并使用 `KillMode=control-group`。清单必须由 root 所有且不能允许 group/other 写入，否则 Desktop 硬失败。
