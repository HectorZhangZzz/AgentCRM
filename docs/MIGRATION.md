# 备份、迁移与回滚

客户档案与历史以领域数据库和原件为依据；Twenty 是可重建投影。模型记忆、聊天上下文、Redis 缓存都不是数据备份。换 Agent 且仍在同一电脑时，保持服务和数据库不变，仅连接受限 MCP/CLI；换电脑才执行下述数据迁移。

## 创建与验证备份

```bash
./ops/crm backup
./ops/crm backup --out /本人选择的私有备份目录
./ops/crm verify backups/agent-crm-时间戳.tar.gz
```

备份短暂停止本项目能力服务及 Twenty API/worker，保持 PostgreSQL 运行，完成一致性导出后恢复原应用运行状态。不要在备份窗口另起直接写数据库的客户端。备份包含：

- `databases/portable_crm.dump`：领域记录、稳定 ID、关系、证据、建议、事实版本和历史。
- `databases/twenty_crm.dump`：Twenty 结构及普通 CRM 投影。
- `data/`：原件和能力服务的数据目录。
- `twenty-storage/`：Twenty 原件存储。
- `manifest.json`：格式/契约/应用/数据库版本、逐文件 SHA256 和字节数、逐表内容指纹、投影工作区及 key 的非秘密 ID。
- `private-secrets.json`：Twenty 的 `APP_SECRET`，为保留上游可能的签名/加密数据所必需；不含 bearer token。

500 MB 原件采用与小文件相同的相对引用、SHA256 和备份成员格式，无需新数据库迁移。备份和开放导出均携带已保存的大文件；容量会随原件增长，不能只复制数据库而遗漏 `data/` 或 `originals/`。迁移时核对清单字节数与哈希，不依靠文件名判断完整性。

备份文件权限为 `0600`，目录 `0700`。旁边的 `.sha256` 是整体传输校验；`verify` 会检查内部成员集合、大小和每个文件哈希，并拒绝路径穿越/软链接。备份不包含 `.local/config.json`、原 `.env`、数据库密码或 bearer token，但包含必须私密保存的 Twenty 应用密钥。数据库内容本身也含客户资料和 Twenty 内部身份信息，需私密保管；哈希只用于检测意外损坏，无法代替加密或签名。需要放到网盘前由本人选择加密方式。

## 恢复到全新目标

原项目保持不动。目标必须位于当前项目目录之外，且是不存在或完全空的目录；不能选择当前项目的子目录或祖先目录，端口必须空闲：

```bash
./ops/crm restore backups/agent-crm-时间戳.tar.gz \
  --target /本人选择的新目录/agent-crm-restored \
  --pg-port 55434 --redis-port 56381 --port 4320 --twenty-port 4321
```

恢复会复制当前项目代码及本机运行时到目标目录、生成新的随机数据库密码和 owner/writer/reader 令牌、创建全新数据库，再写入逻辑备份及原件。不会覆盖源数据或已有目标目录。恢复过程在启动应用前计算所有用户表的内容指纹，必须与备份一致；只校验压缩包而不恢复数据库不算成功。

Twenty 保留备份内的 `APP_SECRET`，恢复过程为数据库中原有的受限 API key 重新签发 JWT；不携带旧 bearer token，不创建更宽权限的角色。旧 Twenty JWT 不因此被保证撤销；需要撤销时应通过专门的密钥轮换流程处理，不能随意更换可能用于数据加密的应用密钥。若 key 已过期，先在目标目录运行 `renew-projection-key`，再重启能力服务。原领域 ID、Twenty 工作区及投影 ID 保持不变。

恢复结果位于目标 `.local/restore-report.json`。在新目录执行：

```bash
./ops/crm start
./ops/crm status
./ops/crm open
node src/cli.mjs status
```

先检查客户、项目、未完成待办和几条原始证据；再按交付测试的场景做只读核查。确认后才把 豆子 的连接配置切换到新目录的 reader/writer 客户端配置。旧令牌不会在新实例生效。

恢复命令当前适合同系统、同架构的本机演练或整目录迁移。换电脑时同时复制项目代码（或下述源码导出）和备份，安装兼容环境，重建锁定依赖，再执行恢复；不要把 `.local/postgres` 跨系统直接复制。不同系统运行时布局见 `INSTALL.md`。不要运行两套实例并分别录入真实客户，否则需要专门处理数据分叉。

## 开放格式导出

```bash
./ops/crm export --out /本人选择的全新导出目录
```

导出时同样短暂停止应用写入，完成后恢复原运行状态。目标必须在项目外或项目 `exports/` 目录内。导出包含 `records/*.jsonl`、原件 `originals/`、净化的能力包及 Twenty 源码、SHA256 清单。领域表逐行保留数据库字段，包括稳定 ID、来源、历史与关系，便于未来迁到其他数据库或由新 Agent 检查。导出不包含本机配置、访问令牌、依赖目录或运行时二进制。

JSONL 是开放数据交换格式；`restore` 使用经过验证的 PostgreSQL 备份格式，不把 JSONL 导出冒充已经验证的通用数据库导入器。导出同样包含真实客户资料，交给新第三方前仍需本人确认。

## 升级与回滚

1. 升级前执行完整备份及校验，同时保存当时应用代码、`package-lock.json`、`vendor/twenty/yarn.lock`、契约和迁移文件。已交付代码无需远程 Git 也能保存整目录副本。
2. 在全新目录和新端口恢复，使用匹配版本代码启动后再运行迁移。领域迁移对 checksum 和未知高版本进行检查，发现不匹配应停止，不能手动伪造迁移已完成。
3. 测试完成前保留旧实例；真正切换时停止旧实例写入，必要时重新备份后再恢复，避免漏掉测试期间的新资料。
4. 出现问题时停止新实例，将宿主连接切回仍保留的旧实例；若新实例已录入数据，先备份并评估增量，不能直接丢弃。

当前电脑使用用户级常驻服务。切换前先 `./ops/crm stop` 停止旧目录的服务，并 `systemctl --user disable agent-crm.service` 取消旧实例登录自启；保留旧数据。新目录确认后运行 `python3 ops/install-user-service.py`，不同端口会注册不同服务名（例如 `agent-crm-4320.service`）。不要把旧 `.local/user-service.json` 复制给新目录，也不要让两个实例同时接收真实资料。

运维脚本没有“覆盖现有库恢复”或删除业务数据的快捷命令。演练目录需清理时，先停止该目录内服务，核实目录与备份，再由本人决定删除。

## 多宿主、Windows与分享

WorkBuddy/DOTS/Codex优先接管与配置片段见 [HOSTS.md](HOSTS.md)；Windows/WSL2和Docker的限制、设计及验收步骤见 [WINDOWS_DOCKER.md](WINDOWS_DOCKER.md)。给朋友程序使用不含资料的 `./ops/crm share`，具体见 [SHARING.md](SHARING.md)，不要把个人数据导出当分享包。
