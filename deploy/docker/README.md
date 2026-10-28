# Docker 部署设计（待实施与验收）

此目录保留 Agent CRM 的容器化方案。**当前没有受支持的 Dockerfile / Compose 启动文件；正式环境仍是 Ubuntu 原生运行。** 本文用于后续 Agent 实施，不应执行一个缺失服务的临时 Compose 文件来替代正式环境。

Windows 优先使用 WSL2 内的 Ubuntu 路线，见 [WINDOWS_DOCKER](../../docs/WINDOWS_DOCKER.md)。容器化是可选的运行环境封装，不改变 MCP/CLI 契约、领域规则、稳定 ID 或证据存储格式，也不意味着资料自动进入云端。

## 目标服务与数据

| 服务 | 责任 | 持久数据 / 启动约束 |
|---|---|---|
| `app` | HTTP 管理台、领域工具、有限 Twenty 投影 | 原件目录读写；配置只读；等待数据库迁移成功 |
| `postgres` | PostgreSQL 16 | 同一实例内保留 `portable_crm` 和 `twenty_crm`，精确镜像版本及 digest 锁定 |
| `redis` | Redis 7 队列与缓存 | 密码与专用目录，不当成业务事实来源 |
| `twenty-api` | 已锁版本的 Twenty API | 保留 `APP_SECRET`、工作区与存储目录 |
| `twenty-worker` | 同版本 Twenty 后台 worker | 连接相同数据库、Redis、存储；不执行 Agent AI 推理 |
| `migrate` / `backup` / `restore` | 一次性运维任务 | 迁移失败停止启动；维护锁、逻辑转储和原件校验 |

Twenty 是当前交付的一部分。若未来提供不带 Twenty 的轻量发行版，应作为独立 profile 明确标注，并先改造配置、健康检查和备份/恢复格式；不能仅删除两个容器，然后声称现有完整备份仍能原样恢复。

向量检索按项目方案另行实施。当前不需要为 Docker 预先启用 pgvector 或外部向量服务；以后启用时锁定扩展版本和镜像来源，验证 PostgreSQL 16 兼容、备份恢复和索引重建。

建议容器模式使用以下隔离目录，**不直接复用当前正在运行的原生 PG 数据目录**：

```text
agent-crm/
├── .local/
│   ├── docker/
│   │   ├── config/          容器专用私密配置
│   │   ├── postgres16/      容器 PostgreSQL 原始数据
│   │   ├── redis/           容器 Redis 状态
│   │   └── twenty-storage/  Twenty 存储
│   └── data/objects/        原件，保持既有相对对象引用
└── backups/                已校验的逻辑备份
```

上述布局是设计，不代表这些目录已创建。通过项目内 bind mount 保证资料位置明确；Docker 官方区分了宿主路径的 bind mount 与由 Docker 管理的 named volume。若改用 named volume，必须将其位置与专用导出流程写清，不能再告诉用户“复制整个项目目录就包含全部数据”。[Docker 挂载说明](https://docs.docker.com/engine/storage/bind-mounts/)

Windows 上的项目与数据库建议位于 WSL Linux 文件系统，避免把运行中的数据库数据目录放进自动同步的 Windows 目录。原始目录物理复制不能代替逻辑备份；跨平台、架构和 PostgreSQL 大版本迁移遵循 [MIGRATION](../../docs/MIGRATION.md)。

## 实施前必须改造的实际代码

1. **监听与客户端地址分开配置。** 容器内部 `app` 要监听容器接口，例如 `0.0.0.0`；外部只将管理端口绑定宿主 `127.0.0.1`。同时保留 Host/Origin 白名单与认证。当前 `server.mjs` 固定 loopback，不能直接使用普通 bridge 网络端口映射。
2. **显式容器依赖。** 将数据库、Redis 与 Twenty 的连接地址变成容器网络配置；不要假设每个容器的 `127.0.0.1` 都指向同一服务。当前 Twenty 网络限制只允许 loopback，需改造成可审查的内部服务白名单，并验证没有开放任意外发。
3. **运维生命周期适配。** 当前 `ops/manage.py` 使用本机二进制、PID、文件锁和 systemd 协作。容器模式应使用 Compose 管理启动与停止，补齐可验证的数据库/应用就绪检查与 SIGTERM 退出逻辑，不能在容器内硬套旧用户服务。
4. **一致备份。** 停止 `app`、Twenty API 与 worker 的写入，记录旧运行状态，对两个数据库做逻辑转储，复制原件和 Twenty 存储，写入版本/哈希/指纹清单，最后恢复原状态。备份失败也应正确恢复服务并保留错误；健康监督不能在维护窗口重新开启写入。
5. **新目标恢复。** 在独立目录/Compose project 中恢复，保留 Twenty 应用密钥、稳定 ID 和旧投影角色；生成新的数据库密码与 reader/writer/owner token。核对全部表和原件后才切换宿主，原生实例先保持可回滚。
6. **依赖可重建。** Node 24、Twenty 锁文件、PG16/Redis7 与 CPU 架构一致，镜像固定版本/digest。采用多阶段构建、非 root 运行；不把本机 `.local`、备份、原 `.env`、整份 `node_modules` 或 Linux 二进制无选择地 COPY 进镜像。

## 网络、权限与凭据

- PostgreSQL、Redis、Twenty API 默认只在专用容器网络内访问，不向宿主或局域网公开数据库端口。
- 仅管理台需要发布宿主端口时，使用明确的 `127.0.0.1:4310:<容器端口>`，不能省略宿主地址。Docker 官方说明省略地址时会发布到所有宿主地址；容器内部监听所有接口与宿主暴露到局域网是不同层次。[Docker 端口发布说明](https://docs.docker.com/engine/network/port-publishing/)
- MCP stdio 可由宿主客户端经本机 HTTP 访问，或专门通过容器 exec 启动；后者需正确的容器内部 URL、工具 stdout、配置挂载与角色边界。不得把 `docker exec` 本身宣称为已验证的多宿主适配。
- 只挂载必要路径：原件和数据库可写，代码/配置按需要只读。禁止挂载整个用户目录或 Docker socket 给业务服务。
- 使用私密配置文件或 secrets，不把凭据写进镜像、仓库、示例、日志或共享 Compose 文件。`.env` 只是配置文件，不是天然的秘密保护措施。
- 明确停止与删除的区别。普通停止不删数据；不要把 `docker compose down -v`、volume prune 或目录删除写进日常更新步骤。删除前需本人核实并授权。

容器网络和本机文件权限是部署边界，不能宣传为对同一系统账户内所有 Agent 的完整安全沙箱。换宿主若会将客户资料发往新的模型服务，仍需本人决定；Docker 不改变数据流向。

## 完成标准

交付 Dockerfile/Compose 前，应在 Linux 和 Windows WSL2/Docker Desktop 各跑一次全新安装与迁移；无对应设备时明确留为未验证。验收至少包括：

- 迁移失败不启动业务写入；重复启动不重置数据和密钥；所有必需服务健康。
- 重启容器/宿主后数据、历史、关联及原件完整。
- 双数据库与原件备份、异目录恢复、逐表/逐文件校验通过，可实际回滚。
- 500 MB 流式上传/下载与备份恢复通过，内存占用不随整个文件成倍增长。
- reader/writer/owner、来源校验、幂等、冲突/纠错和六态待办测试通过。
- 宿主端口仅 loopback 可见；内部允许连接符合白名单；没有新增第三方资料发送。
- 分享包不含客户数据或凭据；每位朋友初始化独立实例；依赖许可与 Docker Desktop 条款已核对。

Docker Desktop 使用 WSL2 等后端时仍有主机与版本要求；具体条件和商业许可按安装时官方说明核对。[Docker Desktop Windows 说明](https://docs.docker.com/desktop/setup/install/windows-install/)
