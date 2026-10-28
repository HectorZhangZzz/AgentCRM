# 分享给朋友与迁移个人资料

分享程序与迁移自己的客户资料是两个操作。默认给朋友的是源码、Skill、说明和合成示例；朋友建立自己的数据库和凭据。

## 生成源码分享包

```bash
./ops/crm share
# 或明确指定一个尚不存在的 ZIP 文件
./ops/crm share --out /PATH/TO/agent-crm-source.zip
```

默认输出到 `share/`，不要求打开本机数据库或读取配置。ZIP 包括净化的项目代码、当前文档、接管模板、依赖锁、Twenty 上游源码与原许可。它不包含 `.local/`、数据库、附件、聊天、备份、访问令牌、`.env`、依赖目录、运行时二进制、编译产物或本机验收结果。输出存在时拒绝覆盖。

包内 `share-manifest.json` 逐文件记录相对路径、字节数和 SHA256；旁边 `.sha256` 用于整个 ZIP 传输校验。工具拒绝源码符号链接、保留文件冲突和已识别的私钥/令牌模式，但不能识别任意写进源码或文档的个人资料。示例必须继续使用合成数据。生成包是本地动作，不会自动发送或上传给朋友。

2026-10-28 上传审查另外排除了上游孤立会议调试文件 `twenty-companion/test.json` 和遗留配置备份文件。之前本机生成的分享包已移入私有隔离目录，不再作为分享成品；对外只用本轮重新生成并校验的包。GitHub 源码版本同步见 [GITHUB_BACKUP.md](GITHUB_BACKUP.md)，不直接推送含旧调试资料的原项目历史。

## 朋友拿到包以后

1. 核对 ZIP 的 SHA256，解压到独立目录，先读 `SHARE_README.md`、README 和安装说明。
2. 准备匹配目标系统的 Node 24、Python 3、PostgreSQL 16、Redis 7 运行时与依赖。源码包不是一键可执行安装器；Ubuntu 24.04 x86_64 运行时清单见 [运行时说明](../deploy/runtime/README.md)。
3. 安装根锁定依赖并按 [INSTALL.md](INSTALL.md) 构建 Twenty 所需组件；不能把本机 Linux `node_modules` 当成 Windows 依赖。
4. 在朋友自己的环境执行首次初始化，生成全新数据库、访问凭据和 Twenty 工作区；不要导入你的备份或复制你的客户端配置。
5. 用 reader 做连通性检查，再选 WorkBuddy 或 DOTS/Codex 的适配输出，完成合成闭环后录入朋友自己的客户。

Windows 推荐 WSL2 路线；Docker 仍是明确标注的待适配设计。见 [Windows/Docker](WINDOWS_DOCKER.md)。原许可证保留，第三方代码的适用条款以原文件为准。

## 迁移自己的数据

自己的另一台电脑需要 `backup` / `verify` / `restore`，而不是 `share`。私有备份包含数据库、原件及恢复所必需的 Twenty 应用密钥，必须私密保管；只给朋友源码包不会迁走你的客户。

同机从 WorkBuddy 换 DOTS/Codex，直接切换宿主连接，不需要导出数据库。换机器恢复到全新目标，检查原件、关系、历史和当前状态后再切换写入。不要为多个宿主分别维护多份正式库。见 [MIGRATION.md](MIGRATION.md)。
