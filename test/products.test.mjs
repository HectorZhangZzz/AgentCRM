import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { createDomain } from "../src/domain.mjs";
const url = process.env.CRM_PRODUCT_TEST_DATABASE_URL;
const writer = { role: "writer", actor: "synthetic-product-writer" };
const reader = { role: "reader", actor: "synthetic-product-reader" };
const owner = { role: "owner", actor: "synthetic-product-owner" };
test(
  "product identities, evidence and assertions remain independent and recoverable",
  { skip: !url },
  async (t) => {
    assert.match(new URL(url).pathname, /product_test_/);
    const pool = new pg.Pool({ connectionString: url });
    const dataDir = process.env.CRM_PRODUCT_TEST_DATA_DIR;
    assert(dataDir);
    assert.equal(
      (await pool.query("SELECT to_regclass('portable_crm.entities') name"))
        .rows[0].name,
      null,
      "only a new test database is allowed",
    );
    await assert.rejects(
      createDomain({
        databaseUrl: url,
        dataDir,
        productLibraryEnabled: "true",
      }),
      (e) => e.code === "CONFIG",
    );
    const disabled = await createDomain({ databaseUrl: url, dataDir });
    assert.equal((await disabled.health()).features.productLibrary, false);
    assert(!disabled.tools.some((t) => t.name === "crm_product"));
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) n FROM portable_crm.migrations WHERE version='002_product_entities.sql'",
        )
      ).rows[0].n,
      "0",
    );
    const baseMaterial = await disabled.call(
      "crm_ingest",
      { text: "Synthetic pre-feature original" },
      writer,
    );
    const baseProposal = await disabled.call(
      "crm_propose",
      {
        idempotencyKey: "pre-feature-client",
        materialIds: [baseMaterial.materialId],
        operations: [
          {
            op: "create_entity",
            ref: "client",
            type: "customer",
            name: "Pre-feature client",
            evidence: [
              {
                materialId: baseMaterial.materialId,
                quote: "Synthetic",
                locator: { kind: "text" },
              },
            ],
          },
        ],
      },
      writer,
    );
    await disabled.call(
      "crm_commit",
      { proposalId: baseProposal.proposal.id },
      writer,
    );
    const beforeEnable = await disabled.exportData();
    const disabledProduct = await disabled.call(
      "crm_propose",
      {
        idempotencyKey: "disabled-product",
        materialIds: [baseMaterial.materialId],
        operations: [
          {
            op: "create_entity",
            ref: "product",
            type: "product",
            name: "Must not exist",
            evidence: [
              {
                materialId: baseMaterial.materialId,
                quote: "Synthetic",
                locator: { kind: "text" },
              },
            ],
          },
        ],
      },
      writer,
    );
    await assert.rejects(
      disabled.call(
        "crm_commit",
        { proposalId: disabledProduct.proposal.id },
        writer,
      ),
      (e) => e.code === "PRODUCT_LIBRARY_DISABLED",
    );
    await disabled.close();
    let domain = await createDomain({
      databaseUrl: url,
      dataDir,
      productLibraryEnabled: true,
    });
    const disabledAgain = await createDomain({ databaseUrl: url, dataDir });
    assert.equal((await disabledAgain.health()).migrations.length, 2);
    assert(!disabledAgain.tools.some((t) => t.name === "crm_product"));
    await assert.rejects(
      disabledAgain.call(
        "crm_product",
        { entityId: baseMaterial.materialId },
        reader,
      ),
      (e) => e.code === "UNKNOWN_TOOL",
    );
    await disabledAgain.close();
    const afterEnable = await domain.exportData();
    for (const table of [
      "entities",
      "materials",
      "facts",
      "relations",
      "evidence",
      "tasks",
      "fact_versions",
      "task_versions",
    ])
      assert.deepEqual(
        JSON.parse(JSON.stringify(afterEnable.tables[table])),
        JSON.parse(JSON.stringify(beforeEnable.tables[table])),
        table + " changed on migration",
      );
    const call = (n, a = {}, ctx = writer) => domain.call(n, a, ctx);
    let material, ids, scoped;
    const ev = (quote) => [
      { materialId: material, quote, locator: { kind: "text" } },
    ];
    const propose = async (key, operations, materialIds = [material]) =>
      call("crm_propose", { idempotencyKey: key, materialIds, operations });
    const commit = async (key, operations, ctx = writer) => {
      const p = await propose(key, operations);
      return call("crm_commit", { proposalId: p.proposal.id }, ctx);
    };
    const assertion = (kind, status, key = "video", extra = {}) => ({
      op: "set_product_assertion",
      entityId: ids.version,
      key,
      kind,
      status,
      statement: kind + " synthetic statement",
      evidence: ev("Synthetic evidence: validated under test configuration."),
      ...extra,
    });
    try {
      await t.test(
        "one original supports separate product/model/version and project identities",
        async () => {
          const m = await call("crm_ingest", {
            text: "Synthetic product family DemoKit, model DEMO-1, revision R1. Synthetic client needs video. Synthetic evidence: validated under test configuration.",
            filename: "synthetic-products.txt",
          });
          material = m.materialId;
          const ops = [
            ...[
              ["product", "product", "DemoKit"],
              ["model", "product_model", "DEMO-1"],
              ["version", "product_version", "R1"],
              ["customer", "customer", "Synthetic client"],
              ["project", "project", "Synthetic project"],
            ].map(([ref, type, name]) => ({
              op: "create_entity",
              ref,
              type,
              name,
              evidence: ev("Synthetic"),
            })),
            {
              op: "add_relation",
              fromId: "$product",
              toId: "$model",
              kind: "product_has_model",
              evidence: ev("DemoKit"),
            },
            {
              op: "add_relation",
              fromId: "$model",
              toId: "$version",
              kind: "model_has_version",
              evidence: ev("R1"),
            },
            {
              op: "add_relation",
              fromId: "$customer",
              toId: "$project",
              kind: "has_project",
              evidence: ev("Synthetic"),
            },
            {
              op: "add_relation",
              fromId: "$project",
              toId: "$version",
              kind: "uses_product",
              evidence: ev("video"),
            },
          ];
          const p = await propose("products:create", ops);
          const result = await call("crm_commit", {
            proposalId: p.proposal.id,
          });
          ids = result.result.refs;
          assert.equal(new Set(Object.values(ids)).size, 5);
          const duplicate = await call("crm_commit", {
            proposalId: p.proposal.id,
          });
          assert(duplicate.duplicate);
          assert((await propose("products:create", ops)).duplicate);
          assert(
            (
              await call("crm_ingest", {
                text:
                  m.material.textContent ??
                  "Synthetic product family DemoKit, model DEMO-1, revision R1. Synthetic client needs video. Synthetic evidence: validated under test configuration.",
                filename: "synthetic-products.txt",
              })
            ).duplicate,
          );
          const version = await call(
            "crm_product",
            { entityId: ids.version },
            reader,
          );
          assert.equal(version.parents[0].id, ids.model);
          assert.equal(version.projects[0].id, ids.project);
          assert.equal(version.materials[0].id, material);
          assert.equal(
            (await call("crm_customer", { entityId: ids.project })).products[0]
              .id,
            ids.version,
          );
          assert.equal(
            (await call("crm_entities", { type: "product_model" })).total,
            1,
          );
          await assert.rejects(
            call("crm_product", { entityId: ids.customer }),
            (e) => e.code === "INVALID_PRODUCT",
          );
          await assert.rejects(
            call(
              "crm_propose",
              {
                idempotencyKey: "denied",
                materialIds: [material],
                operations: [],
              },
              reader,
            ),
            (e) => e.code === "FORBIDDEN",
          );
        },
      );
      await t.test(
        "requirements, unknown assessment and reviewed capability are distinct, scoped facts",
        async () => {
          await commit("products:assertions", [
            assertion("requirement", "requested", "video", {
              contextEntityId: ids.project,
            }),
            assertion("assessment", "unknown"),
            assertion("capability", "supported", "video", {
              reviewed: true,
              conditions: "synthetic test configuration only",
            }),
          ]);
          const v = await call(
            "crm_product",
            { entityId: ids.version },
            reader,
          );
          assert.equal(v.requirements.length, 1);
          assert.equal(v.assessments.length, 1);
          assert.equal(v.capabilities.length, 1);
          assert.equal(v.requirements[0].classification, "customer_claim");
          assert.equal(v.requirements[0].value.contextEntityId, ids.project);
          assert.equal(v.assessments[0].value.status, "unknown");
          assert.equal(v.capabilities[0].classification, "verified");
          assert.equal(
            v.capabilities[0].value.conditions,
            "synthetic test configuration only",
          );
          assert.equal(v.capabilities[0].history.length, 1);
          assert.equal(
            v.capabilities[0].evidence[0].verification,
            "quote_matched",
          );
          assert.equal(
            (await call("crm_product", { entityId: ids.model })).capabilities
              .length,
            0,
            "a child capability is not inherited by its model",
          );
          const original = await call("crm_evidence", {
            evidenceId: v.capabilities[0].evidence[0].id,
          });
          assert.equal(original.material.id, material);
          assert(
            (
              await call("crm_material", {
                materialId: material,
                includeContent: true,
              })
            ).content.text.includes(original.evidence.quote),
          );
        },
      );
      await t.test(
        "invalid assertions and relations fail atomically, including generic fact bypass",
        async () => {
          const invalid = [
            [
              assertion("requirement", "supported", "bad", {
                contextEntityId: ids.project,
              }),
              "INVALID_PRODUCT_ASSERTION",
            ],
            [
              assertion("requirement", "requested", "bad"),
              "INVALID_PRODUCT_CONTEXT",
            ],
            [
              assertion("assessment", "pending", "bad", {
                contextEntityId: ids.model,
              }),
              "INVALID_PRODUCT_CONTEXT",
            ],
            [
              assertion("capability", "supported", "bad"),
              "PRODUCT_REVIEW_REQUIRED",
            ],
            [
              assertion("capability", "supported", "bad", {
                reviewed: true,
                evidence: ev("missing exact quote"),
              }),
              "QUOTE_MISMATCH",
            ],
            [
              assertion("assessment", "pending", "bad", {
                entityId: ids.project,
              }),
              "INVALID_PRODUCT",
            ],
            [assertion("assessment", "pending", "bad:key"), "VALIDATION"],
            [
              assertion("assessment", "pending", "bad", {
                classification: "verified",
              }),
              "VALIDATION",
            ],
            [
              {
                op: "set_fact",
                entityId: ids.version,
                key: "product_assertion:capability:forged",
                value: { kind: "capability" },
                classification: "verified",
                evidence: ev("Synthetic"),
              },
              "RESERVED_PRODUCT_FACT",
            ],
            [
              {
                op: "add_relation",
                fromId: ids.version,
                toId: ids.model,
                kind: "model_has_version",
                evidence: ev("Synthetic"),
              },
              "INVALID_PRODUCT_RELATION",
            ],
            [
              {
                op: "add_relation",
                fromId: ids.product,
                toId: ids.project,
                kind: "has_project",
                evidence: ev("Synthetic"),
              },
              "INVALID_PRODUCT_RELATION",
            ],
            [
              {
                op: "add_relation",
                fromId: ids.project,
                toId: ids.customer,
                kind: "uses_product",
                evidence: ev("Synthetic"),
              },
              "INVALID_PRODUCT_RELATION",
            ],
          ];
          const count = (await call("crm_entities")).total;
          for (const [index, [op, code]] of invalid.entries()) {
            const p = await propose("products:invalid:" + index, [
              {
                op: "create_entity",
                ref: "mustRollback",
                type: "issue",
                name: "Must rollback " + index,
                evidence: ev("Synthetic"),
              },
              op,
            ]);
            await assert.rejects(
              call("crm_commit", { proposalId: p.proposal.id }),
              (e) => e.code === code,
            );
            assert.equal((await call("crm_entities")).total, count);
          }
          const binary = await call("crm_ingest", {
            base64: Buffer.from([1, 2, 3]).toString("base64"),
            filename: "binary.png",
            mimeType: "image/png",
          });
          const p = await propose(
            "products:binary",
            [
              assertion("capability", "supported", "binary", {
                reviewed: true,
                evidence: [
                  {
                    materialId: binary.materialId,
                    quote: "not verified by OCR",
                    locator: { kind: "image", page: 1 },
                  },
                ],
              }),
            ],
            [binary.materialId],
          );
          await assert.rejects(
            call("crm_commit", { proposalId: p.proposal.id }),
            (e) => e.code === "UNVERIFIED_BINARY",
          );
          assert.equal(
            (await call("crm_product", { entityId: ids.version })).capabilities
              .length,
            1,
          );
        },
      );
      await t.test(
        "a version has one model; duplicated labels are not automatically merged",
        async () => {
          const other = await commit("products:other-model", [
            {
              op: "create_entity",
              ref: "other",
              type: "product_model",
              name: "DEMO-2",
              evidence: ev("DemoKit"),
            },
          ]);
          const otherId = other.result.refs.other;
          const p = await propose("products:parent-conflict", [
            {
              op: "add_relation",
              fromId: otherId,
              toId: ids.version,
              kind: "model_has_version",
              evidence: ev("R1"),
            },
          ]);
          await assert.rejects(
            call("crm_commit", { proposalId: p.proposal.id }),
            (e) => e.code === "PRODUCT_PARENT_CONFLICT",
          );
          const second = await commit("products:another-version", [
            {
              op: "create_entity",
              ref: "v",
              type: "product_version",
              name: "R1",
              evidence: ev("video"),
            },
            {
              op: "add_relation",
              fromId: otherId,
              toId: "$v",
              kind: "model_has_version",
              evidence: ev("video"),
            },
          ]);
          assert.notEqual(second.result.refs.v, ids.version);
          assert.equal(
            (await call("crm_product", { entityId: second.result.refs.v }))
              .capabilities.length,
            0,
          );
          const family = await call("crm_product", { entityId: ids.product });
          assert.equal(family.children.length, 1);
        },
      );
      await t.test(
        "same evidence permits R1 under distinct models with trailing parent relations",
        async () => {
          const m = await call("crm_ingest", {
            text: "Synthetic A and B both use version R1; capability validated only for A.",
          });
          const evidence = [
            {
              materialId: m.materialId,
              quote: "A and B both use version R1",
              locator: { kind: "text" },
            },
          ];
          const save = async (key, operations) => {
            const p = await call("crm_propose", {
              idempotencyKey: key,
              materialIds: [m.materialId],
              operations,
            });
            return call("crm_commit", { proposalId: p.proposal.id });
          };
          const models = await save("scope:models", [
            ...[
              ["a", "Scope-A"],
              ["b", "Scope-B"],
            ].map(([ref, name]) => ({
              op: "create_entity",
              ref,
              type: "product_model",
              name,
              evidence,
            })),
          ]);
          const first = await save("scope:first", [
            {
              op: "create_entity",
              ref: "v",
              type: "product_version",
              name: "R1",
              evidence,
            },
            {
              op: "add_relation",
              fromId: models.result.refs.a,
              toId: "$v",
              kind: "model_has_version",
              evidence,
            },
            {
              op: "set_product_assertion",
              entityId: "$v",
              key: "local",
              kind: "capability",
              status: "supported",
              statement: "A only",
              reviewed: true,
              evidence: [
                { ...evidence[0], quote: "capability validated only for A" },
              ],
            },
          ]);
          const second = await save("scope:second", [
            {
              op: "create_entity",
              ref: "v",
              type: "product_version",
              name: "R1",
              evidence,
            },
            {
              op: "add_relation",
              fromId: models.result.refs.b,
              toId: "$v",
              kind: "model_has_version",
              evidence,
            },
          ]);
          assert.notEqual(first.result.refs.v, second.result.refs.v);
          const a = await call("crm_product", {
              entityId: first.result.refs.v,
            }),
            b = await call("crm_product", { entityId: second.result.refs.v });
          assert.equal(a.parents[0].id, models.result.refs.a);
          assert.equal(b.parents[0].id, models.result.refs.b);
          assert.equal(a.capabilities.length, 1);
          assert.equal(b.capabilities.length, 0);
        },
      );
      await t.test(
        "same-batch child collisions include future products, models and trailing edges",
        async () => {
          const m = await call("crm_ingest", {
            text: "Synthetic both product families use model Shared and version R1.",
          });
          const evidence = [
            {
              materialId: m.materialId,
              quote: "both product families use model Shared and version R1",
              locator: { kind: "text" },
            },
          ];
          const proposeScoped = (key, operations) =>
            call("crm_propose", {
              idempotencyKey: key,
              materialIds: [m.materialId],
              operations,
            });
          const save = async (key, operations) => {
            const p = await proposeScoped(key, operations);
            return call("crm_commit", { proposalId: p.proposal.id });
          };
          const make = (ref, type, name) => ({
            op: "create_entity",
            ref,
            type,
            name,
            evidence,
          });
          const rel = (fromId, toId, kind) => ({
            op: "add_relation",
            fromId,
            toId,
            kind,
            evidence,
          });
          const result = await save("scope:future-chain", [
            make("v1", "product_version", "R1"),
            make("v2", "product_version", "R1"),
            make("m1", "product_model", "Shared"),
            make("m2", "product_model", "Shared"),
            make("p1", "product", "Scope family one"),
            make("p2", "product", "Scope family two"),
            rel("$p1", "$m1", "product_has_model"),
            rel("$p2", "$m2", "product_has_model"),
            rel("$m1", "$v1", "model_has_version"),
            rel("$m2", "$v2", "model_has_version"),
          ]);
          const refs = result.result.refs;
          assert.equal(new Set(Object.values(refs)).size, 6);
          for (const n of [1, 2]) {
            assert.equal(
              (await call("crm_product", { entityId: refs["v" + n] }))
                .parents[0].id,
              refs["m" + n],
            );
            assert.equal(
              (await call("crm_product", { entityId: refs["m" + n] }))
                .parents[0].id,
              refs["p" + n],
            );
          }
          scoped = { refs, make, rel, save, proposeScoped };
        },
      );
      await t.test(
        "parent-scoped duplicates reject same, absent, conflicting and invalid parents atomically",
        async () => {
          const { refs, make, rel, save, proposeScoped } = scoped;
          const cases = [
            [
              "same-model-parent",
              [
                make("x", "product_model", "Shared"),
                rel(refs.p1, "$x", "product_has_model"),
              ],
              "ENTITY_CANDIDATE",
            ],
            [
              "same-version-parent",
              [
                make("x", "product_version", "R1"),
                rel(refs.m1, "$x", "model_has_version"),
              ],
              "ENTITY_CANDIDATE",
            ],
            [
              "absent-model-parent",
              [make("x", "product_model", "Shared")],
              "ENTITY_CANDIDATE",
            ],
            [
              "absent-version-parent",
              [make("x", "product_version", "R1")],
              "ENTITY_CANDIDATE",
            ],
            [
              "conflicting-model-parent",
              [
                make("x", "product_model", "Shared"),
                rel(refs.p1, "$x", "product_has_model"),
                rel(refs.p2, "$x", "product_has_model"),
              ],
              "PRODUCT_PARENT_CONFLICT",
            ],
            [
              "conflicting-version-parent",
              [
                make("x", "product_version", "R1"),
                rel(refs.m1, "$x", "model_has_version"),
                rel(refs.m2, "$x", "model_has_version"),
              ],
              "PRODUCT_PARENT_CONFLICT",
            ],
            [
              "wrong-parent-type",
              [
                make("x", "product_version", "R1"),
                rel(refs.p1, "$x", "model_has_version"),
              ],
              "INVALID_PRODUCT_RELATION",
            ],
            [
              "missing-parent-ref",
              [
                make("x", "product_version", "R1"),
                rel("$missing", "$x", "model_has_version"),
              ],
              "UNKNOWN_REF",
            ],
            [
              "wrong-future-parent",
              [
                make("x", "product_version", "R1"),
                make("future", "contact", "Synthetic contact"),
                rel("$future", "$x", "model_has_version"),
              ],
              "INVALID_PRODUCT_RELATION",
            ],
            [
              "same-batch-same-parent",
              [
                make("x", "product_version", "Batch-R"),
                make("y", "product_version", "Batch-R"),
                rel(refs.m1, "$x", "model_has_version"),
                rel(refs.m1, "$y", "model_has_version"),
              ],
              "ENTITY_CANDIDATE",
            ],
            [
              "planned-existing-parent-conflict",
              [
                make("x", "product_version", "R1"),
                rel(refs.m2, "$x", "model_has_version"),
                rel(refs.m2, refs.v1, "model_has_version"),
              ],
              "PRODUCT_PARENT_CONFLICT",
            ],
          ];
          await save("scope:orphan", [
            make("orphan", "product_version", "Orphan-R"),
          ]);
          cases.push([
            "candidate-parent-unknown",
            [
              make("x", "product_version", "Orphan-R"),
              rel(refs.m1, "$x", "model_has_version"),
            ],
            "ENTITY_CANDIDATE",
          ]);
          for (const [key, ops, code] of cases) {
            const before = await domain.exportData();
            const proposal = await proposeScoped("scope:reject:" + key, [
              make("sentinel", "issue", "Rollback " + key),
              ...ops,
            ]);
            await assert.rejects(
              call("crm_commit", { proposalId: proposal.proposal.id }),
              (e) => e.code === code,
              key,
            );
            const after = await domain.exportData();
            for (const table of [
              "entities",
              "relations",
              "facts",
              "evidence",
              "object_evidence",
              "material_entities",
            ])
              assert.deepEqual(
                after.tables[table],
                before.tables[table],
                key + " rollback " + table,
              );
          }
        },
      );
      await t.test(
        "concurrent same-evidence child creation preserves scoped duplicate protection",
        async () => {
          const { refs, make, rel, save } = scoped;
          const distinct = await Promise.all(
            [1, 2].map((n) =>
              save("scope:concurrent:distinct:" + n, [
                make("v", "product_version", "Concurrent-R"),
                rel(refs["m" + n], "$v", "model_has_version"),
              ]),
            ),
          );
          assert.notEqual(distinct[0].result.refs.v, distinct[1].result.refs.v);
          const same = await Promise.allSettled(
            [1, 2].map((n) =>
              save("scope:concurrent:same:" + n, [
                make("v", "product_version", "Concurrent-same-R"),
                rel(refs.m1, "$v", "model_has_version"),
              ]),
            ),
          );
          assert.equal(
            same.filter(
              (r) => r.status === "fulfilled" && r.value.status === "committed",
            ).length,
            1,
          );
          assert.equal(
            same.filter(
              (r) =>
                r.status === "rejected" && r.reason.code === "ENTITY_CANDIDATE",
            ).length,
            1,
          );
        },
      );
      await t.test(
        "concurrent parent assignments retain one parent without partial writes",
        async () => {
          const created = await commit("products:concurrent-identities", [
            ...[
              ["a", "product_model", "RACE-A", "family"],
              ["b", "product_model", "RACE-B", "client"],
              ["v", "product_version", "RACE-R", "needs"],
            ].map(([ref, type, name, quote]) => ({
              op: "create_entity",
              ref,
              type,
              name,
              evidence: ev(quote),
            })),
          ]);
          const refs = created.result.refs;
          const proposals = await Promise.all(
            ["a", "b"].map((ref) =>
              propose("products:race:" + ref, [
                {
                  op: "add_relation",
                  fromId: refs[ref],
                  toId: refs.v,
                  kind: "model_has_version",
                  evidence: ev("Synthetic"),
                },
              ]),
            ),
          );
          const results = await Promise.allSettled(
            proposals.map((p) =>
              call("crm_commit", { proposalId: p.proposal.id }),
            ),
          );
          assert.equal(
            results.filter(
              (r) => r.status === "fulfilled" && r.value.status === "committed",
            ).length,
            1,
          );
          assert.equal(
            results.filter(
              (r) =>
                r.status === "rejected" &&
                r.reason.code === "PRODUCT_PARENT_CONFLICT",
            ).length,
            1,
          );
          assert.equal(
            (await call("crm_product", { entityId: refs.v })).parents.length,
            1,
          );
        },
      );
      await t.test(
        "conflicts and version checks preserve reviewed capability and evidence history",
        async () => {
          const p = await propose("products:change", [
            assertion("capability", "unsupported", "video", {
              reviewed: true,
              expectedVersion: 1,
            }),
          ]);
          const blocked = await call("crm_commit", {
            proposalId: p.proposal.id,
          });
          assert.equal(blocked.status, "conflict");
          assert.equal(
            (await call("crm_product", { entityId: ids.version }))
              .capabilities[0].value.status,
            "supported",
          );
          await assert.rejects(
            call("crm_commit", {
              proposalId: p.proposal.id,
              resolveConflicts: true,
            }),
            (e) => e.code === "FORBIDDEN",
          );
          assert.equal(
            (
              await call(
                "crm_commit",
                { proposalId: p.proposal.id, resolveConflicts: true },
                owner,
              )
            ).status,
            "committed",
          );
          const v = await call("crm_product", { entityId: ids.version });
          assert.equal(v.capabilities[0].value.status, "unsupported");
          assert.equal(v.capabilities[0].history.length, 2);
          const stale = await propose("products:stale", [
            assertion("capability", "supported", "video", {
              reviewed: true,
              expectedVersion: 1,
            }),
          ]);
          await assert.rejects(
            call("crm_commit", { proposalId: stale.proposal.id }),
            (e) => e.code === "STALE_VERSION",
          );
        },
      );
      await t.test(
        "generic source reassignment leaves product assertions pending instead of moving them",
        async () => {
          const result = await call(
            "crm_reassign",
            {
              materialId: material,
              fromEntityId: ids.version,
              toEntityId: ids.customer,
              idempotencyKey: "products:reassign",
              reason: "synthetic correction boundary test",
            },
            owner,
          );
          assert(
            result.pending.some(
              (x) => x.reason === "product_assertion_requires_review",
            ),
          );
          assert(result.originalLinkRetained);
          assert.equal(
            (await call("crm_product", { entityId: ids.version })).capabilities
              .length,
            1,
          );
        },
      );
      await t.test(
        "restart and logical restore keep IDs, sources, assertions and relationships",
        async () => {
          const before = await domain.exportData();
          await domain.close();
          domain = await createDomain({
            databaseUrl: url,
            dataDir,
            productLibraryEnabled: true,
          });
          const restored = await call("crm_product", { entityId: ids.version });
          assert.equal(restored.capabilities[0].history.length, 2);
          const restoreUrl = process.env.CRM_PRODUCT_RESTORE_DATABASE_URL;
          assert(restoreUrl);
          assert.match(new URL(restoreUrl).pathname, /product_restore_test_/);
          const bin = path.resolve("runtime/usr/lib/postgresql/16/bin");
          const db = new URL(url),
            target = new URL(restoreUrl);
          const env = {
            ...process.env,
            PGPASSWORD: decodeURIComponent(db.password),
            LD_LIBRARY_PATH: path.resolve("runtime/usr/lib/x86_64-linux-gnu"),
          };
          const dump = path.join(dataDir, "synthetic-product.dump");
          const run = (file, args) =>
            new Promise((resolve, reject) => {
              const child = spawn(file, args, {
                env,
                stdio: ["ignore", "ignore", "pipe"],
              });
              let error = "";
              child.stderr.on("data", (b) => (error += b));
              child.on("error", reject);
              child.on("close", (code) =>
                code
                  ? reject(new Error("Synthetic dump/restore failed: " + error))
                  : resolve(),
              );
            });
          const connectionArgs = (u) => [
            "-h",
            u.hostname,
            "-p",
            u.port,
            "-U",
            decodeURIComponent(u.username),
            "-d",
            u.pathname.slice(1),
          ];
          await run(path.join(bin, "pg_dump"), [
            ...connectionArgs(db),
            "-Fc",
            "-f",
            dump,
          ]);
          await run(path.join(bin, "pg_restore"), [
            ...connectionArgs(target),
            "--no-owner",
            "--no-acl",
            "--exit-on-error",
            dump,
          ]);
          const restoreData = path.join(dataDir, "restored-originals");
          await fs.mkdir(restoreData);
          await fs.cp(
            path.join(dataDir, "objects"),
            path.join(restoreData, "objects"),
            { recursive: true },
          );
          const copy = await createDomain({
            databaseUrl: restoreUrl,
            dataDir: restoreData,
            productLibraryEnabled: true,
          });
          try {
            const after = await copy.exportData();
            const sort = (table) => table.map((x) => JSON.stringify(x)).sort();
            for (const name of Object.keys(before.tables))
              assert.deepEqual(
                sort(after.tables[name]),
                sort(before.tables[name]),
                name,
              );
            const v = await copy.call(
              "crm_product",
              { entityId: ids.version },
              reader,
            );
            assert.equal(v.parents[0].id, ids.model);
            assert.equal(v.projects[0].id, ids.project);
            assert.equal(v.capabilities[0].history.length, 2);
            assert.equal(
              (
                await copy.call(
                  "crm_material",
                  { materialId: material, includeContent: true },
                  reader,
                )
              ).material.sha256,
              (await call("crm_material", { materialId: material })).material
                .sha256,
            );
          } finally {
            await copy.close();
          }
        },
      );
    } finally {
      await domain.close();
      await pool.end();
    }
  },
);
