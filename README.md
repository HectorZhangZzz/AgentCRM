# Agent CRM

面向个人销售的本机客户资料库。将沟通文字、截图、文档、语音和视频原件关联到客户、联系人与项目，保留来源、状态变化和承诺。当前 Agent 负责阅读与判断，本项目负责持久保存、校验和查询；换 Agent 不需要重新建立客户历史。

**本机日常入口：**桌面“Agent CRM”快捷方式，或在项目目录执行：

```bash
./ops/crm start
./ops/crm status
./ops/crm open
```

管理台位于 <http://127.0.0.1:4310>。`open` 使用一次性本机登录链接。服务通过当前用户的 `agent-crm.service` 登录自启，不依赖这次聊天保持打开。

## WorkBuddy 与 DOTS/Codex 接管

优先接入腾讯 WorkBuddy 与用户称为 DOTS 的 GPT/Codex 侧宿主。先读 [宿主接管](docs/HOSTS.md)，加载同一份 [Agent CRM Skill](skills/agent-crm/SKILL.md)。在项目目录生成配置片段：

```bash
./ops/crm connection --host workbuddy --reader
./ops/crm connection --host codex --reader
```

先用 reader 核对连接和资料，再用 writer 做普通录入。冲突确认与归属纠正保留给本人在管理台操作。需要录入时，重新生成相同宿主但不带 `--reader` 的配置。WorkBuddy 输出 JSON，Codex 输出 TOML，标准 JSON 用 `--host dots` 或 `generic`。本项目没有修改宿主的实际配置，目标客户端仍须实接验收。兼容入口见 [integrations](integrations/README.md)。

日常可以直接说：

> 把这份客户材料归档并更新项目和待办，保留原文依据。普通更新直接完成，身份不明或新旧冲突再让我确认。

> 回顾这个客户的项目、关键人、卡点和未完成承诺，建议优先推进三件事，并说明证据与检索范围。

## 保存在哪里

- PostgreSQL 保存客户、项目、事实及版本、证据关联、待办和纠错历史；为兼容既有数据，内部数据库/schema 仍使用 `portable_crm`。
- 原始文件保存在 `.local/data/objects/`，按 SHA256 去重。单文件最多 **500 MB（500,000,000 字节）**，管理台和 CLI 流式上传。
- Skill、业务工具和代码随项目保存。模型与聊天上下文不是数据库。
- Twenty 保留为有限的兼容投影；客户事实、原件和历史以本项目领域服务为准。

只有通过材料入口保存、并收到成功结果的内容才入库。当前聊天、微信全部历史、Agent 写出的报告不会自动归档；需要将相应内容或文件明确保存。文件保存成功也不代表已解析其全文。

## 当前能力与后续范围

当前具备原件去重、客户/联系人/项目区分、带证据更新、冲突与版本保护、六态待办、查询简报数据及完整备份恢复。常用文档正文提取、微信采集、语音转写、视频分析、中文全文检索和向量检索尚未接入。本服务不单独配置模型，不会自动推理或发送消息。

下一步先用两三个真实客户完成最小闭环，再增加方案版本、文档段落检索和可选本地 embedding。完整取舍见 [项目方案](docs/PROJECT_PLAN.md)。

## 备份和迁移

```bash
./ops/crm backup
./ops/crm verify /PATH/TO/backup.tar.gz
```

同机换 Agent 只需重新连接现有服务。换目录或换电脑，应携带代码与最新完整备份，在全新目标恢复并核对，旧数据保留到验证成功；只复制源码不携带业务数据。备份和 `.local/` 含私密资料，不应公开。

| 需要做什么 | 阅读入口 |
|---|---|
| 了解目标、分期与未实现部分 | [项目方案](docs/PROJECT_PLAN.md) |
| 开始录入、查询和纠错 | [使用说明](docs/USAGE.md) |
| WorkBuddy / DOTS / Codex 接管 | [宿主接管](docs/HOSTS.md)、[豆子指令](docs/DOUZI_HANDOFF.md) |
| 了解架构和文件职责 | [架构](docs/ARCHITECTURE.md) |
| 安装与运行 | [安装说明](docs/INSTALL.md)、[Windows/Docker](docs/WINDOWS_DOCKER.md) |
| 备份、恢复、回退 | [迁移说明](docs/MIGRATION.md) |
| 分享给朋友，仅打包程序 | [分享说明](docs/SHARING.md) |
| GitHub 保存源码版本与后续更新 | [GitHub 备份说明](docs/GITHUB_BACKUP.md) |
| 维护工具与检查验收 | [契约](docs/CONTRACT.md)、[测试记录](docs/TEST_RESULTS.md) |

真实资料上传新的第三方、对外发送、付费、公开部署、扩大权限或不可恢复删除，均需要另行授权。宿主模型处理资料时的数据流向由宿主决定，“保存在本机”不等于模型分析始终在本机。

## 分享程序与跨平台

`./ops/crm share` 生成不含个人数据库、附件、令牌、备份与安装依赖的源码 ZIP；自己的历史资料迁移仍用 `backup` / `restore`。源码包含安装指引，不是开箱 Windows 程序。当前本机继续使用原生 PostgreSQL；Windows 优先 WSL2，Docker 迁移设计尚未实施，见对应文档。
