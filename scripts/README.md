# 构建与运维脚本

优先从根目录 `package.json` 的 npm 命令进入；工作流专用脚本由对应 GitHub Actions 调用。这里逐文件记录仍在调用链中的职责，未列出的临时脚本不应留在仓库。

## 校验与生成

| 文件 | 调用入口 | 唯一职责 |
| --- | --- | --- |
| `dependency-contract.test.mjs` | `npm test` | 校验跨工作区依赖与脚本索引契约 |
| `run-postgis-integration.mjs` | `npm run test:postgis` | 在显式测试数据库上运行 PostGIS 集成测试 |
| `check-meteorology-terminology.mjs` | `npm run lint:terminology` | 检查气象领域术语 |
| `check-desktop-bundle-budget.mjs` | `npm run check:bundle` | 检查桌面渲染包体积预算 |
| `generate-liquid-glass-maps.mjs` | `npm run generate:glass` | 生成桌面液态玻璃位移图 |

## 运行服务制品

| 文件 | 调用入口 | 唯一职责 |
| --- | --- | --- |
| `create-runtime-service-artifact.mjs` | `npm run release:runtime` 及桌面发布工作流 | 组装可发布的本机运行服务 |
| `verify-runtime-service-artifact.mjs` | `npm run verify:runtime` 及桌面发布工作流 | 校验制品文件集、摘要、签名与可执行性 |
| `runtime-service-artifact.test.mjs` | 默认 `npm test`/CI；也可单独运行 `npm run test:runtime-release` | 覆盖制品生成、验证和信任边界 |
| `run-worker.ps1` | Windows 监督器与运行服务制品 | 启动 Windows Worker |
| `run-worker.sh` | macOS/Linux 监督器与运行服务制品 | 启动类 Unix Worker |
| `run-windows-service.ps1` | WinSW 服务模板与运行服务制品 | 将受控环境文件转换为 Windows 服务进程 |

`runtime-service/` 是生成器和校验器共用的内部模块目录：`artifact-contract.mjs`
统一输入与必需文件契约，`artifact-files.mjs` 守住路径和文件集边界，
`npm-packages.mjs` 管理生产依赖闭包，平台物化、平台探针、签名和 SBOM
分别由同名职责模块拥有。这些模块不是独立命令，不接受额外命令行参数。

## Electron 发布

| 文件 | 调用入口 | 唯一职责 |
| --- | --- | --- |
| `release-pipeline.test.mjs` | `npm run test:release-pipeline` 及发布工作流 | 校验版本、签名、资产和仓库治理链路 |
| `validate-release-version.mjs` | 发布模式解析器、资产整理器和测试 | 读取并校验唯一发布版本；不是单独发布入口 |
| `resolve-desktop-release-mode.sh` | 桌面发布工作流 | 区分验证构建与正式版本发布 |
| `prepare-linux-package-host.sh` | 桌面发布工作流 | 准备 Linux Electron 打包主机 |
| `build-macos-icon.sh` | 桌面发布工作流 | 从权威图标生成 macOS 图标包 |
| `prepare-squirrel-vendor.ps1` | `npm run make:windows --workspace @geo-agent-platform/desktop` | 准备固定版本的 Windows Squirrel 工具 |
| `make-desktop-release.ps1` | `npm run make:release --workspace @geo-agent-platform/desktop` | 构建并核验 Windows 签名包 |
| `import-windows-signing-certificate.ps1` | 桌面发布工作流 | 导入本次 Windows 构建使用的签名证书 |
| `import-macos-signing-identity.sh` | 桌面发布工作流 | 创建临时钥匙串并导入 macOS 签名身份 |
| `prepare-linux-runtime-signing.sh` | 桌面发布工作流 | 准备 Linux 运行服务清单签名材料 |
| `verify-desktop-package-output.mjs` | 桌面发布工作流和发布测试 | 校验各平台 Electron 包结构 |
| `prepare-release-assets.mjs` | 桌面发布工作流和发布测试 | 汇总跨平台产物并生成校验清单 |
| `publish-desktop-release.sh` | 桌面发布工作流 | 发布不可变 GitHub Release |

## 部署与 Windows 服务

| 文件 | 调用入口 | 唯一职责 |
| --- | --- | --- |
| `validate-production-environment.mjs` | 两个平台运行清单安装器 | 在写入前校验生产环境文件；不是独立安装入口 |
| `install-desktop-runtime-manifest.ps1` | Windows 部署手册与契约测试 | 安装 Windows 运行清单及访问控制 |
| `install-desktop-runtime-manifest.sh` | Linux 部署手册与契约测试 | 安装 Linux 运行清单及访问控制 |
| `install-winsw.ps1` | WinSW 服务包生成器 | 下载并校验固定版本 WinSW；不是服务注册器 |
| `prepare-winsw-services.ps1` | Windows 部署手册 | 生成 WinSW 可执行文件和服务配置 |
| `install-winsw-service.ps1` | Windows 部署手册 | 用专用账户注册已生成的 WinSW 服务 |

## 维护与治理

| 文件 | 调用入口 | 唯一职责 |
| --- | --- | --- |
| `apply-repository-governance.mjs` | `npm run apply:repository-governance` 及治理工作流 | 校验或应用 GitHub 仓库规则 |
| `migrate-runtime-file-metadata.mjs` | `npm run migrate:file-lifecycle` | 将旧文件元数据一次性导入当前文件对象表 |
| `reset-conversation-store.mjs` | `npm run reset:conversations` | 经显式确认清理开发对话数据 |

## 保留边界

- `.ps1` 与 `.sh` 成对文件服务不同操作系统，不因逻辑相近而合并。
- `runtime-service/artifact-contract.mjs`、`validate-release-version.mjs` 等共享模块只有一个规则事实源，但由多个入口复用，不应改成复制逻辑。
- WinSW 的“取得工具、生成服务包、注册服务”是三个权限和失败边界，保持分离。
- 会写数据的维护脚本必须要求 `--confirm` 或其它显式授权；发布脚本必须对输入、产物和校验清单硬失败。
- 业务规则属于 `apps/server` 或 `packages`，脚本不得成为第二事实源。
