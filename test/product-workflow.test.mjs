import test from "node:test";
import assert from "node:assert/strict";
import { previewEntry } from "../ops/product-preview.mjs";
import {
  validateDraft,
  buildOperations,
  createSubmission,
  escapeHtml,
} from "../public/product-workflow.mjs";
const source = {
  text: "Synthetic product P, model M, revision R; customer requests 4K. Reviewed under synthetic test only.",
  quote: "Synthetic product P, model M, revision R",
  label: "Synthetic original",
};
const hierarchy = () => ({
  mode: "hierarchy",
  type: "product",
  name: "P",
  modelName: "M",
  versionName: "R",
  source: structuredClone(source),
});
test("product UI builds distinct hierarchy identities and locks parent relation direction", () => {
  const d = hierarchy(),
    p = buildOperations(d, "material");
  assert.deepEqual(
    p.operations.filter((o) => o.op === "create_entity").map((o) => o.type),
    ["product", "product_model", "product_version"],
  );
  assert.deepEqual(
    p.operations
      .filter((o) => o.op === "add_relation")
      .map((o) => [o.fromId, o.toId, o.kind]),
    [
      ["$item", "$model", "product_has_model"],
      ["$model", "$version", "model_has_version"],
    ],
  );
  assert.equal(p.focusRef, "version");
  d.type = "product_version";
  d.parentId = "existing-model";
  assert.equal(buildOperations(d, "m").operations[1].fromId, "existing-model");
});
test("product UI distinguishes requirements, assessments and reviewed capabilities", () => {
  const d = {
    mode: "assertion",
    entityId: "version",
    key: "4K",
    kind: "requirement",
    status: "requested",
    statement: "Required by synthetic customer",
    contextId: "project",
    source,
  };
  assert.equal(
    buildOperations(d, "m").operations[0].contextEntityId,
    "project",
  );
  assert.throws(() => validateDraft({ ...d, contextId: "" }), /必须选择/);
  assert.throws(() => validateDraft({ ...d, status: "supported" }), /不匹配/);
  assert.throws(
    () =>
      validateDraft({
        ...d,
        kind: "capability",
        status: "supported",
        contextId: null,
        reviewed: false,
      }),
    /需明确复核/,
  );
  const capability = buildOperations(
    {
      ...d,
      kind: "capability",
      status: "supported",
      reviewed: true,
      conditions: "Synthetic board/software only",
    },
    "m",
  ).operations[0];
  assert.equal(capability.reviewed, true);
  assert.equal(capability.conditions, "Synthetic board/software only");
  assert.equal(
    buildOperations(
      { ...d, kind: "assessment", status: "unknown", contextId: "" },
      "m",
    ).operations[0].contextEntityId,
    null,
  );
});
test("product UI rejects invalid quote, missing parent and version without model before any request", () => {
  assert.throws(
    () =>
      validateDraft({
        ...hierarchy(),
        source: { ...source, quote: "not in original" },
      }),
    /原始文字/,
  );
  assert.throws(
    () =>
      validateDraft({ ...hierarchy(), type: "product_model", parentId: null }),
    /父产品/,
  );
  assert.throws(
    () => validateDraft({ ...hierarchy(), modelName: "" }),
    /所属型号/,
  );
  assert.throws(
    () => validateDraft({ ...hierarchy(), source: { ...source, label: "" } }),
    /来源说明/,
  );
});
test("product UI uses same promise/payload/key for double submit and successful replay", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const call = async (n, a) => {
    calls.push([n, structuredClone(a)]);
    if (n === "crm_ingest") {
      await gate;
      return { materialId: "material" };
    }
    if (n === "crm_propose") return { proposal: { id: "proposal" } };
    return {
      status: "committed",
      result: { refs: { version: "stable-version" } },
    };
  };
  const d = hierarchy(),
    job = createSubmission(call, d, "stable-key");
  const a = job.submit(),
    b = job.submit();
  assert.equal(a, b);
  d.name = "changed input";
  release();
  assert.equal((await a).focusId, "stable-version");
  assert.equal((await job.submit()).focusId, "stable-version");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["crm_ingest", "crm_propose", "crm_commit"],
  );
  assert.equal(calls[1][1].operations[0].name, "P");
  assert.equal(calls[1][1].idempotencyKey, "stable-key");
});
test("product UI recovers lost commit reply with same proposal and no second ingest/propose", async () => {
  let committed = 0;
  const calls = [];
  const call = async (n, a) => {
    calls.push([n, a]);
    if (n === "crm_ingest") return { materialId: "material" };
    if (n === "crm_propose") return { proposal: { id: "proposal" } };
    committed++;
    if (committed === 1) throw Error("lost response after server commit");
    return {
      status: "committed",
      duplicate: true,
      result: { refs: { version: "stable-version" } },
    };
  };
  const job = createSubmission(call, hierarchy(), "same-key");
  await assert.rejects(job.submit(), /lost response/);
  assert.equal(job.state().proposalId, "proposal");
  assert.equal((await job.submit()).duplicate, true);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["crm_ingest", "crm_propose", "crm_commit", "crm_commit"],
  );
  assert.deepEqual(calls.at(-1)[1], calls.at(-2)[1]);
});
test("product UI recovers lost proposal response with same exact idempotency payload", async () => {
  let attempt = 0;
  const calls = [];
  const call = async (n, a) => {
    calls.push([n, structuredClone(a)]);
    if (n === "crm_ingest") return { materialId: "material" };
    if (n === "crm_propose") {
      if (++attempt === 1) throw Error("lost proposal response");
      return { proposal: { id: "proposal" } };
    }
    return { status: "committed", result: { refs: { version: "v" } } };
  };
  const job = createSubmission(call, hierarchy(), "same-key");
  await assert.rejects(job.submit());
  await job.submit();
  const proposals = calls.filter(([n]) => n === "crm_propose");
  assert.deepEqual(proposals[0][1], proposals[1][1]);
  assert.equal(calls.filter(([n]) => n === "crm_ingest").length, 1);
});
test("product UI reuses existing material, preserves conflict and never requests owner override", async () => {
  const calls = [];
  const d = { ...hierarchy(), source: { ...source, materialId: "existing" } };
  const job = createSubmission(
    async (n, a) => {
      calls.push([n, a]);
      return n === "crm_propose"
        ? { proposal: { id: "p" } }
        : { status: "conflict", conflicts: [{ type: "fact_change" }] };
    },
    d,
    "key",
  );
  assert.equal((await job.submit()).status, "conflict");
  await job.submit();
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["crm_propose", "crm_commit"],
  );
  assert.equal(calls[1][1].resolveConflicts, undefined);
});
test("product UI escapes data text and associations never create sales projects or tasks", () => {
  assert.equal(
    escapeHtml('<img src=x onerror="attack()">'),
    "&lt;img src=x onerror=&quot;attack()&quot;&gt;",
  );
  const result = buildOperations(
    {
      mode: "relation",
      entityId: "version",
      contextId: "existing-project",
      source,
    },
    "m",
  );
  assert.deepEqual(
    result.operations.map((o) => o.op),
    ["add_relation"],
  );
  assert.equal(result.operations[0].kind, "uses_product");
  assert.equal(result.operations[0].fromId, "existing-project");
  assert.equal(result.entityId, "version");
});

test("product UI keeps uncertain outcome locked through 401 until same proposal confirmed", async () => {
  let count = 0;
  const calls = [];
  const call = async (n, a) => {
    calls.push([n, structuredClone(a)]);
    if (n === "crm_ingest") return { materialId: "m" };
    if (n === "crm_propose") return { proposal: { id: "same-proposal" } };
    count++;
    if (count === 1) throw Error("server committed, response lost");
    if (count === 2) {
      const error = Error("expired session");
      error.status = 401;
      throw error;
    }
    return {
      status: "committed",
      duplicate: true,
      result: { refs: { version: "same-version" } },
    };
  };
  const job = createSubmission(call, hierarchy(), "same-key");
  await assert.rejects(job.submit());
  assert(job.state().uncertain);
  await assert.rejects(job.submit(), (e) => e.status === 401);
  assert(job.state().uncertain);
  assert.equal(job.state().proposalId, "same-proposal");
  const result = await job.submit();
  assert.equal(result.focusId, "same-version");
  assert.equal(job.state().uncertain, false);
  assert.deepEqual(
    calls.filter(([n]) => n === "crm_commit").map(([, a]) => a),
    [
      { proposalId: "same-proposal" },
      { proposalId: "same-proposal" },
      { proposalId: "same-proposal" },
    ],
  );
  assert.equal(calls.filter(([n]) => n === "crm_propose").length, 1);
});

test("preview helper selects reachable UI or legacy entry independently of domain flag", () => {
  assert.equal(
    previewEntry({ url: "http://127.0.0.1:4325", ui: true, enabled: true }),
    "http://127.0.0.1:4325/products",
  );
  assert.equal(
    previewEntry({ url: "http://127.0.0.1:4326", ui: true, enabled: false }),
    "http://127.0.0.1:4326/products",
  );
  assert.equal(
    previewEntry({ url: "http://127.0.0.1:4327", ui: false, enabled: false }),
    "http://127.0.0.1:4327/",
  );
});
test("preview helper defaults absent or non-boolean UI flag to legacy route", () => {
  assert.equal(
    previewEntry({ url: "http://127.0.0.1:4327", enabled: true }),
    "http://127.0.0.1:4327/",
  );
  assert.equal(
    previewEntry({ url: "http://127.0.0.1:4327", ui: "true" }),
    "http://127.0.0.1:4327/",
  );
});
