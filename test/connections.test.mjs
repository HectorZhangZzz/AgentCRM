import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseConnectionArgs, renderConnection } from "../src/connections.mjs";

const base = {
  root: "/workspace/Agent CRM",
  node: "/opt/node 24/bin/node",
  platform: "linux",
};
const entry = (options) =>
  JSON.parse(renderConnection({ ...base, ...options }).text).mcpServers[
    "agent-crm"
  ];

test("default connection retains existing writer JSON contract without credential values", () => {
  const cfg = entry({});
  assert.equal(cfg.command, base.node);
  assert.deepEqual(cfg.args, ["/workspace/Agent CRM/src/mcp.mjs"]);
  assert.deepEqual(cfg.env, {
    CRM_CLIENT_CONFIG: "/workspace/Agent CRM/.local/writer-client.json",
  });
  assert.ok(!JSON.stringify(cfg).includes("Bearer"));
});

test("WorkBuddy reader configuration selects only the reader credential file", () => {
  const cfg = entry({ host: "workbuddy", role: "reader" });
  assert.equal(cfg.type, "stdio");
  assert.equal(
    cfg.env.CRM_CLIENT_CONFIG,
    "/workspace/Agent CRM/.local/reader-client.json",
  );
  assert.ok(!JSON.stringify(cfg).includes("owner"));
});

test("Codex TOML parses correctly with Windows paths, spaces and Unicode", () => {
  const rendered = renderConnection({
    host: "codex",
    role: "reader",
    platform: "win32",
    root: "C:\\Agent CRM\\客户资料",
    node: "C:\\Node 24\\node.exe",
  });
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import sys,json,tomllib;print(json.dumps(tomllib.loads(sys.stdin.read())))",
    ],
    { input: rendered.text, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const cfg = JSON.parse(result.stdout).mcp_servers["agent-crm"];
  assert.equal(cfg.command, "C:\\Node 24\\node.exe");
  assert.deepEqual(cfg.args, ["C:\\Agent CRM\\客户资料\\src\\mcp.mjs"]);
  assert.equal(
    cfg.env.CRM_CLIENT_CONFIG,
    "C:\\Agent CRM\\客户资料\\.local\\reader-client.json",
  );
});

test("WSL bridge keeps Linux auth path in argv and never requires shell interpretation", () => {
  const cfg = entry({ host: "workbuddy", role: "reader", wsl: "Ubuntu-24.04" });
  assert.equal(cfg.command, "wsl.exe");
  assert.deepEqual(cfg.args, [
    "--distribution",
    "Ubuntu-24.04",
    "--exec",
    "env",
    "CRM_CLIENT_CONFIG=/workspace/Agent CRM/.local/reader-client.json",
    base.node,
    "/workspace/Agent CRM/src/mcp.mjs",
  ]);
  assert.ok(!cfg.args.includes("-c"));
  assert.ok(!cfg.args.includes("-t"));
  assert.equal(cfg.env, undefined);
});

test("secondary host shapes remain separate and DOTS uses neutral JSON", () => {
  const openclaw = JSON.parse(
    renderConnection({ ...base, host: "openclaw", role: "reader" }).text,
  );
  assert.equal(
    openclaw.mcp.servers["agent-crm"].env.CRM_CLIENT_CONFIG,
    "/workspace/Agent CRM/.local/reader-client.json",
  );
  assert.deepEqual(
    entry({ host: "dots", role: "reader" }),
    entry({ host: "generic", role: "reader" }),
  );
  const hermes = renderConnection({ ...base, host: "hermes", role: "reader" });
  assert.equal(hermes.format, "yaml");
  assert.match(hermes.text, /^mcp_servers:\n  agent-crm:/);
  assert.match(
    hermes.text,
    /CRM_CLIENT_CONFIG: "\/workspace\/Agent CRM\/\.local\/reader-client.json"/,
  );
});

test("host configuration rejects privilege escalation, invalid control characters and relative WSL paths", () => {
  for (const options of [
    { host: "unknown" },
    { role: "owner" },
    { root: "relative/path" },
    { node: "node\nmalicious" },
    { wsl: "--help" },
    { platform: "win32", root: "C:\\CRM", wsl: "Ubuntu" },
  ])
    assert.throws(() => renderConnection({ ...base, ...options }));
});

test("connection argument parser preserves compatibility and rejects unknown or incomplete flags", () => {
  assert.deepEqual(parseConnectionArgs([]), {
    host: "generic",
    role: "writer",
  });
  assert.deepEqual(
    parseConnectionArgs([
      "--host",
      "workbuddy",
      "--reader",
      "--wsl",
      "Ubuntu-24.04",
      "--project-root",
      "/home/user/agent-crm",
      "--node",
      "/usr/bin/node",
    ]),
    {
      host: "workbuddy",
      role: "reader",
      wsl: "Ubuntu-24.04",
      root: "/home/user/agent-crm",
      node: "/usr/bin/node",
    },
  );
  for (const args of [["--owner"], ["--host"], ["--host", "--reader"]])
    assert.throws(() => parseConnectionArgs(args));
});

test("paths with quotes and command-like characters are data in JSON and TOML", () => {
  const root = '/workspace/CRM "quoted" $(literal)';
  const cfg = entry({ root, role: "reader" });
  assert.deepEqual(cfg.args, [root + "/src/mcp.mjs"]);
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import sys,json,tomllib;print(json.dumps(tomllib.loads(sys.stdin.read())))",
    ],
    {
      input: renderConnection({ ...base, root, host: "codex" }).text,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout).mcp_servers["agent-crm"].args,
    cfg.args,
  );
});
