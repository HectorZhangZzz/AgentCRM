# 领域工具写入参考

以工具发现返回的 JSON Schema 为准。以下是当前 v1 的最小形状，不是原生 Twenty CRUD。

## 保存与查询

- `crm_ingest({text,filename?,source?,occurredAt?,qualityFlags?})` 或用 `base64` 替代 text；二选一，内联原件最多 32 MiB。occurredAt 是有依据的 ISO 时间或 null。JSON 请求上限为 48 MiB；更大文件使用管理台上传或 `node src/cli.mjs ingest <文件> [来源]`，原字节流式传输，单原件上限 500 MB（500,000,000 字节）。服务不接受任意服务器文件路径来绕过上传。
- `crm_material({materialId,includeContent:true})`：读取归档内容与质量标记，内联原件最多 32 MiB。超过时返回 `CONTENT_TOO_LARGE`，用 `details.downloadPath` 的需认证 HTTP 下载入口流式取原件，或省略 includeContent 只查询元信息。二进制返回原字节标记未核验，不伪造 OCR。下载归档文件不等于已理解其全部内容。
- `crm_materials({query?,unprocessedOnly?,occurredAfter?,occurredBefore?,recordedAfter?,recordedBefore?,limit?,offset?})`：分页返回材料。四个日期过滤均为 ISO 日期时间；沟通时间未知的材料不匹配 occurred 筛选，可用 recorded 筛选录入时间。
- `crm_entities({query?,type?,limit?,offset?})`：分页查询名称、显式别名及当前事实的 key/value 字面值，可查型号或 AI Box；不是自动语义向量检索。type 可为 customer/contact/project/organization/issue。
- `crm_customer({entityId,includeCompleted?})`：带证据、项目、关系、当前待办和时间线的全景。
- `crm_evidence({evidenceId})`：回到材料、quote、locator 和原件访问标识。

大于 32 MiB 的原件不会自动填充 `textContent` 或进入正文索引；文本 MIME 使用 `text_extraction_deferred_large_file` 标记，`extractionStatus` 为兼容仍保留 `unprocessed_binary`。检索简报应说明这些已留存但尚未提取的内容，不能把正文搜索结果当成完整附件覆盖。

## 提出与提交更新

`crm_propose({idempotencyKey,materialIds:[MATERIAL_ID],operations:[...]})` 保存建议。证据形状：

```json
{
  "materialId": "MATERIAL_UUID",
  "quote": "对应原文的准确子串",
  "locator": {"kind":"text"}
}
```

文本可添加 start/end，两者同时给出且范围须与 quote 完全对应；不要猜偏移。二进制用 `{kind:"page",page:1}` 或 `{kind:"image",page:1,bbox:[...]}`，页码/位置须来自实际阅读。没有读取内容不要写不存在的引文。

常见 operations：

```json
[
  {"op":"create_entity","ref":"customer","type":"customer","name":"客户名称","evidence":["EVIDENCE_OBJECT"]},
  {"op":"link_material","materialId":"MATERIAL_UUID","entityId":"$customer"},
  {"op":"set_fact","entityId":"$customer","key":"business","value":"业务描述","classification":"customer_claim","evidence":["EVIDENCE_OBJECT"]},
  {"op":"add_relation","fromId":"$customer","toId":"PROJECT_UUID","kind":"has_project","evidence":["EVIDENCE_OBJECT"]},
  {"op":"upsert_task","taskKey":"稳定业务键","entityId":"$customer","projectId":"PROJECT_UUID","title":"提供样品报价","party":"self","owner":null,"dueAt":null,"waitingFor":null,"status":"todo","evidence":["EVIDENCE_OBJECT"]}
]
```

示例中的 `EVIDENCE_OBJECT` 是说明占位，实际必须替换为上面的对象；UUID 同理。`ref:"customer"` 的本建议后续引用为 `$customer`。已有实体须使用查询得到的 UUID，不按名称 upsert。taskKey 在重试和重复语义操作时保持稳定，不能每次随机生成以致重复待办。

事实新值不同于当前值会形成冲突。更新已有事实可带 expectedVersion；任务更新必须带当前版本。先 `crm_propose` 后 `crm_commit({proposalId})`。普通 writer 提交无冲突建议；有冲突返回差异，不由 writer 强行解决。

## 待办与人工纠错

`crm_tasks({entityId?,status?,includeCompleted?,limit?,offset?})` 默认排除 completed/cancelled。`crm_task_update({taskId,expectedVersion,idempotencyKey,status?,title?,owner?,dueAt?,waitingFor?,evidence:[...]})` 留版本和来源。改期须提交有依据的新 dueAt 或明确置 null，不能靠简报文字改期。

`crm_reassign({materialId,fromEntityId,toEntityId,reason,expectedVersion?,idempotencyKey})` 只允许 owner。它安全移动由该材料独立支持的事实/任务，保留稳定 ID。项目关联、多源证据、已有同键事实或关系可能成为 pending；pending 非空时保留原关联，不能说纠错已全部完成。

权限拒绝时不要提升自身角色。`STALE_VERSION` 先重新查询；`IDEMPOTENCY_MISMATCH` 表示相同键的参数变了，先确认原请求，不盲目重试；工具错误或提交失败不能视为已保存。
