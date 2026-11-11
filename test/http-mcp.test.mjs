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
    assert.ok(!reader.some((t) => t.name === "crm_entity_rename"));
    const writer = (await request("/api/v1/tools", { role: "writer" })).data
      .tools;
    assert.ok(!writer.some((t) => t.name === "crm_entity_rename"));
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
    assert(first.headers.get("set-cookie").startsWith("crm_session="));
    const consoleCookie = first.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await request("/api/session", {
          role: null,
          headers: { Cookie: "unrelated=x; " + consoleCookie },
        })
      ).data.role,
      "owner",
    );
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
test(
  "HTTP/MCP/CLI共用owner更名契约，writer不可更名",
  { skip: !enabled },
  async () => {
    const m = (
      await tool("crm_ingest", {
        text: "用户确认蓝海测试客户全称为合成蓝海科技有限公司",
      })
    ).data;
    const before = (await tool("crm_customer", { entityId })).data.entity;
    const args = {
      entityId,
      expectedVersion: before.version,
      name: "合成蓝海科技有限公司",
      reason: "合成用户确认",
      evidence: [
        {
          materialId: m.materialId,
          quote: "合成蓝海科技有限公司",
          locator: { kind: "text" },
        },
      ],
      idempotencyKey: "http-owner-name",
    };
    assert.equal((await tool("crm_entity_rename", args, "writer")).status, 403);
    const result = await tool("crm_entity_rename", args, "owner");
    assert.equal(result.status, 200);
    assert.equal(result.data.entity.id, entityId);
    assert.ok(result.data.entity.aliases.includes(before.name));
    const filename = path.join(
      path.dirname(process.env.CRM_HTTP_TEST_CONFIG),
      "owner-client.json",
    );
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        url: base,
        role: "owner",
        token: cfg.ownerToken,
      }),
      { mode: 0o600 },
    );
    const client = new Client({
      name: "synthetic-owner-name-test",
      version: "1",
    });
    children.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(projectRoot, "src/mcp.mjs")],
        env: { ...process.env, CRM_CLIENT_CONFIG: filename },
      }),
    );
    assert.ok(
      (await client.listTools()).tools.some(
        (t) => t.name === "crm_entity_rename",
      ),
    );
    const repeated = await client.callTool({
      name: "crm_entity_rename",
      arguments: args,
    });
    assert.equal(
      JSON.parse(repeated.content.find((c) => c.type === "text").text)
        .duplicate,
      true,
    );
    const child = spawn(
      process.execPath,
      ["src/cli.mjs", "call", "crm_entity_rename", JSON.stringify(args)],
      {
        cwd: projectRoot,
        env: { ...process.env, CRM_CLIENT_CONFIG: filename },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (errors += b));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors);
    assert.equal(JSON.parse(output).duplicate, true);
    assert.equal(
      (await tool("crm_customer", { entityId })).data.entity.name,
      args.name,
    );
  },
);

test(
  "product HTTP write and MCP/CLI read share discovered schemas and evidence",
  { skip: !enabled },
  async () => {
    const m = (
      await tool("crm_ingest", {
        text: "Synthetic adapter product/model/version; client requirement remains unverified.",
      })
    ).data;
    const evidence = [
      {
        materialId: m.materialId,
        quote: "Synthetic",
        locator: { kind: "text" },
      },
    ];
    const args = {
      idempotencyKey: "adapter-product-chain",
      materialIds: [m.materialId],
      operations: [
        ...[
          ["p", "product", "Adapter family"],
          ["m", "product_model", "ADAPTER-1"],
          ["v", "product_version", "adapter-r1"],
          ["j", "project", "Adapter test project"],
        ].map(([ref, type, name]) => ({
          op: "create_entity",
          ref,
          type,
          name,
          evidence,
        })),
        {
          op: "add_relation",
          fromId: "$p",
          toId: "$m",
          kind: "product_has_model",
          evidence,
        },
        {
          op: "add_relation",
          fromId: "$m",
          toId: "$v",
          kind: "model_has_version",
          evidence,
        },
        {
          op: "add_relation",
          fromId: "$j",
          toId: "$v",
          kind: "uses_product",
          evidence,
        },
        {
          op: "set_product_assertion",
          entityId: "$v",
          contextEntityId: "$j",
          key: "video",
          kind: "requirement",
          status: "requested",
          statement: "Unverified client requirement",
          evidence,
        },
      ],
    };
    const proposed = await tool("crm_propose", args);
    assert.equal(proposed.status, 200);
    const committed = await tool("crm_commit", {
      proposalId: proposed.data.proposal.id,
    });
    assert.equal(committed.status, 200);
    const id = committed.data.result.refs.v;
    const snapshot = (await tool("crm_product", { entityId: id }, "reader"))
      .data;
    assert.equal(snapshot.requirements.length, 1);
    assert.equal(snapshot.capabilities.length, 0);
    assert.equal(snapshot.requirements[0].evidence[0].materialId, m.materialId);
    const discovered = (await request("/api/v1/tools", { role: "reader" })).data
      .tools;
    assert(discovered.some((t) => t.name === "crm_product"));
    assert(
      discovered
        .find((t) => t.name === "crm_entities")
        .inputSchema.properties.type.enum.includes("product_version"),
    );
    assert.equal((await tool("crm_propose", args, "reader")).status, 403);
    const filename = path.join(
      path.dirname(process.env.CRM_HTTP_TEST_CONFIG),
      "product-reader.json",
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
      name: "synthetic-product-adapter",
      version: "1",
    });
    children.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(projectRoot, "src/mcp.mjs")],
        env: { ...process.env, CRM_CLIENT_CONFIG: filename },
      }),
    );
    assert(
      (await client.listTools()).tools.some((t) => t.name === "crm_product"),
    );
    const result = await client.callTool({
      name: "crm_product",
      arguments: { entityId: id },
    });
    assert.equal(result.isError, undefined);
    const viaMcp = JSON.parse(
      result.content.find((c) => c.type === "text").text,
    );
    assert.deepEqual(viaMcp.requirements, snapshot.requirements);
    const child = spawn(
      process.execPath,
      ["src/cli.mjs", "call", "crm_product", JSON.stringify({ entityId: id })],
      {
        cwd: projectRoot,
        env: { ...process.env, CRM_CLIENT_CONFIG: filename },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (errors += b));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output).requirements, snapshot.requirements);
  },
);

test(
  "isolated product page uses existing auth, CSP and dynamic wrapper without changing legacy assets",
  { skip: !enabled },
  async () => {
    const root = await fetch(base + "/");
    const html = await root.text();
    assert(html.includes('src="/workspace.js"'));
    assert.match(
      root.headers.get("Content-Security-Policy"),
      /script-src 'self'/,
    );
    for (const route of [
      "/products",
      "/products.js",
      "/products.css",
      "/product-workflow.mjs",
      "/workspace.js",
    ]) {
      const r = await fetch(base + route);
      assert.equal(r.status, 200, route);
      assert(!r.headers.get("Content-Type").includes("json"));
    }
    const status = (await request("/api/v1/status", { role: "reader" })).data;
    assert.equal(status.features.productLibrary, true);
    assert.equal(status.previewOnly, false);
    assert.equal(
      (await request("/api/login-link", { role: null, body: {} })).status,
      401,
    );
    assert.equal(
      (await request("/api/login-link", { role: "reader", body: {} })).status,
      403,
    );
    assert.equal(
      (await request("/api/login-link", { role: "writer", body: {} })).status,
      403,
    );
  },
);

test(
  "non-boolean UI gate is rejected before a server can listen",
  { skip: !enabled },
  async () => {
    const filename = path.join(
      path.dirname(process.env.CRM_HTTP_TEST_CONFIG),
      "invalid-ui-config.json",
    );
    await writeFile(
      filename,
      JSON.stringify({ ...cfg, port: 4399, productUiEnabled: "true" }),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, CRM_CONFIG: filename },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
    assert.match(output, /productUiEnabled须为显式布尔值/);
  },
);
