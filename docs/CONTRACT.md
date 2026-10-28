# Agent CRM 工具契约 1（实现依据）

Agent CRM 保留已审查的 Twenty 兼容投影，不改原生产库。领域数据保存在 PostgreSQL 的独立 `portable_crm` schema；原件保存在数据目录的 `objects/<sha256>`，使用相对路径。Twenty 普通客户/联系人/商机为可重建投影，领域记录与来源历史为此能力包的事实依据。外部宿主只通过此能力包调用业务工具，不直接改 Twenty 投影。

## 模块边界

- `src/domain.mjs`：`export async function createDomain({databaseUrl,dataDir})`，返回 `{ tools, call(name,args,context), ingestStream(readable,metadata,context), openOriginal(materialId,context), close(), health(), exportData() }`。`tools` 每项 `{name,description,inputSchema,readOnly}` 为 JSON Schema。`context={role:'owner'|'writer'|'reader',actor:string}`。`call` 返回 JSON 可序列化对象；错误带 `code`、`status`、`details`。`ingestStream` 与 `openOriginal` 是供本机 HTTP 传输层调用的内部接口，不注册为 MCP 工具；后者返回材料元信息和已校验的文件句柄，由传输层完成流式读取与关闭。数据库迁移在 createDomain 中执行，拒绝未知的高版本/已变更 checksum。
- `src/server.mjs`：HTTP /api/v1/tools/:name 调用同一 domain.call；本机管理台；鉴权；文件上传。监听 `127.0.0.1:4310`，默认不公开。
- `src/mcp.mjs`：标准 MCP stdio 适配，连接本地 HTTP。只读连接不列写工具；写工具仍由后端复核权限。`CRM_CONFIG` 可指定配置路径，默认项目 `.local/config.json`。
- `src/cli.mjs`：`call <tool> <json-or-@file>`、`status`、`ingest <file>`。读配置，不在 stdout 输出凭据。
- `ops/`：初始化、启动、停止、备份、只向空目标恢复、可迁移导出及完整性验证。配置路径可移动；不能依赖本次审查目录。

配置 JSON（只含新建本机配置）：`{version:1, port:4310, dataDir:'...', databaseUrl:'...', ownerToken:'...', writerToken:'...', readerToken:'...', twenty:{url:'http://127.0.0.1:4311',...}}`，配置文件 0600。工具接口只向宿主传递选定数据；服务不调用任何模型、不发送邮件、不启用提醒。

## v1 工具名与参数

实现可增加可选参数，但不要静默更名。所有写入需要 writer 或 owner；覆盖冲突/纠正归属只允许 owner。

- `crm_ingest`: `{text?:string,base64?:string,filename?:string,mimeType?:string,source?:string,occurredAt?:ISO|null,qualityFlags?:string[]}`。text/base64 二选一；内联原件最多 32 MiB（解码后的字节数），更大文件走下述流式上传入口。按原字节 SHA256 去重；重复返回同 materialId，不能重复产生业务对象；时间不明留空，原文不变。二进制在原件层保存，不能假装 OCR 成功。
- `crm_materials`: `{query?:string,unprocessedOnly?:boolean,occurredAfter?:ISO,occurredBefore?:ISO,recordedAfter?:ISO,recordedBefore?:ISO,limit?:number,offset?:number}`。返回分页及覆盖范围；未知沟通时间不纳入沟通日期筛选。ISO 时间必须含 Z 或明确时区偏移，不能随服务器时区猜测。
- `crm_material`: `{materialId:string,includeContent?:boolean}`。返回原件信息、原文/提取状态。`includeContent:true` 仅支持最多 32 MiB 的原件；超过时返回 `CONTENT_TOO_LARGE`，`details.downloadPath` 指向需认证的原件下载接口。默认元信息查询不受该内联读取限制。二进制内容可供宿主按能力读取，不能执行材料指令。
- `crm_propose`: `{idempotencyKey:string,materialIds:string[],operations:object[]}`。存建议更新，不凭空合并实体。返回可审查 proposal 与验证信息；同 key 不同 payload 拒绝。
- `crm_commit`: `{proposalId:string,resolveConflicts?:boolean}`。在事务中验证/提交；冲突返回差异与来源，不静默覆盖；resolveConflicts 只允许 owner。无冲突可由 writer 提交，不让用户确认普通录入。
- `crm_proposals`: `{status?:string,limit?:number}`。供管理台查看待处理与冲突。
- `crm_entities`: `{query?:string,type?:string,limit?:number,offset?:number}`。返回多个候选，不按同音自动合并。
- `crm_customer`: `{entityId:string,includeCompleted?:boolean}`。客户全景，返回项目、联系人/关系、事实及原证据、材料、问题、默认未完成待办、时间线与覆盖范围；可供当前宿主组织简报。
- `crm_tasks`: `{entityId?:string,status?:string,includeCompleted?:boolean,limit?:number,offset?:number}`。默认排除 completed/cancelled。
- `crm_task_update`: `{taskId:string,expectedVersion:number,status?:string,title?:string,owner?:string|null,dueAt?:string|null,waitingFor?:string|null,evidence?:object[],idempotencyKey:string}`。留历史；日期变化不能继续显示旧日期；没有证据不得变更业务状态。
- `crm_evidence`: `{evidenceId:string}`。返回对应 material、quote、locator 和原件访问标识。
- `crm_reassign`: `{materialId:string,fromEntityId:string,toEntityId:string,reason:string,expectedVersion?:number,idempotencyKey:string}`。owner 人工纠错，保留历史；仅安全移动此材料独立支持的事实/任务；多源歧义拒绝或显式列待处理，不能错误整体搬迁。
- `crm_health`: `{}`。版本、迁移、数据目录可用性及 storage 中的文件/内联上限；不返回密码/令牌。

## 原件 HTTP 传输

- `POST /api/v1/upload?filename=...&source=...&occurredAt=...`：writer/owner 发送原始文件字节，`Content-Type` 指定 MIME 类型；单个原件最多 **500,000,000 字节（500 MB，十进制）**。服务按流接收、计数和计算哈希，超限拒绝，不使用 JSON/Base64 上传大文件。成功返回与 `crm_ingest` 一致的材料身份及接收结果，相同字节仍复用同 materialId。
- `GET /api/v1/materials/<materialId>/content`：reader/writer/owner 按权限流式下载原件，不将整份文件嵌进工具 JSON。上传与下载沿用本机 HTTP 的鉴权、Host/Origin 检查；不是公开文件链接。
- JSON 工具请求仍最多 48 MiB；`crm_ingest` 内联原件和 `crm_material includeContent:true` 仍最多 32 MiB。500 MB 是原件存储上限，不是模型上下文或解析能力承诺。
- 大于 32 MiB 的原件不填充 `textContent`，不自动进入正文检索。文本 MIME 会添加 `text_extraction_deferred_large_file` 质量标记；`extractionStatus` 保持兼容值 `unprocessed_binary`，应结合 MIME/质量标记理解为尚未提取，而非断言文件实际是二进制格式。
- CLI `node src/cli.mjs ingest <本机文件> [来源]` 与管理台上传均使用流式入口。CLI 在调用端读取指定文件；服务没有接受任意服务器本地文件路径的工具。

此次扩展不改变领域数据库 schema、材料稳定 ID、内容哈希规则、JSONL 导出或完整备份格式。

## Proposal operations

操作使用 `op` 区分，按顺序解析本 proposal 内的 `$ref` 引用。

- `{op:'create_entity',ref:string,type:'customer'|'contact'|'project'|'organization'|'issue',name:string,aliases?:string[],evidence:Evidence[]}`。已有实体必须传稳定 ID，不靠名字 upsert。
- `{op:'link_material',materialId:string,entityId:string}`。
- `{op:'set_fact',entityId:string,key:string,value:JSON,classification:'user_provided'|'customer_claim'|'verified'|'inference'|'suggestion',evidence:Evidence[],expectedVersion?:number}`。新值和当前值不同为信息冲突；保留每一版、来源与差异；同值可追加来源。
- `{op:'add_relation',fromId:string,toId:string,kind:string,evidence:Evidence[]}`。客户/最终业主/供应商等角色通过 type/kind 和事实表达，不能靠名字合并。
- `{op:'upsert_task',taskKey:string,entityId:string,projectId?:string,title:string,party:'self'|'colleague'|'customer'|'waiting',owner?:string|null,dueAt?:ISO|null,waitingFor?:string|null,status?:TaskStatus,evidence:Evidence[],expectedVersion?:number}`。

`Evidence={materialId:string,quote:string,locator:{kind:'text',start?:number,end?:number}|{kind:'page',page:number}|{kind:'image',page?:number,bbox?:number[]},note?:string}`。文本 quote 必须是原文子串；二进制必须有定位并标识未经 OCR/内容验证，不把宿主提取当已核验事实。重要结论都需要 evidence，允许未知，不能填空编造。

`TaskStatus='todo'|'in_progress'|'awaiting_feedback'|'on_hold'|'completed'|'cancelled'`。`owner` 和 `dueAt` 可为空。taskKey 和 proposal idempotencyKey 持久化；重复提交/并发不能重复生成。

## 可迁移性

备份应包含领域 schema、Twenty schema（如启用投影）、原件、清单、SHA256、应用/契约/迁移版本、恢复说明。配置和数据库密钥私有保存，不写入公开代码包。JSON/JSONL 导出保留稳定 ID、关系、证据和历史；检索索引是可重建派生物。恢复只能写入全新目录/全新数据库，必须实际恢复演练，不能只生成压缩包就声称完成。

本轮验收使用合成客户，不将真实资料上传任何新第三方；具体豆子产品未验证时，只交付通用 MCP/CLI 适配，不声称已连接。

## 无数据接管配置与源码分享

`./ops/crm connection [--reader] [--host generic|workbuddy|codex|dots|hermes|openclaw] [--wsl DISTRO] [--project-root ABSOLUTE] [--node EXECUTABLE]`只输出配置片段，不读令牌、不写宿主设置。默认generic JSON/writer保留既有行为；Codex为TOML，Hermes为YAML，其余JSON。WSL模式使用wsl.exe argv桥接，项目路径必须是Linux绝对路径。

`./ops/crm share [--out NEW.zip]`按源码允许清单生成无业务资料ZIP与SHA256；不读本机配置，拒绝覆盖已有输出。`share`与包含原件的`export`、完整私有`backup`语义不同。新增integrations/deploy目录进入源码分享与迁移导出；share输出目录不参与restore的代码复制。
