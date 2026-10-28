import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { request as rawHttpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { projectRoot } from "../src/config.mjs";

const enabled = !!process.env.CRM_HTTP_TEST_CONFIG;
let cfg, server, base, materialId, entityId;
const children = [];
async function request(
  route,
  {
    role = "writer",
    body,
    method = body === undefined ? "GET" : "POST",
    headers = {},
  } = {},
) {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(role ? { Authorization: `Bearer ${cfg[role + "Token"]}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}
const tool = (name, args = {}, role = "writer") =>
  request("/api/v1/tools/" + name, { body: args, role });
before(async () => {
  if (!enabled) return;
  cfg = JSON.parse(await readFile(process.env.CRM_HTTP_TEST_CONFIG, "utf8"));
  assert.match(new URL(cfg.databaseUrl).pathname, /test_/);
  base = `http://127.0.0.1:${cfg.port}`;
  server = spawn(process.execPath, ["src/server.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, CRM_CONFIG: process.env.CRM_HTTP_TEST_CONFIG },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (b) => {
    output += b;
  });
  server.stderr.on("data", (b) => {
    output += b;
  });
  for (let n = 0; n < 80; n++) {
    if (server.exitCode !== null)
      throw new Error("Test server failed: " + output.slice(-1500));
    try {
      if ((await fetch(base + "/healthz")).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not become healthy");
});
after(async () => {
  for (const c of children) await c.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
});

test(
  "HTTP rejects unauthenticated, hostile origin/Host and read-only writes without mutation",
  { skip: !enabled },
  async () => {
    assert.equal((await request("/api/v1/tools", { role: null })).status, 401);
    assert.equal(
      (
        await request("/api/v1/tools", {
          headers: { Origin: "https://untrusted.invalid" },
        })
      ).status,
      403,
    );
    const invalidHost = await new Promise((resolve, reject) => {
      const req = rawHttpRequest(
        base + "/api/v1/tools",
        {
          headers: {
            Host: "untrusted.invalid",
            Authorization: `Bearer ${cfg.writerToken}`,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(invalidHost, 403);
    const beforeCount = (await tool("crm_materials")).data.total;
    const denied = await tool(
      "crm_ingest",
      { text: "MUST NOT BE WRITTEN" },
      "reader",
    );
    assert.equal(denied.status, 403);
    assert.equal((await tool("crm_materials")).data.total, beforeCount);
    const reader = (await request("/api/v1/tools", { role: "reader" })).data
      .tools;
    assert.ok(reader.every((t) => t.readOnly));
    assert.ok(!reader.some((t) => t.name === "crm_reassign"));
  },
);
test(
  "HTTP stores original byte upload and returns identical download with authenticated access",
  { skip: !enabled },
  async () => {
    const bytes = Buffer.from(
      "合成材料：蓝海客户称年度预测1000台；未核验。",
      "utf8",
    );
    const res = await fetch(base + "/api/v1/upload?filename=synthetic.txt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.writerToken}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: bytes,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    materialId = body.material.id;
    const duplicate = await tool("crm_ingest", {
      base64: bytes.toString("base64"),
      filename: "again.txt",
      mimeType: "text/plain",
    });
    assert.equal(duplicate.data.material.id, materialId);
    const download = await fetch(
      base + `/api/v1/materials/${materialId}/content`,
      { headers: { Authorization: `Bearer ${cfg.readerToken}` } },
    );
    assert.equal(download.status, 200);
    assert.match(download.headers.get("Content-Disposition"), /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal(
      body.material.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(
      (await fetch(base + `/api/v1/materials/${materialId}/content`)).status,
      401,
    );
  },
);
test(
  "HTTP proposed writes retain evidence; scope JSON export explicitly excludes originals",
  { skip: !enabled },
  async () => {
    const m = (await tool("crm_material", { materialId, includeContent: true }))
      .data;
    const p = (
      await tool("crm_propose", {
        idempotencyKey: randomUUID(),
        materialIds: [materialId],
        operations: [
          {
            op: "create_entity",
            ref: "customer",
            type: "customer",
            name: "蓝海测试客户",
            evidence: [
              { materialId, quote: m.content.text, locator: { kind: "text" } },
            ],
          },
          {
            op: "set_fact",
            entityId: "$customer",
            key: "annualForecast",
            value: 1000,
            classification: "customer_claim",
            evidence: [
              { materialId, quote: m.content.text, locator: { kind: "text" } },
            ],
          },
        ],
      })
    ).data;
    const committed = await tool("crm_commit", { proposalId: p.proposal.id });
    assert.equal(committed.data.status, "committed");
    entityId = committed.data.result.refs.customer;
    const d = (await tool("crm_customer", { entityId }, "reader")).data;
    assert.equal(d.facts[0].classification, "customer_claim");
    assert.equal(d.facts[0].evidence[0].materialId, materialId);
    const exported = await request("/api/v1/export", {
      role: "owner",
      body: {},
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.data.scope.originalsIncluded, false);
    assert.ok(exported.data.tables.entities.some((e) => e.id === entityId));
    assert.equal(
      (await request("/api/v1/export", { role: "reader", body: {} })).status,
      403,
    );
  },
);
test(
  "one-use console login expires after exchange and reader login retains reader scope",
  { skip: !enabled },
  async () => {
    const link = await request("/api/login-link", { role: "owner", body: {} });
    assert.equal(link.status, 200);
    const nonce = new URLSearchParams(new URL(link.data.url).hash.slice(1)).get(
      "login",
    );
    const first = await request("/api/session", {
      role: null,
      body: { login: nonce },
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.role, "owner");
    assert.match(first.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.equal(
      (await request("/api/session", { role: null, body: { login: nonce } }))
        .status,
      401,
    );
    const reader = await request("/api/session", {
      role: null,
      body: { token: cfg.readerToken },
    });
    assert.equal(reader.data.role, "reader");
  },
);
test(
  "official MCP stdio reads persistent customer with only reader tools and enforces denied writes",
  { skip: !enabled },
  async () => {
    const filename = path.join(
      path.dirname(process.env.CRM_HTTP_TEST_CONFIG),
      "reader-client.json",
    );
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        url: base,
        role: "reader",
        token: cfg.readerToken,
      }),
      { mode: 0o600 },
    );
    const client = new Client({
      name: "portable-crm-acceptance",
      version: "1.0.0",
    });
    children.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(projectRoot, "src/mcp.mjs")],
        env: { ...process.env, CRM_CLIENT_CONFIG: filename },
      }),
    );
    const listed = await client.listTools();
    assert.ok(listed.tools.some((t) => t.name === "crm_customer"));
    assert.ok(!listed.tools.some((t) => t.name === "crm_ingest"));
    const result = await client.callTool({
      name: "crm_customer",
      arguments: { entityId },
    });
    assert.equal(result.isError, undefined);
    const d = JSON.parse(result.content.find((c) => c.type === "text").text);
    assert.equal(d.entity.name, "蓝海测试客户");
    assert.equal(d.facts[0].classification, "customer_claim");
    let denied = false;
    try {
      const r = await client.callTool({
        name: "crm_ingest",
        arguments: { text: "must not write" },
      });
      denied = !!r.isError;
    } catch {
      denied = true;
    }
    assert.ok(denied);
  },
);
