import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createProjection } from "../src/twenty-projection.mjs";

test(
  "Twenty真实JSONB键序不误报，确认更名可同步，真正外部修改仍禁止覆盖",
  { skip: !process.env.CRM_HTTP_TEST_CONFIG },
  async () => {
    const cfg = JSON.parse(
      await readFile(process.env.CRM_HTTP_TEST_CONFIG, "utf8"),
    );
    assert.match(new URL(cfg.databaseUrl).pathname, /test_/);
    const customer = {
      id: randomUUID(),
      type: "customer",
      name: "合成投影客户",
    };
    const person = { id: randomUUID(), type: "contact", name: "合成联系人" };
    const records = new Map();
    let creates = 0,
      updates = 0;
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { query, variables: v } = JSON.parse(
        Buffer.concat(chunks).toString(),
      );
      let data;
      if (query.startsWith("query")) {
        const kind = query.includes("people(") ? "people" : "companies";
        const record = records.get(v.filter.id.eq);
        const node = record && {
          ...record,
          ...(record.name && typeof record.name === "object"
            ? {
                name: {
                  firstName: record.name.firstName,
                  lastName: record.name.lastName,
                },
              }
            : {}),
        };
        data = { [kind]: { edges: node ? [{ node }] : [] } };
      } else if (query.includes("create")) {
        creates++;
        records.set(v.data.id, structuredClone(v.data));
        data = {
          [query.includes("createPerson") ? "createPerson" : "createCompany"]: {
            id: v.data.id,
          },
        };
      } else {
        updates++;
        records.set(v.id, { ...records.get(v.id), ...structuredClone(v.data) });
        data = {
          [query.includes("updatePerson") ? "updatePerson" : "updateCompany"]: {
            id: v.id,
          },
        };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const domain = {
      exportData: async () => ({
        tables: {
          entities: [customer, person],
          relations: [{ from_id: customer.id, to_id: person.id }],
        },
      }),
    };
    const projection = createProjection(
      {
        databaseUrl: cfg.databaseUrl,
        twenty: {
          url: `http://127.0.0.1:${server.address().port}`,
          apiKey: "synthetic-projection-token",
        },
      },
      domain,
    );
    try {
      assert.equal((await projection.sync()).status, "ok");
      assert.equal(creates, 2);
      assert.equal((await projection.sync()).status, "ok");
      assert.equal(updates, 0, "JSONB键序不同不得产生无意义更新");
      customer.name = "合成投影客户全称有限公司";
      assert.equal((await projection.sync()).status, "ok");
      assert.equal(records.get(customer.id).name, customer.name);
      assert.equal(updates, 1);
      records.get(customer.id).name = "外部保留的真实更名";
      const blocked = await projection.sync();
      assert.equal(blocked.status, "partial");
      assert.ok(blocked.errors.some((e) => e.entityId === customer.id));
      assert.equal(records.get(customer.id).name, "外部保留的真实更名");
      assert.equal(updates, 1, "不得覆盖真正的外部修改");
      records.get(person.id).name.lastName = "外部改姓";
      const nested = await projection.sync();
      assert.ok(nested.errors.some((e) => e.entityId === person.id));
      assert.equal(records.get(person.id).name.lastName, "外部改姓");
      assert.equal(updates, 1);
    } finally {
      projection.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
