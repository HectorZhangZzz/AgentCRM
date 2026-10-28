# Agent CRM 验收记录

2026-10-28 · Ubuntu 24.04 x86_64、Node 24.19、PostgreSQL 16.15、Redis 7.0.15。业务测试使用独立合成资料，不把示例写入正式客户库。下列记录为已执行的测试；重命名后的当前结果应以 `test/results/latest.tap` 和本轮运维记录为准。

| 场景 | 已验证范围及边界 |
|---|---|
| 去重/重试 | 相同字节复用原件；同key幂等；不同key精确重复实体/任务被拒。不是相似图片语义去重 |
| 客户/项目 | 同名同音不自动合并，多项目与同类待办可分别保存 |
| 证据与冲突 | 文本引文/偏移校验，非法提交原子回滚；新旧差异留源据，旧owner快照不能覆盖更新结果 |
| 人工纠正 | 单来源事实/任务移转后查询采用正确归属；复杂多源/项目关联可能留下pending |
| 待办 | 六态、默认隐藏完成/取消、改期当前值与历史兼顾，无自动提醒 |
| HTTP/MCP | 实际官方SDK stdio调用；认证、Host/Origin、reader拒写；原字节收发 |
| 新Agent接管 | 新reader从工具恢复材料、当前事实、任务与9条证据，不依赖旧聊天 |
| 常驻 | 登录后用户服务、app异常退出恢复；维护锁阻止备份窗口重新开启写入 |
| 完整恢复 | 独立新目录恢复，16张领域/投影表及89张Twenty表内容指纹一致，原件哈希与稳定ID一致 |
| 500 MB | 实际500,000,000字节上传/下载、CLI重复复用、重开、超限1字节拒绝、中断清理、篡改拒绝；完整备份恢复后文件及下载哈希一致 |

500 MB扩展时全套 `npm test` 共31项通过、0失败/跳过；初版运维边界4项通过。查看可复查证据：

- [自动化 TAP](../test/results/latest.tap)
- [Skill 前向归档](../test/results/skill-forward.json)、[新 reader 接管](../test/results/handoff-reader.json)
- [完整恢复与投影](../test/results/ops.json)、[常驻恢复](../test/results/supervisor.json)
- [500 MB验证](../test/results/large-file.json)、[大原件备份恢复](../test/results/large-file-backup.json)

历史结果文件中的旧产品/目录名保留为执行时记录，不改写为新的测试。当前应用为0.1.2、契约1，产品名Agent CRM；内部数据库/schema/旧备份格式兼容保留。

## 复现

```bash
npm test
python3 ops/test_manage.py
./ops/crm status
```

测试创建独立合成库，不重置正式资料。成功后默认清理本轮数据库和 `.local/test-runs/` 下大原件，保留小型 `test/results/`；失败时保留现场，调试可设置 `CRM_TEST_KEEP_DATA=1`。恢复演练只进入全新目标，不覆盖当前库。

## 尚未验证或未实现

- 真实两三个客户的业务闭环、具体豆子产品连接，需实际接入后验证。
- 微信采集、聊天/报告自动全量归档、常用文档正文提取、OCR/转写/视频分析、完整中文检索、向量检索、定时提醒未实现。
- Twenty原生前端完整构建/浏览器验收未完成；使用4310领域管理台。
- 跨操作系统运行时未测试；当前完整恢复为Linux同架构的新目录。
- 合法引用不证明Agent语义判断必然正确；复杂多来源纠错仍需人工处理。
- 当前用户服务登录后启动，未设置退出登录后的常驻。

备份含客户资料与必要Twenty密钥，需私密保存；新增第三方处理或对外操作不在测试授权内。

## Agent CRM 0.1.1 整理验收

项目、Skill、MCP 标识、桌面入口和用户服务统一为 Agent CRM / `agent-crm`。新目录实际启动后，31 项自动化测试、4 项运维安全测试及 Skill 校验通过；成功测试的独立数据库和合成原件已自动清理。保留小型验收结果，移除旧审查、演练副本和重复导出。见 [cleanup.json](../test/results/cleanup.json)。

独立新上下文使用 reader CLI 和官方 MCP 客户端连接现有服务，确认 0.1.1、500 MB、8 个只读工具，正式客户/材料/待办均为 0。实际豆子产品尚未连接；空库无法验证真实业务的多页材料与证据覆盖。见 [agent-crm-handoff.json](../test/results/agent-crm-handoff.json)。

## Agent CRM 0.1.2 跨宿主与分享验收

优先目标为腾讯 WorkBuddy 与用户称为 DOTS 的 GPT/Codex 侧宿主。新增配置生成器覆盖 WorkBuddy JSON、Codex TOML、通用 JSON 及 WSL stdio 桥接；生成配置不读取凭据正文、不写宿主配置。

- 全套 `npm test` 39 项通过，0 失败/跳过；包括 8 项配置解析/路径/WSL 参数验证，以及现有领域、HTTP/MCP 和真实 500 MB 流式原件验证。成功后合成库及原件自动清理。
- `python3 ops/test_manage.py` 4 项通过；`python3 ops/test_share_package.py` 6 项通过；Skill 校验通过。
- 用 `./ops/crm connection` 实际生成的 WorkBuddy JSON 与 Codex TOML 启动官方 MCP 客户端，分别调用健康、实体、材料和待办，均成功。只发现 8 个只读工具；正式库实体/材料/待办仍为 0。见 [multi-host.json](../test/results/multi-host.json)。
- 本机用户服务已重新启动，当前运行 0.1.2，PostgreSQL、Redis、Twenty API/worker 与领域服务健康；单原件上限仍为 500,000,000 字节。业务表和既有迁移未改变。

以上是配置及协议验证，**不是实际 WorkBuddy 或 DOTS 客户端的界面接入验收**。本轮未注册宿主、发送资料或发布连接器。Windows/WSL2、Docker 部署与跨系统恢复仍待目标环境验证。

源码分享包的逐文件哈希、排除规则和整体 ZIP 校验记录见本机 [share-package.json](../test/results/share-package.json)。源码包不包含 `test/results/`、私有配置、数据库、客户原件、运行时二进制或安装依赖；源码分享不替代私有备份恢复。

## GitHub 上传前的源码净化与更新流程

2026-10-28 补充审查发现上游一份无引用的会议调试文件及两份遗留配置备份。已从 share 和 GitHub 净化快照排除，本机原文件保留；先前生成的分享 ZIP 转入 `.local/quarantine/` 私有保留，不再对外分发。新的源码分享边界测试 7 项通过，包含精确排除调试资料及保留正常同名测试文件。

新增 GitHub 备份 helper 的 15 项离线测试通过：新的独立源码历史、重复准备与增删、许可保留、未知文件和未提交改动拒绝、清单与哈希校验、账号/私有仓库校验、仅明确 404 时建库、临时凭据助手、推送失败和远端提交不一致拒绝。这些测试使用临时合成仓库及模拟 GitHub CLI，不构成实际 GitHub 上传验收。

本机已准备官方仓库提供的 GitHub CLI；本机 CLI 尚未登录，现有连接器确认账号拥有全库授权，但本轮没有建库工具。远端备份仍未完成，实际结果应以成功推送并核对远端提交为准。客户资料未上传，正式服务及数据库未改变。
