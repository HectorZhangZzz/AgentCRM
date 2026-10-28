import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { createDomain } from "../src/domain.mjs";
const url = process.env.CRM_TEST_DATABASE_URL;
const owner = { role: "owner", actor: "synthetic-test-owner" },
  writer = { role: "writer", actor: "synthetic-test-writer" },
  reader = { role: "reader", actor: "synthetic-test-reader" };
test(
  "真实PostgreSQL领域闭环、并发幂等、证据、纠错、重启和原件校验",
  { skip: !url },
  async (t) => {
    const pool = new pg.Pool({ connectionString: url });
    const dbname = (await pool.query("SELECT current_database() db")).rows[0]
      .db;
    assert.match(
      dbname,
      /(test|probe)/i,
      "只允许明确命名test/probe的独立库运行领域测试",
    );
    const existed = (
      await pool.query("SELECT to_regclass('portable_crm.materials') name")
    ).rows[0].name;
    if (existed)
      assert.equal(
        Number(
          (await pool.query("SELECT count(*) n FROM portable_crm.materials"))
            .rows[0].n,
        ),
        0,
        "拒绝在已有材料的库运行测试",
      );
    const dataDir =
      process.env.CRM_TEST_DATA_DIR ||
      (await mkdtemp(path.join(tmpdir(), "crm-domain-test-")));
    const keepData = process.env.CRM_TEST_KEEP_DATA === "1";
    let domain = await createDomain({ databaseUrl: url, dataDir });
    const call = (name, args, ctx = owner) => domain.call(name, args, ctx);
    const evidence = (materialId, quote) => [
      { materialId, quote, locator: { kind: "text" } },
    ];
    let m1, m2, m3, c1, c2, c3, project, task, fact, correctedFact;
    const propose = async (key, materialIds, operations) => {
      const r = await call("crm_propose", {
        idempotencyKey: key,
        materialIds,
        operations,
      });
      return r.proposal.id;
    };
    try {
      await t.test("权限与原字节去重；未知时间保留未知", async () => {
        await assert.rejects(
          call("crm_ingest", { text: "forbidden" }, reader),
          (e) => e.code === "FORBIDDEN",
        );
        const input = {
          text: "合成测试：极光采购样品2台，集光为另一家公司。请周五回复报价。",
          filename: "synthetic.txt",
          source: "合成聊天",
        };
        const results = await Promise.all(
          Array.from({ length: 6 }, () => call("crm_ingest", input)),
        );
        assert.equal(new Set(results.map((r) => r.materialId)).size, 1);
        assert.equal(results.filter((r) => !r.duplicate).length, 1);
        m1 = results[0].materialId;
        assert.equal(results[0].material.occurredAt, null);
        const source = await call("crm_material", {
          materialId: m1,
          includeContent: true,
        });
        assert.equal(source.content.text, input.text);
        assert.equal(source.receipts.length, 6);
        assert.equal(
          source.material.sha256,
          createHash("sha256").update(input.text).digest("hex"),
        );
        m2 = (
          await call("crm_ingest", {
            text: "极光改为样品3台；旧报价撤销，拜访改到2026-11-01。",
            occurredAt: "2026-10-28T09:00:00+08:00",
          })
        ).materialId;
      });
      await t.test(
        "真实事务创建客户/同音客户/项目、关系、事实和待办",
        async () => {
          const ev = evidence(m1, "极光采购样品2台");
          const pid = await propose(
            "initial",
            [m1],
            [
              {
                op: "create_entity",
                ref: "a",
                type: "customer",
                name: "极光",
                evidence: ev,
              },
              {
                op: "create_entity",
                ref: "b",
                type: "customer",
                name: "集光",
                evidence: evidence(m1, "集光为另一家公司"),
              },
              {
                op: "create_entity",
                ref: "c",
                type: "customer",
                name: "纠错目标",
                evidence: evidence(m1, "合成测试"),
              },
              {
                op: "create_entity",
                ref: "p",
                type: "project",
                name: "样品评估项目",
                evidence: ev,
              },
              {
                op: "add_relation",
                fromId: "$a",
                toId: "$p",
                kind: "customer_project",
                evidence: ev,
              },
              {
                op: "set_fact",
                entityId: "$a",
                key: "sample_quantity",
                value: 2,
                classification: "customer_claim",
                evidence: ev,
              },
              {
                op: "upsert_task",
                taskKey: "quote-follow-up",
                entityId: "$a",
                title: "回复报价",
                party: "self",
                status: "todo",
                evidence: evidence(m1, "请周五回复报价"),
              },
            ],
          );
          const results = await Promise.all([
            call("crm_commit", { proposalId: pid }),
            call("crm_commit", { proposalId: pid }),
          ]);
          assert.equal(results.filter((r) => !r.duplicate).length, 1);
          const r = results[0].result;
          c1 = r.refs.a;
          c2 = r.refs.b;
          c3 = r.refs.c;
          project = r.refs.p;
          task = r.operations.find((o) => o.op === "upsert_task").taskId;
          fact = r.operations.find((o) => o.op === "set_fact").factId;
          assert.equal(
            (await call("crm_entities", { type: "customer" })).total,
            3,
          );
          assert.notEqual(c1, c2);
          const single = await call("crm_entities", { query: "极光" });
          assert.equal(single.items.length, 1);
          assert.equal(single.items[0].id, c1);
          const customer = await call("crm_customer", { entityId: c1 });
          assert.equal(customer.projects[0].id, project);
          assert.equal(customer.facts[0].value, 2);
          assert.equal(customer.facts[0].classification, "customer_claim");
          const eid = customer.facts[0].evidence[0].id;
          const proof = await call("crm_evidence", { evidenceId: eid });
          assert.equal(proof.evidence.quote, "极光采购样品2台");
          assert.equal(proof.material.id, m1);
        },
      );
      await t.test(
        "相同幂等键不同内容拒绝，非法引文使整个提交回滚",
        async () => {
          const taskDup = await propose(
            "new-key-same-task",
            [m1],
            [
              {
                op: "upsert_task",
                taskKey: "changed-key-duplicate",
                entityId: c1,
                title: "回复报价",
                party: "self",
                status: "todo",
                evidence: evidence(m1, "请周五回复报价"),
              },
            ],
          );
          await assert.rejects(
            call("crm_commit", { proposalId: taskDup }),
            (e) => e.code === "TASK_CANDIDATE",
          );
          assert.equal((await call("crm_tasks", {})).total, 1);
          const dup = await propose(
            "new-key-same-evidence",
            [m1],
            [
              {
                op: "create_entity",
                ref: "dup",
                type: "customer",
                name: "极光",
                evidence: evidence(m1, "极光采购样品2台"),
              },
            ],
          );
          await assert.rejects(
            call("crm_commit", { proposalId: dup }),
            (e) => e.code === "ENTITY_CANDIDATE",
          );
          assert.equal(
            (await call("crm_entities", { query: "极光" })).total,
            1,
          );
          await assert.rejects(
            call("crm_propose", {
              idempotencyKey: "initial",
              materialIds: [m1],
              operations: [{ op: "noop" }],
            }),
            (e) => e.code === "IDEMPOTENCY_MISMATCH",
          );
          const pid = await propose(
            "bad-evidence",
            [m1],
            [
              {
                op: "create_entity",
                ref: "x",
                type: "customer",
                name: "不应残留",
                evidence: evidence(m1, "原文里不存在的句子"),
              },
            ],
          );
          await assert.rejects(
            call("crm_commit", { proposalId: pid }),
            (e) => e.code === "QUOTE_MISMATCH",
          );
          assert.equal(
            (await call("crm_entities", { query: "不应残留" })).total,
            0,
          );
        },
      );
      await t.test("新旧冲突不覆盖，来源/版本可追溯；解决仅owner", async () => {
        const pid = await propose(
          "quantity-conflict",
          [m2],
          [
            {
              op: "set_fact",
              entityId: c1,
              key: "sample_quantity",
              value: 3,
              classification: "customer_claim",
              expectedVersion: 1,
              evidence: evidence(m2, "极光改为样品3台"),
            },
          ],
        );
        const conflict = await call("crm_commit", { proposalId: pid });
        assert.equal(conflict.status, "conflict");
        assert.equal(conflict.conflicts[0].current.value, 2);
        assert.equal(conflict.conflicts[0].proposed.value, 3);
        assert.equal(
          (await call("crm_customer", { entityId: c1 })).facts[0].value,
          2,
        );
        await assert.rejects(
          call(
            "crm_commit",
            { proposalId: pid, resolveConflicts: true },
            writer,
          ),
          (e) => e.code === "FORBIDDEN",
        );
        const resolved = await call("crm_commit", {
          proposalId: pid,
          resolveConflicts: true,
        });
        assert.equal(resolved.status, "committed");
        const current = (await call("crm_customer", { entityId: c1 })).facts[0];
        assert.equal(current.value, 3);
        assert.equal(current.history.length, 2);
        assert.equal(current.history[0].value, 2);
        assert.equal(current.evidence[0].materialId, m2);
        const stale = await propose(
          "stale-fact",
          [m2],
          [
            {
              op: "set_fact",
              entityId: c1,
              key: "sample_quantity",
              value: 3,
              classification: "customer_claim",
              expectedVersion: 1,
              evidence: evidence(m2, "样品3台"),
            },
          ],
        );
        await assert.rejects(
          call("crm_commit", { proposalId: stale }),
          (e) => e.code === "STALE_VERSION",
        );
      });
      await t.test("待办更新要有依据；改期历史和六状态/默认过滤", async () => {
        await assert.rejects(
          call("crm_task_update", {
            taskId: task,
            expectedVersion: 1,
            status: "completed",
            evidence: [],
            idempotencyKey: "missing-evidence",
          }),
          (e) => e.code === "EVIDENCE_REQUIRED",
        );
        assert.equal((await call("crm_tasks", {})).items[0].version, 1);
        const a = {
          taskId: task,
          expectedVersion: 1,
          dueAt: "2026-11-01T09:00:00+08:00",
          status: "awaiting_feedback",
          evidence: evidence(m2, "拜访改到2026-11-01"),
          idempotencyKey: "reschedule",
        };
        const rr = await Promise.all([
          call("crm_task_update", a),
          call("crm_task_update", a),
        ]);
        assert.equal(rr[0].task.version, 2);
        assert.equal(rr[1].task.version, 2);
        await assert.rejects(
          call("crm_task_update", { ...a, idempotencyKey: "stale-task" }),
          (e) => e.code === "STALE_VERSION",
        );
        const done = await call("crm_task_update", {
          taskId: task,
          expectedVersion: 2,
          status: "completed",
          evidence: evidence(m2, "旧报价撤销"),
          idempotencyKey: "complete",
        });
        assert.equal(done.task.status, "completed");
        assert.equal((await call("crm_tasks", {})).items.length, 0);
        assert.equal(
          (await call("crm_tasks", { includeCompleted: true })).items.length,
          1,
        );
        const cp = await propose(
          "cancel-task",
          [m2],
          [
            {
              op: "upsert_task",
              taskKey: "cancelled-follow-up",
              entityId: c1,
              title: "撤销报价",
              party: "self",
              status: "cancelled",
              evidence: evidence(m2, "旧报价撤销"),
            },
          ],
        );
        await call("crm_commit", { proposalId: cp });
        assert.equal((await call("crm_tasks", {})).total, 0);
        assert.equal(
          (await call("crm_tasks", { status: "cancelled" })).total,
          1,
        );
      });
      await t.test("人工归属纠正保留ID，后续检索采用新归属", async () => {
        m3 = (
          await call("crm_ingest", {
            text: "合成误归属材料：纠错目标正在评估AI Box样品。",
          })
        ).materialId;
        const pid = await propose(
          "wrong-attribution",
          [m3],
          [
            {
              op: "set_fact",
              entityId: c1,
              key: "attribution_probe",
              value: "AI Box样品评估",
              classification: "customer_claim",
              evidence: evidence(m3, "纠错目标正在评估AI Box样品"),
            },
            {
              op: "upsert_task",
              taskKey: "wrong-attributed-task",
              entityId: c1,
              title: "确认AI Box样品",
              party: "self",
              evidence: evidence(m3, "评估AI Box样品"),
            },
          ],
        );
        const committed = await call("crm_commit", { proposalId: pid });
        correctedFact = committed.result.operations.find(
          (o) => o.op === "set_fact",
        ).factId;
        const result = await call("crm_reassign", {
          materialId: m3,
          fromEntityId: c1,
          toEntityId: c3,
          reason: "合成测试人工纠错",
          idempotencyKey: "fix-attribution",
          expectedVersion: 1,
        });
        assert.equal(
          result.moved.some((x) => x.id === correctedFact),
          true,
        );
        assert.equal(result.pending.length, 0);
        assert.equal(
          (await call("crm_customer", { entityId: c1 })).facts.some(
            (f) => f.id === correctedFact,
          ),
          false,
        );
        const corrected = await call("crm_customer", { entityId: c3 });
        assert.equal(corrected.facts[0].id, correctedFact);
        assert.equal(corrected.facts[0].value, "AI Box样品评估");
        assert.equal(corrected.facts[0].history.length, 2);
        await assert.rejects(
          call(
            "crm_reassign",
            {
              materialId: m1,
              fromEntityId: c1,
              toEntityId: c3,
              reason: "x",
              idempotencyKey: "writer-cannot",
            },
            writer,
          ),
          (e) => e.code === "FORBIDDEN",
        );
      });
      await t.test("多源材料不会被纠错粗暴整体搬迁", async () => {
        const pid = await propose(
          "multi-source",
          [m1, m2],
          [
            {
              op: "set_fact",
              entityId: c1,
              key: "ambiguous",
              value: "待确认",
              classification: "inference",
              evidence: [
                ...evidence(m1, "合成测试"),
                ...evidence(m2, "旧报价撤销"),
              ],
            },
          ],
        );
        await call("crm_commit", { proposalId: pid });
        const res = await call("crm_reassign", {
          materialId: m1,
          fromEntityId: c1,
          toEntityId: c3,
          reason: "多源测试",
          idempotencyKey: "multi-correct",
        });
        assert.equal(
          res.pending.some((p) => p.reason === "multiple_source_materials"),
          true,
        );
        assert.equal(res.originalLinkRetained, true);
        assert.equal(
          (await call("crm_customer", { entityId: c1 })).facts.some(
            (f) => f.key === "ambiguous",
          ),
          true,
        );
      });
      await t.test("二进制未假装OCR；原件损坏明确失败", async () => {
        const textBytes = Buffer.from("UTF8原文逐字保留\n下一行");
        const textFile = await call("crm_ingest", {
          base64: textBytes.toString("base64"),
          filename: "plain.txt",
          mimeType: "text/plain;charset=utf-8",
        });
        assert.equal(textFile.material.extractionStatus, "text_received");
        assert.equal(
          (
            await call("crm_material", {
              materialId: textFile.materialId,
              includeContent: true,
            })
          ).content.text,
          textBytes.toString("utf8"),
        );
        const invalid = await call("crm_ingest", {
          base64: Buffer.from([0xff, 0xfe, 0x41]).toString("base64"),
          filename: "unknown.txt",
          mimeType: "text/plain",
        });
        assert.equal(invalid.material.extractionStatus, "unprocessed_binary");
        assert.ok(
          invalid.material.qualityFlags.includes("text_encoding_unknown"),
        );
        const bytes = Buffer.from("synthetic binary no OCR");
        const m = await call("crm_ingest", {
          base64: bytes.toString("base64"),
          filename: "scan.png",
          mimeType: "image/png",
        });
        assert.equal(m.material.extractionStatus, "unprocessed_binary");
        const got = await call("crm_material", {
          materialId: m.materialId,
          includeContent: true,
        });
        assert.equal(got.content.unverified, true);
        const p = await propose(
          "unverified-binary",
          [m.materialId],
          [
            {
              op: "set_fact",
              entityId: c3,
              key: "bad_verified",
              value: 1000,
              classification: "verified",
              evidence: [
                {
                  materialId: m.materialId,
                  quote: "宿主说1000台",
                  locator: { kind: "image" },
                },
              ],
            },
          ],
        );
        await assert.rejects(
          call("crm_commit", { proposalId: p }),
          (e) => e.code === "UNVERIFIED_BINARY",
        );
        await writeFile(path.join(dataDir, m.material.objectPath), "corrupted");
        await assert.rejects(
          call("crm_material", {
            materialId: m.materialId,
            includeContent: true,
          }),
          (e) => e.code === "STORAGE_CORRUPT",
        );
        await writeFile(path.join(dataDir, m.material.objectPath), bytes);
      });
      await t.test(
        "省略expectedVersion的旧冲突也不能覆盖新事实，首次差异不可绕过",
        async () => {
          const base = await propose(
            "review-baseline",
            [m1],
            [
              {
                op: "set_fact",
                entityId: c1,
                key: "zz_review_guard",
                value: 1,
                classification: "customer_claim",
                evidence: evidence(m1, "合成测试"),
              },
            ],
          );
          await call("crm_commit", { proposalId: base });
          const pending = await propose(
            "review-pending",
            [m2],
            [
              {
                op: "set_fact",
                entityId: c1,
                key: "zz_review_guard",
                value: 2,
                classification: "customer_claim",
                evidence: evidence(m2, "样品3台"),
              },
            ],
          );
          await assert.rejects(
            call("crm_commit", { proposalId: pending, resolveConflicts: true }),
            (error) => error.code === "CONFLICT_REVIEW_REQUIRED",
          );
          const firstReview = await call("crm_commit", { proposalId: pending });
          assert.equal(firstReview.status, "conflict");
          assert.equal(firstReview.conflicts[0].current.version, 1);
          const intervening = await propose(
            "review-intervening",
            [m2],
            [
              {
                op: "set_fact",
                entityId: c1,
                key: "zz_review_guard",
                value: 3,
                classification: "customer_claim",
                evidence: evidence(m2, "样品3台"),
              },
            ],
          );
          assert.equal(
            (await call("crm_commit", { proposalId: intervening })).status,
            "conflict",
          );
          await call("crm_commit", {
            proposalId: intervening,
            resolveConflicts: true,
          });
          await assert.rejects(
            call("crm_commit", { proposalId: pending, resolveConflicts: true }),
            (error) => error.code === "STALE_VERSION",
          );
          const unchanged = (
            await call("crm_customer", { entityId: c1 })
          ).facts.find((f) => f.key === "zz_review_guard");
          assert.equal(unchanged.value, 3);
          assert.equal(unchanged.version, 2);
          const secondReview = await call("crm_commit", {
            proposalId: pending,
          });
          assert.equal(secondReview.conflicts[0].current.version, 2);
          assert.equal(secondReview.conflicts[0].current.value, 3);
          await call("crm_commit", {
            proposalId: pending,
            resolveConflicts: true,
          });
          assert.equal(
            (await call("crm_customer", { entityId: c1 })).facts.find(
              (f) => f.key === "zz_review_guard",
            ).value,
            2,
          );
        },
      );
      await t.test(
        "实体身份来源纠错保留待处理；coverage覆盖所有已返回证据",
        async () => {
          const original = (
            await call("crm_ingest", { text: "合成实体身份证据：甲客户" })
          ).materialId;
          const target = (
            await call("crm_ingest", { text: "合成实体身份证据：乙客户" })
          ).materialId;
          const p = await propose(
            "identity-evidence",
            [original, target],
            [
              {
                op: "create_entity",
                ref: "a",
                type: "customer",
                name: "身份甲客户",
                evidence: evidence(original, "甲客户"),
              },
              {
                op: "create_entity",
                ref: "b",
                type: "customer",
                name: "身份乙客户",
                evidence: evidence(target, "乙客户"),
              },
            ],
          );
          const committed = await call("crm_commit", { proposalId: p });
          const a = committed.result.refs.a,
            b = committed.result.refs.b;
          const corrected = await call("crm_reassign", {
            materialId: original,
            fromEntityId: a,
            toEntityId: b,
            reason: "实体身份来源需人工复核",
            idempotencyKey: "identity-reassign",
          });
          assert.equal(corrected.originalLinkRetained, true);
          assert.ok(
            corrected.pending.some(
              (item) =>
                item.type === "entity" &&
                item.reason === "entity_identity_evidence_requires_review",
            ),
          );
          const snapshot = await call("crm_customer", { entityId: a });
          assert.ok(
            snapshot.entity.evidence.some(
              (item) => item.materialId === original,
            ),
          );
          assert.ok(snapshot.materials.some((item) => item.id === original));
          assert.ok(snapshot.coverage.materialIds.includes(original));
          // Simulate a legacy broken association to prove read coverage follows actual evidence too.
          await pool.query(
            "DELETE FROM portable_crm.material_entities WHERE entity_id=$1 AND material_id=$2",
            [a, original],
          );
          try {
            const legacy = await call("crm_customer", { entityId: a });
            assert.ok(legacy.coverage.materialIds.includes(original));
            assert.ok(legacy.materials.some((item) => item.id === original));
          } finally {
            await pool.query(
              "INSERT INTO portable_crm.material_entities(entity_id,material_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
              [a, original],
            );
          }
        },
      );
      await t.test("迁移未知高版本及checksum变化拒绝启动", async () => {
        await pool.query(
          "INSERT INTO portable_crm.migrations(version,checksum) VALUES('999_future.sql','synthetic')",
        );
        try {
          await assert.rejects(
            createDomain({ databaseUrl: url, dataDir }),
            (e) => e.code === "UNKNOWN_MIGRATION",
          );
        } finally {
          await pool.query(
            "DELETE FROM portable_crm.migrations WHERE version='999_future.sql'",
          );
        }
        const current = (
          await pool.query("SELECT * FROM portable_crm.migrations LIMIT 1")
        ).rows[0];
        await pool.query(
          "UPDATE portable_crm.migrations SET checksum=$2 WHERE version=$1",
          [current.version, "tampered"],
        );
        try {
          await assert.rejects(
            createDomain({ databaseUrl: url, dataDir }),
            (e) => e.code === "MIGRATION_CHANGED",
          );
        } finally {
          await pool.query(
            "UPDATE portable_crm.migrations SET checksum=$2 WHERE version=$1",
            [current.version, current.checksum],
          );
        }
      });
      await t.test(
        "不同key并发重复实体/待办只成功一次；客户/项目scope不误合并",
        async () => {
          const makeEntity = async (key) =>
            propose(
              key,
              [m1],
              [
                {
                  op: "create_entity",
                  ref: "concurrent",
                  type: "customer",
                  name: "并发唯一合成客户",
                  evidence: evidence(m1, "合成测试"),
                },
              ],
            );
          const entityProposals = await Promise.all([
            makeEntity("entity-concurrent-a"),
            makeEntity("entity-concurrent-b"),
          ]);
          const entityResults = await Promise.allSettled(
            entityProposals.map((proposalId) =>
              call("crm_commit", { proposalId }),
            ),
          );
          assert.equal(
            entityResults.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            entityResults.filter(
              (r) =>
                r.status === "rejected" && r.reason.code === "ENTITY_CANDIDATE",
            ).length,
            1,
          );
          const makeTask = async (key, taskKey) =>
            propose(
              key,
              [m1],
              [
                {
                  op: "upsert_task",
                  taskKey,
                  entityId: c2,
                  title: "并发唯一合成待办",
                  party: "self",
                  evidence: evidence(m1, "请周五回复报价"),
                },
              ],
            );
          const taskProposals = await Promise.all([
            makeTask("task-concurrent-a", "task-key-a"),
            makeTask("task-concurrent-b", "task-key-b"),
          ]);
          const taskResults = await Promise.allSettled(
            taskProposals.map((proposalId) =>
              call("crm_commit", { proposalId }),
            ),
          );
          assert.equal(
            taskResults.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            taskResults.filter(
              (r) =>
                r.status === "rejected" && r.reason.code === "TASK_CANDIDATE",
            ).length,
            1,
          );
          const scopeProposal = await propose(
            "different-task-scope",
            [m1],
            [
              {
                op: "upsert_task",
                taskKey: "scope-customer-a",
                entityId: c1,
                title: "独立scope任务",
                party: "self",
                evidence: evidence(m1, "请周五回复报价"),
              },
              {
                op: "upsert_task",
                taskKey: "scope-customer-b",
                entityId: c2,
                title: "独立scope任务",
                party: "self",
                evidence: evidence(m1, "请周五回复报价"),
              },
              {
                op: "upsert_task",
                taskKey: "scope-project",
                entityId: c1,
                projectId: project,
                title: "独立scope任务",
                party: "self",
                evidence: evidence(m1, "请周五回复报价"),
              },
            ],
          );
          const scopes = await call("crm_commit", {
            proposalId: scopeProposal,
          });
          assert.equal(scopes.result.operations.length, 3);
          assert.equal(
            new Set(scopes.result.operations.map((o) => o.taskId)).size,
            3,
          );
        },
      );
      await t.test(
        "关闭重开保留所有记录、稳定ID和原件；导出包括历史/审计",
        async () => {
          const before = (
            await call("crm_material", { materialId: m1, includeContent: true })
          ).content.text;
          await domain.close();
          domain = await createDomain({ databaseUrl: url, dataDir });
          assert.equal(
            (
              await call("crm_material", {
                materialId: m1,
                includeContent: true,
              })
            ).content.text,
            before,
          );
          assert.equal(
            (await call("crm_customer", { entityId: c3 })).facts.some(
              (f) => f.id === correctedFact,
            ),
            true,
          );
          const exported = await domain.exportData();
          assert.equal(exported.format, "portable-crm-export");
          assert.ok(exported.tables.audit.length > 10);
          assert.ok(exported.tables.fact_versions.length >= 3);
          assert.ok(exported.tables.materials.length >= 3);
        },
      );
    } finally {
      await domain.close();
      if (!keepData) await pool.query("DROP SCHEMA portable_crm CASCADE");
      await pool.end();
      if (!keepData) await rm(dataDir, { recursive: true, force: true });
    }
  },
);
