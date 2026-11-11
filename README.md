# Agent CRM

面向个人销售的本机客户与产品资料库。宿主 Agent 负责理解材料、核对归属和组织简报，Agent CRM 负责持久保存、证据关联、版本校验、检索与待办；不需要为 CRM 单独配置聊天模型。

## 先读什么

| 目的 | 入口 |
|---|---|
| 理解完整业务规则，不依赖原聊天 | [业务要求](docs/REQUIREMENTS.md) |
| 区分已实现、默认关闭与待实现 | [能力清单](docs/CAPABILITIES.md) |
| 新电脑安装自己的空实例 | [安装说明](docs/INSTALL.md)、[第三方依赖](docs/THIRD_PARTY.md) |
| 交给 WorkBuddy、DOTS/Codex 等宿主 | [接管说明](docs/HOSTS.md)、[Skill](skills/agent-crm/SKILL.md)、[维护入口](AGENTS.md) |
| 日常录入、查询、纠错 | [使用说明](docs/USAGE.md)、[工具契约](docs/CONTRACT.md) |
| 理解架构和后续阶段 | [架构](docs/ARCHITECTURE.md)、[项目方案](docs/PROJECT_PLAN.md) |
| 产品/型号/版本及要求、评估、能力 | [产品资料库](docs/PRODUCT_LIBRARY.md) |
| 联系人初步核查与主动调研的设计 | [研究整合方案](docs/SEEKINGPERSON_INTEGRATION.md) |
| 分享代码，或迁移自己的历史 | [分享](docs/SHARING.md)、[完整备份与恢复](docs/MIGRATION.md) |
| 查看验证范围、维护 GitHub 版本 | [测试记录](docs/TEST_RESULTS.md)、[源码上传](docs/GITHUB_BACKUP.md) |

## 架构与当前能力

```text
WorkBuddy / DOTS / 其他具备本机工具能力的 Agent
    → 同一份 Agent CRM Skill
    → MCP stdio / CLI / 本机 HTTP
    → 领域服务：证据、权限、幂等、版本与冲突
        ├── PostgreSQL：实体、事实、关系、待办和历史
        ├── 原始文件库：.local/data/objects/<sha256>
        └── Twenty：可重建的有限兼容投影
```

当前代码版本 **0.1.4**。已实现材料原件去重、客户/联系人/项目分离、带证据更新、人工纠错、历史与并发保护、六态待办、本机管理台和逻辑备份恢复。产品资料库及独立产品页面已实现，通用默认关闭，需按文档分别启用。

常用文档正文提取、微信采集、中文全文/向量检索、联系人自动核查队列和后台研究执行器尚未实现。研究需求已写入业务基线与 Skill：新增联系人按姓名和明确公司核查，也支持主动指定调研；不明确的外部结果不得补全档案。不能因为项目有方案文件就宣称能力已经上线。

## 安装与启动

首次安装先按 [INSTALL](docs/INSTALL.md) 准备匹配系统的运行时、独立取得并验证 Twenty、安装锁定依赖和构建。源码包不包含 `vendor/twenty`、`runtime`、`node_modules` 或编译产物，不能直接运行初始化来替代这些步骤。

准备完成后，在**自己的新项目目录**执行：

```bash
./ops/crm init
./ops/crm start
./ops/crm status
./ops/crm open
```

默认管理台为 <http://127.0.0.1:4310>，`open` 使用短时一次性登录链接。新安装不会自动建立系统服务；验证成功后再按安装说明登记当前用户服务。各实例使用独立目录、端口和凭据。

宿主接入配置在目标机器生成，不复制原使用者的配置：

```bash
./ops/crm connection --host workbuddy --reader
./ops/crm connection --host codex --reader
```

先发现工具并调用 `crm_health`，再用 writer 录入；owner 留给本人确认后的冲突和纠错。生成配置或协议测试通过不等于目标宿主实接完成。Windows 优先 WSL2 路线，Windows/WSL2/Docker 尚未完成本项目实机验收，见 [平台说明](docs/WINDOWS_DOCKER.md)。

## 业务原则

一客一档、一项目一卡；客户、联系人、最终业主、供应商和项目现场分别表达。重要结论带原文依据，新旧冲突保留来源，未知就留空。完成/取消待办退出默认列表但保留历史，待办记录与定时提醒分开。

单文件上限 **500 MB（500,000,000 字节）**，大文件使用管理台或 CLI 流式传输。文件已保存不代表已读、已解析或已核验。只有收到保存/提交成功结果才算入库；当前聊天、全部微信历史和生成报告不会自动归档。

## 分享与迁移

```bash
./ops/crm share --out /PATH/TO/agent-crm-source.zip
```

分享包保留程序、完整业务要求、Skill、部署说明、锁文件和合成测试，不含业务数据库、原始附件、聊天、凭据、私有备份、历史运行统计或第三方源码树。朋友创建自己的数据和账号。包中逐文件清单及旁边 SHA256 用于传输核验。

迁移自己的历史另用 `./ops/crm backup` / `verify` / `restore`，携带完整私有备份，在全新目标恢复核对；不能只克隆 GitHub 或复制运行中的 PostgreSQL 目录。自己的数据库不会因生成分享包而删除。

真实资料发往新的第三方、对外发送、付费、公开部署、扩大访问权限或不可恢复删除，须另行授权。宿主模型的数据流向由宿主配置决定。本项目不自动发消息或开启提醒。分享与第三方许可范围见 [NOTICE](NOTICE.md)。
