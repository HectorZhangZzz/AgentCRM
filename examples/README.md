# 合成演练材料

本目录全部为虚构测试资料，没有真实客户。请只在独立测试配置、数据库和原件目录中运行，避免污染实际工作库。`CRM_CLIENT_CONFIG`/`CRM_CONFIG` 应指向测试实例的配置；不要修改生产配置来试验。

`01-visit.txt` 用于首次归档；`02-update.txt` 用于增量变化、日期与状态更新。`FORWARD_TEST.md` 是给新 Agent 的独立前向验证请求。

若要核对工具接收形状，可先保存材料，再用保存返回的 material ID 生成示例建议：

```bash
node src/cli.mjs ingest examples/01-visit.txt
node examples/make-proposal.mjs MATERIAL_UUID > /tmp/crm-synthetic-proposal.json
node src/cli.mjs call crm_propose @/tmp/crm-synthetic-proposal.json
```

然后审阅返回并用 proposal ID 调用 `crm_commit`。这份建议用于说明 Schema，不能代替 Agent 自行检索已存在实体；重复演练应使用新空测试库，或由 Agent 复用已存在的稳定 ID。重试完全相同的建议会复用相同幂等键。

示例脚本只生成 JSON，不访问网络、数据库、配置或真实资料。完整可靠性由项目验收执行者记录，不以本文件的存在声称通过。
