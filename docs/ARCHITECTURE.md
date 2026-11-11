# Agent CRM 架构与文件职责

## 运行与数据流

```text
用户材料 → 管理台 / CLI / MCP → 本机 HTTP 服务 → 领域规则
                                                   ├─ PostgreSQL：业务记录、来源、历史
                                                   ├─ 原件目录：objects/<sha256>
                                                   └─ Twenty：有限兼容投影
宿主 Agent ↔ Skill + MCP/CLI ↔ 查询 / 提出更新 / 提交
用户服务监督器 → 启停与健康检查（不执行 AI）
```

宿主 Agent 提供模型、文件理解、上下文与工具调度（Harness）；本项目没有独立自治 Agent 框架，不持有聊天模型密钥。MCP 是薄适配层，从本机 HTTP 发现工具 Schema 并转发调用，CLI 和管理台同样调用领域规则。

写入路径为：先保存原字节与接收元信息 → 宿主读取并查询实体候选 → 提出带证据的更新 → 校验权限、引用、幂等与版本 → 普通事务提交，或保留冲突等待 owner 按用户决定确认。历史不无痕覆盖，后续简报从当前有效记录及其来源重建。

## 文件结构

```text
agent-crm/
├── README.md / AGENTS.md     使用入口与维护规则
├── package.json / package-lock.json
├── src/                     领域、DB、HTTP、MCP、CLI、原件流式存储、投影
├── public/                  本机管理台
├── migrations/              有版本与checksum的数据库迁移
├── skills/agent-crm/        可迁移的业务Skill与工具指南
├── docs/                    方案、接管、使用、架构、契约、安装迁移、测试
├── ops/                     启停、常驻、构建、备份、恢复、导出
├── examples/                小型合成材料及隔离演练说明
├── test/                    自动化与小型验证结果
├── vendor/twenty/           接收者独立准备的上游依赖，不随源码包分发
├── runtime/                 本机PG/Redis二进制、库与许可证
├── node_modules/            根依赖，可按锁文件重建
├── .local/                  私有配置、数据库、原件、日志与服务登记
└── backups/                 私有完整备份
```

`.local/`、`backups/`、运行依赖及构建产物不进入公开代码。用户服务单元位于用户配置目录的 `systemd/user/agent-crm.service`，包含本机路径，迁移后重新安装。

## 权威数据与派生数据

| 层 | 职责 | 可重建性 |
|---|---|---|
| 原件 | 原字节、SHA256、大小和文件元信息；相对路径引用 | 必须保存并备份 |
| `portable_crm` 数据库/schema | 实体、事实/版本、关系、证据、任务/版本、建议、幂等和审计 | 必须保存并备份 |
| `portable_projection` | 领域ID与Twenty对象对应 | 派生映射，与恢复兼容一起保留 |
| `twenty_crm` 数据库 | 已保留原项目的普通客户/联系人/商机投影与内部结构 | 业务投影可重建，当前完整备份仍包含该库 |
| 查询与未来索引 | 从资料生成可检索内容 | 可重建，不作为唯一证据 |
| Agent 简报 | 基于检索内容生成的说明、建议与引用 | 可重新生成；如要求留存需明确归档 |

Twenty 当前只投影客户/组织名称、联系人名称、项目名称及与客户的关联，使用领域稳定 ID。发现人工修改时暂停对应同步，避免覆盖。它不是完整双向 CRM，同步不包含全部事实、六态待办与证据历史；日常入口仍是领域服务。

## 文件与检索

单原件 500,000,000 字节，原始字节流式收发并计算哈希，数据库不保存整份二进制。内联原件32 MiB、JSON请求48 MiB，避免大文件进入工具上下文。上传、备份成功不代表内容已读。

当前检索支持材料文字/时间过滤，以及实体名称、别名和当前事实文字匹配，没有可用的完整中文全文或向量检索链路。未来在同一 PostgreSQL 上增加方案版本、提取段落、中文全文和可选 pgvector；按原件哈希与提取/embedding版本重建。具体阶段见 [PROJECT_PLAN](PROJECT_PLAN.md)。

## 权限和迁移

HTTP 仅回环；reader查询，writer普通录入，owner确认冲突和纠错。服务器复核权限，材料内指令不能直接触发操作。相同操作系统账户可读取本机文件，因此这些角色不等于抵抗恶意宿主的系统隔离。

同机换 Agent 保持服务、数据库和原件，重新加载 Skill 与连接配置。换机器需应用/锁文件、数据库逻辑备份、原件与清单，恢复到全新目标后核对；不能仅迁 Skill 或跨系统复制数据库物理目录。当前运行时与恢复已测试 Linux x86_64；其他系统需适配。

历史审查确认 Twenty 原生上传缺内容去重、任务状态不足且原生MCP有受保护写入限制，因此保留原项目兼容能力，在独立领域层实现证据、状态和迁移约束。旧审查与演练副本不是运行依赖，无需为理解本项目再次加载。

## 多宿主、Windows与分享

WorkBuddy/DOTS/Codex优先接管与配置片段见 [HOSTS.md](HOSTS.md)；Windows/WSL2和Docker的限制、设计及验收步骤见 [WINDOWS_DOCKER.md](WINDOWS_DOCKER.md)。给朋友程序使用不含资料的 `./ops/crm share`，具体见 [SHARING.md](SHARING.md)，不要把个人数据导出当分享包。

名称维护通过 owner 专用领域工具追加审计并保留旧名为别名，不改变实体 ID 或业务归属；无需新增迁移。投影以 JSON 深值比较区分真实外部修改与 GraphQL/JSONB 对象键序差异；真实名称或关联变化仍暂停覆盖。

## 产品身份与受控迁移

`src/products.mjs` 只实现产品身份、关系和断言的纯校验，提交仍由 `src/domain.mjs` 的事务、证据与版本机制执行。没有新建产品事实表或重复原件库，也没有模型服务。产品能力不跨型号/版本继承；客户要求、待验证判断与复核能力分层查询。

`migrations/optional/002_product_entities.sql` 仅扩展实体类型约束；001 不改。`src/db.mjs` 对可选迁移同样检查版本/checksum，但默认不执行，只有显式 productLibraryEnabled:true 才执行。已有可选迁移即使关闭功能仍检查 checksum，不删数据或撤销迁移。监督器可能从工作区重新启动，因此通用默认关闭；实际启用须按目标实例的授权与备份恢复门槛进行。详见[产品资料库](PRODUCT_LIBRARY.md)。

## 产品 UI 的独立入口

public/products.html、products.js、products.css 提供中文交互；product-workflow.mjs 实现可测试的提交编排和前置校验，服务仍为唯一业务约束。workspace.js 仅是新进程选择的旧工作台导航包装，不改旧页面字节。产品 UI 和产品领域分别默认关闭，前者不启动迁移；实际状态由目标实例显式配置决定。

ops/product-preview.mjs 只管理登记且身份匹配的本机合成预览；不同端口使用独立短期会话 Cookie，不共享正式 Cookie。真实Chrome/CDP验收和轻量工作流测试分开，截图来自实际页面；测试和预览不使用正式客户作为输入。

## 需求与分享边界

[业务要求](REQUIREMENTS.md)是独立于原会话的行为基线，[能力清单](CAPABILITIES.md)区分实现与计划。联系人初步核查和主动调研尚无队列、研究表或执行器，不能由Skill文字替代持久任务。未来沿用现有领域服务和同一数据库，按[研究方案](SEEKINGPERSON_INTEGRATION.md)增量实施。

源码包不包含任何现有业务资料或私有部署记录，也不重分发上游Twenty。依赖取得与条款见[第三方说明](THIRD_PARTY.md)，分享包和完整资料备份分别见[SHARING](SHARING.md)、[MIGRATION](MIGRATION.md)。
