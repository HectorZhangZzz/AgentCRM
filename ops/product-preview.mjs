import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { loadConfig, projectRoot, api } from "../src/config.mjs";
export const previewEntry = (item) =>
  item.url + (item.ui === true ? "/products" : "/");
// Keep the historical default so existing previews remain manageable; new
// installations can isolate their registry without editing this script.
const stateFile = path.resolve(
  process.env.CRM_PRODUCT_PREVIEW_ROOT || "/tmp/agent-crm-product-ui-20261105",
  "preview-state.json",
);
const command = process.argv[2] || "status";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const load = async () => JSON.parse(await fs.readFile(stateFile, "utf8"));
const configFor = async (item) =>
  JSON.parse(await fs.readFile(item.config, "utf8"));
async function running(item) {
  try {
    const env = await fs.readFile(`/proc/${item.pid}/environ`);
    return env
      .toString()
      .split("\0")
      .includes("CRM_CONFIG=" + item.config);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error(
      "无法核验预览进程身份，未执行启停；请在有正常本机进程读取权限的终端操作。",
    );
  }
}
async function call(item, name, args = {}) {
  const cfg = await configFor(item);
  return api(
    { url: item.url, token: cfg.writerToken },
    "/api/v1/tools/" + name,
    args,
  );
}
async function start() {
  try {
    const old = await load();
    if ((await Promise.all(old.instances.map(running))).some(Boolean))
      throw Error("已有预览在运行，请先查看 status；不会新开第二批。");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const main = loadConfig(),
    tag = Date.now().toString(36),
    directory = await fs.mkdtemp("/tmp/agent-crm-product-preview-");
  await fs.chmod(directory, 0o700);
  const state = {
    directory,
    createdAt: new Date().toISOString(),
    instances: [],
  };
  const pool = new pg.Pool({ connectionString: main.databaseUrl });
  try {
    for (const [index, spec] of [
      { label: "on", enabled: true, ui: true },
      { label: "off", enabled: false, ui: true },
      { label: "legacy", enabled: false, ui: false },
    ].entries()) {
      const { label, enabled, ui } = spec;
      const database = `crm_product_ui_${label}_test_${tag}`;
      await pool.query(`CREATE DATABASE "${database}"`);
      const u = new URL(main.databaseUrl);
      u.pathname = "/" + database;
      const cfg = {
        version: 1,
        port: 4325 + index,
        dataDir: path.join(directory, label + "-data"),
        databaseUrl: u.toString(),
        // Disposable synthetic fixture tokens: no formal HTTP credentials.
        ...Object.fromEntries(
          ["owner", "writer", "reader"].map((role) => [
            role + "Token",
            randomBytes(32).toString("hex"),
          ]),
        ),
        ...(ui ? { productUiEnabled: true } : {}),
        productLibraryEnabled: enabled,
        previewOnly: true,
      };
      const config = path.join(directory, label + "-config.json");
      await fs.writeFile(config, JSON.stringify(cfg), { mode: 0o600 });
      const logfile = await fs.open(
        path.join(directory, label + ".log"),
        "a",
        0o600,
      );
      const child = spawn(process.execPath, ["src/server.mjs"], {
        cwd: projectRoot,
        env: { ...process.env, CRM_CONFIG: config },
        detached: true,
        stdio: ["ignore", logfile.fd, logfile.fd],
      });
      child.unref();
      await logfile.close();
      const item = {
        enabled,
        ui,
        database,
        config,
        pid: child.pid,
        url: `http://127.0.0.1:${cfg.port}`,
      };
      state.instances.push(item);
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try {
          if ((await fetch(item.url + "/healthz")).ok) {
            ready = true;
            break;
          }
        } catch {}
        await pause(100);
      }
      if (!ready)
        throw Error("预览启动未完成，请查看私有日志；不会重启正式服务。");
    }
    const target = state.instances[0],
      source = "合成预览材料：预览客户与评估项目，仅为界面测试，不是真实客户。";
    const m = await call(target, "crm_ingest", {
      text: source,
      filename: "synthetic-preview.txt",
      source: "隔离 UI 预览合成资料",
    });
    const ev = [
      { materialId: m.materialId, quote: source, locator: { kind: "text" } },
    ];
    const p = await call(target, "crm_propose", {
      idempotencyKey: "ui-preview-contexts",
      materialIds: [m.materialId],
      operations: [
        {
          op: "create_entity",
          ref: "customer",
          type: "customer",
          name: "合成客户·预览专用",
          evidence: ev,
        },
        {
          op: "create_entity",
          ref: "project",
          type: "project",
          name: "合成评估项目·预览专用",
          evidence: ev,
        },
        {
          op: "add_relation",
          fromId: "$customer",
          toId: "$project",
          kind: "has_project",
          evidence: ev,
        },
      ],
    });
    await call(target, "crm_commit", { proposalId: p.proposal.id });
    console.log(
      JSON.stringify({
        syntheticOnly: true,
        instances: state.instances.map(({ url, enabled, ui, pid }) => ({
          url: previewEntry({ url, ui }),
          enabled,
          pid,
        })),
        loginCommand: "node ops/product-preview.mjs login",
        stopCommand: "node ops/product-preview.mjs stop",
      }),
    );
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (command === "start") await start();
    else {
      const state = await load();
      if (command === "status")
        console.log(
          JSON.stringify({
            syntheticOnly: true,
            instances: await Promise.all(
              state.instances.map(async (item) => ({
                url: previewEntry(item),
                enabled: item.enabled,
                running: await running(item),
              })),
            ),
          }),
        );
      else if (command === "login") {
        const item =
          state.instances[process.argv.includes("--disabled") ? 1 : 0];
        if (!(await running(item))) throw Error("预览已停止。");
        const cfg = await configFor(item);
        const result = await api(
          { url: item.url, token: cfg.ownerToken },
          "/api/login-link",
          {},
        );
        console.log(
          JSON.stringify({
            ...result,
            url: result.url.replace("/#login=", "/products#login="),
          }),
        );
      } else if (command === "stop") {
        for (const item of state.instances) {
          if (await running(item)) process.kill(item.pid, "SIGTERM");
        }
        console.log(
          JSON.stringify({
            stoppedPreviewOnly: true,
            syntheticDataRetained: true,
          }),
        );
      } else
        throw Error(
          "用法：node ops/product-preview.mjs start | status | login [--disabled] | stop",
        );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        error: err.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database]"),
      }),
    );
    process.exitCode = 1;
  }
}
