# 源码包的 Linux 运行时准备

当前本机已包含 `runtime/`，日常使用无需重新准备。源码分享包排除二进制和安装依赖，因此新机器须先补齐运行环境；这一步不创建或迁移客户资料。

`ubuntu24-amd64-packages.json` 保存本机已验证的 Ubuntu 24.04 x86_64 包名、版本和 SHA256：PostgreSQL 16 服务端/客户端、Redis 7.0.15、libpq、jemalloc、lzf。它是公开依赖元信息，不含凭据。WSL2 若采用相同 Ubuntu/CPU，可按该清单准备；其他发行版或 CPU 需要新的适配与验收。

由接管 Agent 按以下顺序准备，不能省略校验：

1. 核对目标确为 Ubuntu 24.04、x86_64，检查 Node 24、Python 3、`apt-get`、`dpkg-deb` 可用。
2. 在独立临时目录用 `apt-get download 包名=版本` 下载清单中的官方包；它只下载，不安装系统服务。若仓库已不提供所列版本，应停止并评估兼容替代，不能静默跳过或伪造哈希。
3. 将每个下载文件与清单 SHA256 比对，全部一致后才用 `dpkg-deb --extract` 解包到项目的新 `runtime/`，保留包内版权文件。不要覆盖已经运行的项目 runtime 或数据目录。
4. 核对 `runtime/usr/lib/postgresql/16/bin/`、`runtime/usr/bin/redis-server` 和 `runtime/usr/lib/x86_64-linux-gnu/` 布局，并用这个库目录验证 `postgres --version`、`pg_dump --version`、`redis-server --version`。
5. 再安装根 Node 依赖、构建 Twenty，按 INSTALL 执行初始化或私有备份恢复。执行 `npm ci` 不会替你安装数据库和 Redis。

这是可复现的运行时准备说明与清单，不是已验证的 Windows 自动安装器。未来 Docker 镜像应固定基础系统、PostgreSQL 主版本和依赖版本，在容器内重新构建；不能将 Ubuntu 原始数据库文件跨系统直接复制。见 [Windows/Docker](../../docs/WINDOWS_DOCKER.md)。
