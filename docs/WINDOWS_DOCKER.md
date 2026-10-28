# Windows、WSL2 与 Docker 迁移方案

本文是跨平台接管与后续实施约束。**当前正式版本在 Ubuntu 24.04 x86_64 本机运行，没有使用 Docker。Windows、WSL2 和 Docker 尚未进行本项目的完整运行与恢复验收。** 不要将本文件中的适配路线当成已经交付的一键安装器。

## 路线与状态

| 目标环境 | 推荐路线 | 当前状态 |
|---|---|---|
| 当前 Ubuntu，换 DOTS、WorkBuddy、Hermes、OpenClaw 等宿主 | 保持数据库及服务，宿主通过 MCP stdio 或 CLI 接入 | 通用接口可用；具体宿主须验证 |
| 另一台 Ubuntu 24.04 x86_64 | 代码与匹配运行时、逻辑备份、原件，在全新目录恢复 | 同系统隔离恢复已验证；目标电脑仍须验收 |
| Windows 上使用 Agent CRM | WSL2 内安装 Ubuntu 24.04，在 Linux 文件系统中恢复；Windows 宿主通过 `wsl.exe` 启动 MCP/CLI | 推荐适配路线，未实机验收 |
| Windows 原生 PowerShell 运行整个后端 | 另写进程、文件锁、运行时和服务管理适配 | 尚不支持 |
| Linux 或 Windows Docker Desktop | 完成容器网络、运行时和备份适配后，以 Linux 容器运行 | 设计阶段，见 [Docker 说明](../deploy/docker/README.md) |

同机换 Agent 不等于迁移数据库。只需为宿主配置本机 reader/writer 入口；宿主没有本机工具执行能力时，不能仅凭导入 Skill 连接本机数据库。云端宿主也不能把其自身的 `127.0.0.1` 当成本机电脑。

## 为什么当前不能原生运行于 Windows 或直接放入容器

已核对实际代码，而非仅根据依赖名称判断：

- `ops/manage.py` 使用 POSIX 文件锁、Linux 进程检查和当前 Ubuntu x86_64 二进制布局；`ops/install-user-service.py` 使用 systemd 用户服务。
- `runtime/` 中 PostgreSQL 16 和 Redis 7 是 Linux 运行文件，不能交给 Windows 直接执行。Node 及部分依赖也需要与 CPU、操作系统匹配。
- `src/server.mjs` 仅监听本机 loopback，验证请求的 Host/Origin；客户端配置也只接受本机 URL。
- Twenty 的网络预加载限制仅允许 loopback。把数据库改为容器服务名 `postgres`，并不能在保持现有网络限制的情况下直接工作。
- 现有备份/恢复命令管理本机 PostgreSQL、Redis、Twenty API/worker 和能力服务；它们不是 Docker Compose 的生命周期控制器。

这些限制可以逐项适配，不能靠复制一个 `compose.yaml` 宣称已完成跨平台部署。

## Windows 首选：WSL2

### 1. 准备隔离的 Linux 环境

在 Windows PowerShell 中先检查发行版与 WSL 版本：

```powershell
wsl --list --verbose
wsl --list --online
```

没有合适发行版时，按微软文档安装 WSL2 与 Ubuntu 24.04；启用系统功能可能需要管理员权限和重启。具体发行版名称以 `wsl --list --online` 为准。[微软 WSL 命令说明](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

在 WSL 内使用普通 Linux 用户，准备 Node 24、Python 3 和与发行版/CPU 匹配的 PostgreSQL 16、Redis 7 运行时。分享包仅含源码，不含 `runtime/`、`node_modules/` 或 Twenty 编译产物，不能当成开箱即用的 Windows 程序。`npm ci --ignore-scripts` 只恢复根 Node 依赖，不安装 PostgreSQL、Redis 或 Twenty 全部构建产物；运行时布局与 Twenty 构建仍按 [INSTALL](INSTALL.md) 准备。不要拿 Windows Node 去运行 Linux 的 `node_modules`。

项目建议放在 WSL 内的 `/home/<用户>/agent-crm`，数据库及附件仍在其 `.local/` 中。避免将持续运行的数据库和依赖树放在 `/mnt/c/`、OneDrive 同步目录或网络盘。微软建议使用 Linux 工具时将项目保存在 WSL 文件系统内，以改善性能；Windows 可通过 `\\wsl.localhost\<发行版>\home\<用户>\agent-crm` 查看文件。[微软文件系统说明](https://learn.microsoft.com/en-us/windows/wsl/interop)

### 2. 按逻辑备份恢复

旧机器先创建并校验完整备份，保留旧实例。将应用代码、锁文件、匹配运行时及备份带到 WSL；原件已包含在完整备份中。按 [MIGRATION](MIGRATION.md) 恢复到全新目录，并核对恢复报告、资料及附件哈希。

**不要把 Linux 的 `.local/postgres/` 当成跨操作系统的通用数据库包。** 当前 PostgreSQL 主版本为 16；使用 `pg_dump`/`pg_restore` 逻辑迁移，保持扩展和应用版本兼容。PostgreSQL 官方明确区分逻辑转储的可迁移性与原始数据文件的版本/架构约束。[PostgreSQL 16 备份说明](https://www.postgresql.org/docs/16/backup-dump.html)

恢复完成后在 WSL 中执行：

```bash
./ops/crm start
./ops/crm status
```

在 WSL 内查询健康并验证材料后，再测试 Windows 宿主接入。先用手动启动验证；需要常驻服务时，确认发行版已启用 systemd、用户服务管理器可用，再按 `INSTALL.md` 安装用户服务。WSL 支持 systemd 不代表现有服务在每台 Windows 电脑上都能直接安装，也不保证 Windows 启动后 WSL 自动运行或睡眠期间任务执行。[微软 WSL systemd 说明](https://learn.microsoft.com/en-us/windows/wsl/systemd)

### 3. Windows 宿主通过 WSL 启动 MCP

新接管命令可生成桥接配置，建议在目标环境准备好后生成，避免写入旧机器的绝对路径。在项目根目录执行以下示例，将发行版、路径和 Node 位置替换为目标实际值：

```bash
./ops/crm connection --host workbuddy --reader \
  --wsl Ubuntu-24.04 \
  --project-root /home/your-user/agent-crm \
  --node /home/your-user/.local/bin/node
```

其他宿主可选择 `--host generic`；生成配置不等于宿主已经接通，仍需下面的工具发现与健康检查。生成器使用发行版的默认 Linux 用户；确认该用户有权读取指定客户端文件，并且没有意外使用 root。

以下是通用 MCP stdio 配置示例，不是任何指定宿主已经验证的配置格式。将发行版、Linux 用户、项目路径和 Node 路径替换为目标机器的实际值。Node 路径在 WSL 内用 `command -v node` 查询。

```json
{
  "mcpServers": {
    "agent-crm": {
      "command": "wsl.exe",
      "args": [
        "--distribution", "Ubuntu-24.04",
        "--user", "your-user",
        "--exec", "/usr/bin/env",
        "CRM_CLIENT_CONFIG=/home/your-user/agent-crm/.local/reader-client.json",
        "/home/your-user/.local/bin/node",
        "/home/your-user/agent-crm/src/mcp.mjs"
      ]
    }
  }
}
```

此路径让 MCP 适配器与服务都处于 WSL 内，避免依赖 Windows 到 WSL 的端口转发模式。令牌保存在 Linux 客户端文件中，不放进 JSON 示例或命令行。宿主必须支持执行 `wsl.exe`、保持 stdin/stdout 管道和 MCP 工具调用；若只支持远程 HTTP MCP，当前 stdio 入口不能直接冒充兼容。

先发现工具并调用 `crm_health`，检查分页材料和客户来源；通过后确需录入时将客户端文件改为 `writer-client.json`。owner 凭据留给本人处理确认操作。MCP stdout 只输出协议内容，启动脚本、shell 配置或代理不要向 stdout 输出横幅。

CLI 也可通过 PowerShell 启动，路径同样需要替换：

```powershell
wsl.exe --distribution Ubuntu-24.04 --user your-user --exec /usr/bin/env CRM_CLIENT_CONFIG=/home/your-user/agent-crm/.local/reader-client.json /home/your-user/.local/bin/node /home/your-user/agent-crm/src/cli.mjs status
```

不要为 Windows 宿主接入而把 PostgreSQL 或管理台开放到局域网。Windows 浏览器访问管理台的效果取决于 WSL 网络配置，需另行验证；上述 stdio 方案不需要放开数据库端口。

## Docker 后续实施与验收

完整设计约束见 [deploy/docker/README.md](../deploy/docker/README.md)。本轮没有更换当前运行方式，也未安装 Docker、拉取镜像或迁移正式数据库。

Docker Desktop 的适用条件和许可需在实际部署时核对。其官方 Windows 安装文档列明：较大企业的商业使用需要付费订阅；不能因为工程可以分享就假设每个接收方的 Docker Desktop 都免费。[Docker Desktop Windows 安装与条款提示](https://docs.docker.com/desktop/setup/install/windows-install/)

Windows / WSL2 / Docker 任一路线投入真实使用前，至少验证：

1. 全新环境可重建依赖并启动；仅预期的本机接口可访问。
2. 同一组原件和记录经恢复后 ID、关系、历史、文件大小与 SHA256 一致。
3. 重启服务、重启电脑后资料仍完整；原件权限和映射路径正确。
4. 宿主 MCP 的 reader/writer 权限、重复上传、冲突、纠错和六态待办仍符合契约。
5. 500 MB 原件流式导入、下载和备份恢复通过；MCP 内联仍受 32 MiB 边界约束。
6. 维护窗口能停止全部应用写入，恢复失败不覆盖旧实例，并有可实际执行的回滚流程。

## 分享给朋友

朋友应收到净化的代码/文档/锁文件与安装说明，为其生成独立数据库、客户目录和新凭据。不要把自己的 `.local/`、备份、导出、聊天、客户附件或访问令牌放进公开分享包。分享源码与把本人客户数据迁移给自己，是两个不同操作；同一台电脑上新建演示实例也应使用独立目录和端口。

源码许可与上游组件许可需随分享包保留；不要把原朋友项目的旧 `.env` 或模型密钥带入。需要分享真实业务资料时仍由本人明确决定范围与接收方。
