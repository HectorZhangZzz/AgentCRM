# WorkBuddy、DOTS/Codex 与其他宿主接管

## 一套事实，多种宿主

当前优先支持的接入目标是腾讯 WorkBuddy 和用户称为 DOTS 的 GPT/Codex 侧宿主；Hermes、OpenClaw 是次要扩展路径。业务规则在 Skill，持久事实在本机 PostgreSQL 与原件目录，宿主通过 MCP stdio / CLI 使用同一套工具。换宿主无需复制、重建或再导入数据库。

| 宿主 | 官方能力依据 | 本项目状态 |
|---|---|---|
| WorkBuddy | 本地 stdio MCP、command/args/env、MCP + Skill | 配置生成与通用协议验证；未在 WorkBuddy 客户端实接 |
| Codex | 本地 MCP，`mcp_servers` TOML，command/args/env | 配置生成与通用协议验证；未修改用户 Codex 配置 |
| DOTS | 用户对 GPT/Codex 侧入口的称呼，具体入口尚未验证 | 可选 Codex 或标准 JSON 模板；不冒充独立官方产品认证 |
| Hermes / OpenClaw | 各自官方文档提供本地 MCP 配置 | 有相应配置输出；未实接目标宿主 |

资料来源核对于 2026-10-28：[WorkBuddy 官方连接器文档](https://open.workbuddy.cn/docs/connector)、[OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)、[Hermes 官方 MCP 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)、[OpenClaw 官方 MCP registry](https://docs.openclaw.ai/cli/mcp/registry)。客户端版本与账户能力可能不同，以实际导入和调用结果为准。

## WorkBuddy 优先路径

1. 保持 CRM 现有服务运行，执行 `./ops/crm status`。
2. 执行 `./ops/crm connection --host workbuddy --reader`。在客户端提供的自定义 MCP/连接器配置入口合并这一项，入口名称以实际版本为准。
3. 将项目 Skill 交给宿主作为工作规范，不把 `.local/config.json` 或令牌粘贴进提示词。
4. 发现工具后实际调用 `crm_health`、分页查询 `crm_entities`、`crm_materials`、`crm_tasks`。检查实际覆盖与未提取附件。
5. 准备日常录入后，用 `./ops/crm connection --host workbuddy` 生成 writer 配置替换该连接。owner 不交给日常 Agent。

生成的是本地 MCP 配置片段，不是 WorkBuddy 市场发布安装包。本轮不注册、上传或发布连接器，也不把 WorkBuddy 与 CodeBuddy 的配置目录混用。若客户端没有可用本地 MCP 入口，可按其授权的本地工具能力使用 CLI；不通过公开本机端口绕过客户端限制。

## DOTS / Codex 路径

如果目标入口使用 Codex 配置体系：

```bash
./ops/crm connection --host codex --reader
```

输出为 TOML 片段，按 OpenAI 文档合并到目标的 `config.toml`，或通过它提供的 MCP 添加入口录入同样的 command、args 与 env；不覆盖已有配置。确认连接后生成 writer 片段。若目标只接收 `mcpServers` JSON，改用 `--host dots` 或 `generic`。云端 ChatGPT 页面不自动读取本机 Codex 配置，云端的 localhost 也不是这台电脑。

本项目未更改任何宿主的模型、账户、系统权限或配置。具体 DOTS 程序仍须先确认它支持哪一种入口；支持标准协议不等于已经通过该产品验收。

## CLI 后备与 Windows

```bash
CRM_CLIENT_CONFIG=.local/reader-client.json node src/cli.mjs call crm_health '{}'
CRM_CLIENT_CONFIG=.local/reader-client.json node src/cli.mjs call crm_entities '{"limit":20,"offset":0}'
```

同一台电脑上可以接多个只读宿主；写入建议由当前任务指定的一个宿主负责。版本、幂等与冲突机制继续生效，但不能把这些机制当成不同 Agent 语义判断一定一致的保证。不要启动多套正式库分别录入。

Windows 原生宿主可通过 `wsl.exe` 在 WSL 里启动 MCP，保持资料和凭据留在同一 Linux 环境。生成示例：

```bash
./ops/crm connection --host workbuddy --reader --wsl Ubuntu-24.04 \
  --project-root /home/your-user/agent-crm --node /usr/bin/node
```

Windows、WSL2、Docker 当前的真实限制及后续验收见 [WINDOWS_DOCKER.md](WINDOWS_DOCKER.md)。

## 每个新宿主必须通过的接管检查

- reader 实际调用成功，只有只读工具；离线、权限不足能明确失败。
- 按客户稳定 ID 回查已有材料、历史和依据，说明分页与缺失，不凭模型记忆补答。
- 在独立合成实例验证 writer 录入、重复、冲突、六态待办；不往正式库写示例测试。
- 记录宿主名称/版本、系统、配置形状、调用结果。不能以“导入 Skill”或“看到工具目录”替代验收。
- 真实资料交给新的模型服务前核对用户授权；本机数据库不会让云端模型处理自动变成本地处理。
