# 把 Agent CRM 交给豆子

本说明适用于继续使用当前电脑上的同一套资料；WorkBuddy 与 DOTS/Codex 的具体配置见 [HOSTS.md](HOSTS.md)。无需重新建库或恢复，先连接已有服务即可。豆子的具体产品和工具能力尚未验证；支持本地 MCP stdio 时可直接接入，否则先尝试本地 CLI，不能为接入而公开服务端口。

## 可以直接复制给豆子的指令

> 请接管这台电脑上的 Agent CRM。项目目录是这份说明所在的 `agent-crm` 根目录，请先确认当前绝对路径。先阅读根目录 `AGENTS.md`、`README.md`、`docs/HANDOFF.md`、`docs/CONTRACT.md` 和 `skills/agent-crm/SKILL.md`。这是已部署项目，请保留现有数据库、原件和历史，不要重新初始化或另建一套正式资料库。先检查 `./ops/crm status`，需要时启动服务；按目标入口用 `./ops/crm connection --host workbuddy --reader`、`--host codex --reader` 或通用 JSON 的 `--host dots --reader` 取得当前路径的只读 MCP 配置，调用 `crm_health`，分页查看客户、材料和未完成待办，说明实际覆盖范围。确认连接正常后，日常录入继续使用同一 `--host` 参数并去掉 `--reader`，生成对应格式的 writer 配置。普通无冲突录入直接完成；关键身份歧义才询问，冲突覆盖或归属纠正交由本人在管理台确认，不能自行取 owner 权限。所有重要结论保留原文证据；没有成功返回就不能声称已保存。单个原件最多 500 MB，较大文件用流式文件入口。文件保存不等于全文已解析，当前聊天、微信和生成的报告不会自动全量归档。不要把真实资料上传新的第三方、发送消息、付费、公开部署、扩大权限或不可恢复删除。完成连接后，告诉我现有客户/材料/待办数量、未读附件、未完成连接项，然后开始用两三个客户验证闭环。

## 连接检查

在项目根目录：

```bash
./ops/crm status
./ops/crm start
./ops/crm connection --host workbuddy --reader
# Codex 入口则使用：./ops/crm connection --host codex --reader
```

输出配置只引用 `.local/reader-client.json`，不嵌入访问令牌。按宿主的实际字段配置 MCP；将 `skills/agent-crm/SKILL.md` 作为业务工作规范。工具发现成功后还需要实际调用，不把“看得到工具”当作数据已读。

如豆子没有 MCP 入口但能执行本地命令，可先使用只读 CLI：

```bash
CRM_CLIENT_CONFIG=.local/reader-client.json node src/cli.mjs call crm_health '{}'
CRM_CLIENT_CONFIG=.local/reader-client.json node src/cli.mjs call crm_entities '{"limit":20,"offset":0}'
CRM_CLIENT_CONFIG=.local/reader-client.json node src/cli.mjs call crm_materials '{"limit":20,"offset":0}'
CRM_CLIENT_CONFIG=.local/reader-client.json node src/cli.mjs call crm_tasks '{"limit":20,"offset":0}'
```

资料多时继续分页。读取客户详细历史用稳定实体 ID 调用 `crm_customer`，重要结论用 `crm_evidence` 回查。服务离线时明确不能保存或查询，不用模型记忆补答。

## 开始实际业务

连接验证后按原宿主运行 `./ops/crm connection --host workbuddy` 或 `./ops/crm connection --host codex`；标准 JSON 入口使用 `--host dots`。保留同一 `--host` 并去掉 `--reader`，让日常录入使用 `.local/writer-client.json`。首轮选两三个客户，分别完成材料保存、身份关联、档案更新、简报和待办，再验证重复录入、一个冲突及一次纠错。合成技术演练须用独立测试库，不能把示例当真实客户写入。

用户本人执行 `./ops/crm open` 进入可信管理台，处理冲突确认和纠错。CLI/MCP 日常宿主遇 `FORBIDDEN` 不换角色绕过。新模型宿主可能改变真实资料流向，未经用户另行确认不得先把客户原文发给新的第三方试接。

同机接管不执行 restore；只有换目录或换电脑才按 [MIGRATION.md](MIGRATION.md) 恢复。其他能力边界和维护检查见 [HANDOFF.md](HANDOFF.md)。
