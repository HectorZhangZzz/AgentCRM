# 安装与运行

这是供新接收者建立自己实例的说明。当前已验证运行路线是 **Ubuntu 24.04 x86_64、Node 24、Python 3、PostgreSQL 16、Redis 7**。源码包不是已安装系统，不含原使用者资料、配置、运行二进制或第三方源码。Windows优先WSL2路线，但本项目尚未完成Windows/WSL/Docker实机验收，见[平台说明](WINDOWS_DOCKER.md)。

## 1. 选择目录和依赖

解压或克隆到独立、可写目录，不放进运行中的旧实例。先读[业务要求](REQUIREMENTS.md)、[实际能力](CAPABILITIES.md)、根目录AGENTS及[第三方说明](THIRD_PARTY.md)。不要为了测试而复制别人的`.local`、备份、数据库或凭据。

根服务要求Node >=24.5且<25，Python需支持现有Linux运维脚本。若在不同CPU、发行版或原生Windows运行，需要先适配并验证；不要硬搬另一系统的`node_modules`、数据库目录或二进制。

### PostgreSQL和Redis运行时

现有`ops/manage.py`使用项目内固定布局，不会只因为系统PATH里有postgres就自动找到：

```text
runtime/usr/lib/postgresql/16/bin/
runtime/usr/bin/redis-server
runtime/usr/lib/x86_64-linux-gnu/
runtime/usr/share/postgresql/16/
```

按[运行时准备](../deploy/runtime/README.md)及公开包清单，在新`runtime/`下载、核对SHA256并解包适配Ubuntu24.04 x86_64的官方包，保留版权文件。若锁定版本已无法取得，先评估兼容替代并更新清单，不能跳过校验或把别的版本伪称已验证。运维脚本不会自动执行系统管理员安装或注册服务。

### Twenty来源与构建

完整运行仍需Twenty API/worker和独立数据库，不能因为它只承担有限投影就直接删掉依赖。分享包不重分发`vendor/twenty`；使用随包准备器独立取得固定官方基线，具体版本、归档哈希和本地差异说明见`deploy/twenty/source.json`。准备器拒绝覆盖已有目录，不读取原`.env`，不搬原AI provider/Docker改造。取得上游不代表获得所有Enterprise组件的使用或再分发许可。

```bash
python3 ops/prepare-twenty.py
npm ci --ignore-scripts
./ops/build-twenty.sh
```

`build-twenty.sh`使用上游固定的Yarn4.13.0，并按shared、client-sdk、emails、UI、SDK、server顺序构建。安装依赖和构建需要网络；不需要为CRM配置聊天模型。根`package-lock.json`和上游`yarn.lock`分别锁定各自依赖。构建失败应停止并检查版本/布局，不跳过报错去初始化。

当前已有Linux运行与构建的历史记录；本轮只核对固定上游来源与取得边界，没有把朋友的新机器从空环境完整重建验收写成已通过。上游基线与原本机少量AI/Docker修改分开处理，精确差异以来源清单为准。

## 2. 首次初始化自己的空实例

只有上面依赖和编译产物准备好后，在项目根目录执行：

```bash
./ops/crm init
./ops/crm start
./ops/crm status
./ops/crm open
```

初始化生成新随机凭据、独立PG目录、两个数据库和Redis目录；不读取旧项目`.env`。已存在的配置不会被用来重置令牌，非空PG目录不会重新初始化；不要把init当恢复旧数据的方法。需要复原自己的历史时按[MIGRATION](MIGRATION.md)向全新目标restore。

| 服务 | 默认地址 | 私有数据位置 |
|---|---|---|
| CRM管理台/HTTP | 127.0.0.1:4310 | `portable_crm`业务库 |
| Twenty API | 127.0.0.1:4311 | `twenty_crm`投影库 |
| PostgreSQL16 | 127.0.0.1:55433 | `.local/postgres` |
| Redis7 | 127.0.0.1:56380 | `.local/redis` |
| 领域原件 | 仅认证下载 | `.local/data/objects/<sha256>` |
| Twenty存储 | 仅实例内部 | `.local/twenty-storage` |

多个独立实例可在首次init时指定`--pg-port`、`--redis-port`、`--port`、`--twenty-port`；不要与已有实例端口冲突。这些参数不用于改变已有实例。

`open`使用短时一次性登录链接；直接打开4310需要登录。访问令牌和数据库密码保存在自己的`.local`配置中，不粘贴进聊天、GitHub、截图或分享包。所有服务默认loopback，不能为了连宿主而开放到公网。

## 3. 创建自己的有限Twenty投影

新实例第一次初始化并启动Twenty后执行：

```bash
python3 ops/bootstrap_twenty.py
./ops/crm stop
./ops/crm start
```

它创建新的本机账户/工作区和受限投影角色，账户资料只保存在自己的`.local/twenty-access.json`，不发送邮件。恢复历史工作区时不要重新bootstrap。投影key到期后由实例所有者执行`./ops/crm renew-projection-key`并按维护说明重启；恢复流程会处理还原角色的重新签名。

Twenty是可重建投影，事实、原件、待办与历史以领域服务为准。投影失败应说明范围，不直接改Twenty通用CRUD或SQL绕过证据和版本。

## 4. 接管、可选产品库与常驻

按[HOSTS](HOSTS.md)生成目标机器的reader配置，工具发现并调用`crm_health`后再为普通录入配置writer。`.local/reader-client.json`和writer文件不含数据库密码，但仍含访问令牌，不能分享；owner留给实例本人处理已决定的冲突与纠错。生成片段不等于已修改宿主配置或接通客户端。

产品领域`productLibraryEnabled`与页面`productUiEnabled`通用默认关闭。按[PRODUCT_LIBRARY](PRODUCT_LIBRARY.md)分别决定；对已有数据开启002之前先完整备份并在全新目标恢复验证。关闭功能不删数据或撤销迁移。

新安装默认手动启动。验证运行与恢复后，可在自己的Linux普通用户会话中执行：

```bash
python3 ops/install-user-service.py
```

默认用户服务为`agent-crm.service`，其他端口使用独立服务名；迁移目录后须重新登记，不能复制旧服务绝对路径。服务登录后常驻并监督进程，不执行AI，不保证退出登录、休眠或关机后在线。桌面快捷方式应按目标系统创建并指向该目录的`ops/open.sh`；当前不提供Windows自动创建快捷方式的安装器。

## 5. 验证、备份与维护

按[TEST_RESULTS](TEST_RESULTS.md)运行隔离合成测试和复验角色、来源、去重、冲突、六态任务。真实500MB原件可保存不意味着有OCR、转写、视频理解或全文检索。联系人初步核查与主动调研尚未实现，不能把已加载Skill当成自动执行器。

完整备份/校验/全新目标恢复见[MIGRATION](MIGRATION.md)。分享只执行`./ops/crm share`，不把自己的backup/export发给朋友。日志位于`.local/logs`；向维护者提供错误前先去敏，不上传原配置或客户资料。

本机角色与文件权限不是抵御同一系统账户内恶意Agent的系统沙箱。真实资料交给新第三方、付费、公开部署、扩大权限、外发或不可恢复删除均需另行授权；普通启动停止不删除资料。
