# GitHub 源码版本备份

GitHub 保存程序版本：代码、Skill、部署与使用说明、合成示例和锁定依赖清单。客户数据库、原始附件、访问凭据和私有备份继续保存在本机；它们需要另外执行完整私有备份，不能靠克隆 GitHub 恢复。

## 准备净化源码快照

在实际项目根目录运行：

```bash
python3 ops/github_backup.py prepare
```

工具复用源码分享的允许目录和排除规则，在 `.local/github-source/` 创建独立的 Git 仓库。它使用新的源码历史，保留原项目及其现有 Git 历史，不推送原项目的旧提交。未知目录、未提交改动或异常的管理标记会阻止覆盖。

除 `.local/`、客户资料、备份、依赖和运行时二进制外，还排除了来源不明的上游会议调试文件 `vendor/twenty/packages/twenty-companion/test.json`、遗留 `.bak-*` / `.before-*` 配置副本和本机验收结果。原上游文件继续保留在本机，运行中的服务不受影响。原始桌面 `twenty.zip` 含旧配置和凭据，不能原样上传。

`prepare` 不连接 GitHub，不读取 GitHub 令牌，也不上传。新的源码快照是便于重建的源码版本，不是可直接运行的数据库镜像。

## 首次上传到私有仓库

若当前 Agent 的 GitHub 连接器能完成建库和写入，应优先沿用已有连接。账号已有全库授权，并不保证具体会话同时提供建库工具；连接器的授权也不等于系统 Git 已经登录。遇到缺失能力应明确报告，不能读取其他程序的凭据绕过。

本机命令行后备使用官方 GitHub CLI。可使用 PATH 中的 `gh`；当前电脑准备的本地副本在 `.local/tools/github-cli/usr/bin/gh`。如它尚未登录，由本人在 GitHub 完成一次 CLI 授权，不将密码、访问令牌粘贴到聊天或项目源码。登录完成后执行：

```bash
python3 ops/github_backup.py publish --repository YOUR_ACCOUNT/agent-crm
```

将 `YOUR_ACCOUNT` 替换为本人账号。工具核对登录账号，只在明确不存在时创建私有仓库，拒绝推送到已有公开仓库；通过常规 Git 推送并核对远端提交，不执行强制覆盖。GitHub CLI 的认证说明见[官方文档](https://cli.github.com/manual/gh_auth_login)。

仓库是否已建立、具体地址和最新远端提交，以实际上传结果为准；仅生成源码快照或看到已授权账号，不代表远端备份完成。本轮安装了 CLI，并未因此取得新的登录授权。

## 后续更新

先在实际项目修改、检查、提交，再运行 `prepare` 和 `publish`。快照仓库只负责同步经过筛选的源码，不在其中录入客户资料或做日常开发。不要在原项目根目录添加远端后直接推送旧 `main`，以免将历史里的上游调试资料一起发出。

远端出现其他人提交时，普通推送会拒绝覆盖；应先审查并合并变更，再同步新版本。没有定时任务自动推送，也不自动开放仓库给朋友。仓库访问范围扩大或改为公开须由本人另外决定。

第三方源码保留原许可。`vendor/twenty/LICENSE` 同时描述 AGPLv3 和带 `@license Enterprise` 标记文件的商业许可例外，不能把整个项目重新声明为 MIT 或统一开源许可。

## 恢复范围

从 GitHub 克隆源码后，按 [INSTALL.md](INSTALL.md) 准备目标系统运行时、依赖和凭据。要恢复自己的客户资料，还需携带完整私有备份，按 [MIGRATION.md](MIGRATION.md) 恢复并核对原件及关联关系。给朋友程序则按 [SHARING.md](SHARING.md) 安装独立实例。
