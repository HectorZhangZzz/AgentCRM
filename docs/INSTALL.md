# 本机安装与运行

当前版本为个人本机部署。主入口是能力服务自带的管理台；Twenty 后端保存可重建的客户/联系人/商机投影。服务不包含模型密钥，文本识别、归属判断和简报写作由接入的 Agent 完成。

## 当前电脑

项目目录为 `agent-crm`，产品名为 Agent CRM。内部数据库名称保留 `portable_crm` 兼容，不需为改名迁移。在项目目录运行：

```bash
./ops/crm status
./ops/crm start
./ops/crm open
```

`open` 请求一次性本机登录链接并打开管理台。备用命令 `./ops/crm login-url` 输出一次性链接，链接仍应只在本人电脑使用。管理台地址为 `http://127.0.0.1:4310`；直接打开地址时需要登录。永久令牌仅在 `.local/config.json` 和单独的客户端配置中保存，权限为 `0600`，不要粘贴到聊天、截图、代码仓库。

停止全部本项目服务：

```bash
./ops/crm stop
```

当前电脑已安装并启用用户级 `agent-crm.service`，登录后自动启动；有健康检查，应用进程异常退出后自动恢复。`./ops/crm start` / `stop` 会控制该服务，不依赖聊天或终端进程。没有配置退出登录后的无人值守运行。

```bash
systemctl --user status agent-crm.service
journalctl --user -u agent-crm.service -n 30
```

新机器或恢复目录默认先手动启动；确认运行正常后可执行 `python3 ops/install-user-service.py` 安装当前用户的常驻服务。默认端口 4310 的服务名为 `agent-crm.service`，其他端口使用如 `agent-crm-4320.service`，可并行演练。该脚本不覆盖属于其他目录的同名服务。迁移到新目录后需重新安装对应用户服务，不能复制旧服务中的绝对路径。

## 初次初始化

当前电脑已经初始化，重复执行不会重置数据或更换令牌：

```bash
./ops/crm init
./ops/crm start
```

初始化创建独立 PostgreSQL 实例、两个数据库和 Redis 数据目录。首次设置生成随机凭据，不读取上一个项目或审查环境的 `.env`。已存在的非空 PostgreSQL 目录不会被重新初始化；迁移会核实 Twenty 的核心表确实存在，不能只凭命令退出码认定成功。

| 服务 | 本机地址 | 数据 |
|---|---|---|
| 能力服务/管理台 | `127.0.0.1:4310` | `portable_crm` 数据库的领域 schema |
| Twenty API | `127.0.0.1:4311` | 独立 `twenty_crm` 数据库 |
| PostgreSQL 16 | `127.0.0.1:55433` | `.local/postgres` |
| Redis 7 | `127.0.0.1:56380` | `.local/redis`，可重建队列/缓存 |

原件位于 `.local/data/objects/<sha256>`，目录使用内容哈希，不依赖客户名称或此电脑的旧绝对路径。Twenty 附件目录为 `.local/twenty-storage`。运行日志位于 `.local/logs`，进程号位于 `.local/pids`。

单个原件最多 500 MB（500,000,000 字节），管理台与 CLI 文件导入使用流式传输。原件位于磁盘，数据库保存元信息与关联；容量规划应包含接收临时文件、已有原件和完整备份的占用。上传上限不代表 OCR、视频或文档解析已接入，也不改变宿主的上下文限制。

新机器或第二套实例可显式选择端口，参数只在首次初始化生效：

```bash
./ops/crm init --pg-port 55434 --redis-port 56381 --port 4320 --twenty-port 4321
```

## 运行环境与重建

本机已独立保存完整净化后的 Twenty 源码、运行产物和依赖树，所有依赖软链接都指向当前 `vendor/twenty` 内部，不依赖之前审查目录。`.env`、其备份、原密钥文件、`.DS_Store` 和原 MCP 配置均未带入。

- 已测试系统：Ubuntu 24.04 x86_64，Node.js 24.19.0，Python 3.12。
- Twenty 声明 Node `^24.5`，锁定 Yarn 4.13.0；不能直接把本机二进制依赖复制到不同 CPU/系统后继续使用。
- `runtime/` 是解包的 Ubuntu PostgreSQL 16.15、Redis 7.0.15 和运行库，不需要 root、没有注册系统服务。发行版包版本与 SHA256 在 `runtime/package-manifest.json`，版权文件保留在 `runtime/usr/share/doc/`。
- 小型能力服务依赖由根 `package-lock.json` 锁定；在新机器运行 `npm ci --ignore-scripts` 重建。
- Twenty 依赖由 `vendor/twenty/yarn.lock` 锁定。安装/编译过程会下载依赖，需网络，但不需要模型账户。

```bash
npm ci --ignore-scripts
./ops/build-twenty.sh
```

`build-twenty.sh` 按已验证的 shared → client-sdk → emails → UI → SDK → server 顺序直接构建，避免 Nx 后台服务；失败立即终止。Twenty 原生前端是否编译可用以交付测试报告为准，4310 管理台是本能力包的使用入口。

换系统时先安装适配目标系统的 Node 24、Python 3、PostgreSQL 16 客户端/服务端、Redis 7，再使用匹配的二进制布局替换 `runtime/`；不能混用 Ubuntu x86_64 的二进制。当前运维脚本针对 Linux 本机布局；macOS/Windows 建议先放入 Linux 虚拟机或编写等价运行时适配，未声称跨系统直接执行已经验证。数据库使用逻辑备份迁移，不复制 PostgreSQL 的原始数据目录。

## Twenty 投影访问

首次新装完成后启动 Twenty，执行一次：

```bash
python3 ops/bootstrap_twenty.py
./ops/crm stop
./ops/crm start
```

脚本创建全新的本机账户、工作区和受限投影 API 角色。账户地址为随机 `example.invalid`，密码仅保存在 `.local/twenty-access.json`，不发送邮件。投影 key 只允许普通对象读写，无删除、设置及任意工具权限，默认一年有效。它不会把附件或客户材料发给其他服务。

到期时由本人在本机执行以下命令，为相同受限角色续期并重启：

```bash
./ops/crm renew-projection-key
./ops/crm stop
./ops/crm start
```

不要重新运行 bootstrap 来代替恢复旧工作区。恢复命令会自动为还原库中的原受限 key 重新签名；领域服务生成全新的本机访问令牌，Twenty 的 `APP_SECRET` 随私有备份保留。

## 接管配置

`.local/reader-client.json` 和 `.local/writer-client.json` 仅含本机地址、选定角色的令牌和角色名，不含数据库密码或 Twenty 凭据。只读分析优先交给 reader；需要录入的 Agent 使用 writer；owner 配置留给本人处理归属纠正和冲突覆盖。具体 MCP/CLI 接入见 `HANDOFF.md`。未确定 豆子 的具体产品和工具能力前，不假定它支持本机文件、stdio MCP 或后台进程。

服务全部绑定 loopback。Twenty 还使用 Node 网络预加载限制，普通 Node 网络连接只允许 loopback；这是进程级防误外发边界，不是操作系统安全沙箱。不要把任何端口映射到公网；公开部署、真实资料上传新第三方和权限扩大均需另行评估并获得确认。备份和开放格式导出使用维护锁；常驻监督进程在维护窗口不会重新开启应用写入。

## 多宿主、Windows与分享

WorkBuddy/DOTS/Codex优先接管与配置片段见 [HOSTS.md](HOSTS.md)；Windows/WSL2和Docker的限制、设计及验收步骤见 [WINDOWS_DOCKER.md](WINDOWS_DOCKER.md)。给朋友程序使用不含资料的 `./ops/crm share`，具体见 [SHARING.md](SHARING.md)，不要把个人数据导出当分享包。
