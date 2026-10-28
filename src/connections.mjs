import path from "node:path";

const hosts = new Set([
  "generic",
  "workbuddy",
  "codex",
  "dots",
  "hermes",
  "openclaw",
]);

export function parseConnectionArgs(args) {
  const options = { host: "generic", role: "writer" };
  const flags = new Map([
    ["--host", "host"],
    ["--wsl", "wsl"],
    ["--project-root", "root"],
    ["--node", "node"],
  ]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reader") {
      options.role = "reader";
      continue;
    }
    const key = flags.get(args[i]);
    if (!key || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(
        "connection 参数无效；支持 --reader --host --wsl --project-root --node",
      );
    options[key] = args[++i];
  }
  return options;
}

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\x00\r\n]/.test(value))
    throw new Error(`${label}不能为空或包含控制字符`);
  return value;
}

// Render only: never reads credentials or edits a host's own configuration.
export function renderConnection({
  host = "generic",
  role = "writer",
  root,
  node,
  wsl,
  platform = process.platform,
}) {
  if (!hosts.has(host))
    throw new Error(
      "未知宿主；支持 generic/workbuddy/codex/dots/hermes/openclaw",
    );
  if (!["reader", "writer"].includes(role))
    throw new Error("连接配置仅支持 reader 或 writer");
  nonempty(root, "项目路径");
  nonempty(node, "Node 路径");
  const paths = platform === "win32" && !wsl ? path.win32 : path.posix;
  if (!paths.isAbsolute(root))
    throw new Error(
      wsl
        ? "WSL 配置需要 Linux 绝对项目路径；在 WSL 内生成或传 --project-root"
        : "项目路径须为绝对路径",
    );
  const client = paths.join(root, ".local", `${role}-client.json`);
  const script = paths.join(root, "src", "mcp.mjs");
  let entry;
  if (wsl) {
    nonempty(wsl, "WSL 发行版名称");
    if (wsl.startsWith("-")) throw new Error("WSL 发行版名称无效");
    entry = {
      command: "wsl.exe",
      args: [
        "--distribution",
        wsl,
        "--exec",
        "env",
        `CRM_CLIENT_CONFIG=${client}`,
        node,
        script,
      ],
    };
  } else {
    entry = {
      command: node,
      args: [script],
      env: { CRM_CLIENT_CONFIG: client },
    };
  }
  let format, text;
  if (host === "codex") {
    format = "toml";
    text = `[mcp_servers.agent-crm]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
    if (entry.env)
      text += `\n[mcp_servers.agent-crm.env]\nCRM_CLIENT_CONFIG = ${JSON.stringify(client)}\n`;
  } else if (host === "hermes") {
    format = "yaml";
    text = `mcp_servers:\n  agent-crm:\n    command: ${JSON.stringify(entry.command)}\n    args: ${JSON.stringify(entry.args)}\n`;
    if (entry.env)
      text += `    env:\n      CRM_CLIENT_CONFIG: ${JSON.stringify(client)}\n`;
  } else {
    format = "json";
    if (host === "workbuddy") entry = { type: "stdio", ...entry };
    const config =
      host === "openclaw"
        ? { mcp: { servers: { "agent-crm": entry } } }
        : { mcpServers: { "agent-crm": entry } };
    text = JSON.stringify(config, null, 2) + "\n";
  }
  return { host, role, format, text };
}
