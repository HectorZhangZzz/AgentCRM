# 宿主适配层

Agent CRM 的事实、原件和工具契约不属于任何宿主。宿主负责模型、文件理解、工具调用和授权；它通过本地 MCP stdio 或 CLI 使用同一领域 HTTP 服务。HTTP REST 地址不是 Streamable HTTP MCP 地址。

主要目标是腾讯 WorkBuddy 与用户称为 DOTS 的 GPT/Codex 侧宿主。DOTS 不是本项目已经确认的官方产品标识；有 Codex 的 TOML 配置入口时用 `--host codex`，接受标准 MCP JSON 时用 `--host dots` 或 `generic`。这不是保证任意名为 DOTS 的程序兼容。

| 参数 | 输出格式 | 用途 |
|---|---|---|
| `--host workbuddy` | `mcpServers` JSON，显式 `type: stdio` | 主要宿主 |
| `--host codex` | `mcp_servers` TOML 片段 | OpenAI/Codex 官方配置形状 |
| `--host dots` / `generic` | 标准 MCP JSON | 待确认入口、其他兼容宿主 |
| `--host hermes` | `mcp_servers` YAML 片段 | 次要兼容路径，未实接宿主 |
| `--host openclaw` | `mcp.servers` JSON 片段 | 次要兼容路径，未实接宿主 |

```bash
./ops/crm connection --host workbuddy --reader
./ops/crm connection --host codex --reader
```

不带 `--reader` 时生成 writer 连接，保留既有行为。生成器只输出配置片段，不读取令牌，不修改宿主配置，不安装插件，也不扩大权限。不要用输出覆盖宿主的整份配置；合并 Agent CRM 一项，保留原连接器。

`--project-root` 和 `--node` 可为新机器生成正确路径；路径必须是目标环境绝对项目路径，Node 可指定绝对可执行路径。`--wsl <发行版>` 为 Windows 宿主生成 `wsl.exe --exec env ... node ...` 桥接，令牌仍只存在 WSL 内的客户端文件中。它是模板生成，不证明 WSL 环境已经运行。

加载同一份 [Skill](../skills/agent-crm/SKILL.md)，不复制出各宿主自行修改的业务规则。具体步骤见 [宿主接管](../docs/HOSTS.md)、[Windows/Docker](../docs/WINDOWS_DOCKER.md)。
