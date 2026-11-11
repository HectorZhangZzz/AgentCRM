export const productTypes = {
  product: "产品",
  product_model: "型号",
  product_version: "版本",
};
export const assertionKinds = {
  requirement: "客户要求",
  assessment: "待验证评估",
  capability: "来源复核能力",
};
export const assertionStates = {
  requested: "提出要求",
  unknown: "未知",
  pending: "待验证",
  supported: "有依据支持",
  unsupported: "有依据不支持",
};
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function validateDraft(draft) {
  if (!draft.source?.text?.trim())
    throw new Error(
      "请提供可读取的原始文字依据；二进制原件请先由宿主复核提取。",
    );
  if (
    !draft.source.quote?.trim() ||
    !draft.source.text.includes(draft.source.quote)
  )
    throw new Error("引文必须是原始文字中连续、准确的一段。");
  if (!draft.source.materialId && !draft.source.label?.trim())
    throw new Error("请填写来源说明。");
  if (draft.mode === "hierarchy") {
    if (!productTypes[draft.type] || !draft.name?.trim())
      throw new Error("请填写要建立的产品、型号或版本名称。");
    if (draft.type !== "product" && !draft.parentId)
      throw new Error("请从明确的父产品或型号页面建立下级对象。");
    if (
      draft.versionName?.trim() &&
      draft.type === "product" &&
      !draft.modelName?.trim()
    )
      throw new Error("填写版本前，请先填写所属型号。");
  } else if (draft.mode === "assertion") {
    if (!draft.entityId) throw new Error("缺少当前产品对象，请重新打开详情。");
    if (!draft.key?.trim() || !/^[^:\s]{1,120}$/u.test(draft.key))
      throw new Error("记录主题需为1至120个字符，不含空格或冒号。");
    if (!draft.statement?.trim())
      throw new Error("请填写实际要求、待确认判断或证据支持的结论。");
    const valid = {
      requirement: ["requested"],
      assessment: ["unknown", "pending"],
      capability: ["supported", "unsupported"],
    };
    if (!valid[draft.kind]?.includes(draft.status))
      throw new Error("记录类别和状态不匹配。");
    if (draft.kind === "requirement" && !draft.contextId)
      throw new Error("客户要求必须选择对应客户或项目。");
    if (
      draft.kind === "capability" &&
      (!draft.reviewed || !draft.conditions?.trim())
    )
      throw new Error("能力记录需明确复核文字依据，并写明适用或测试条件。");
  } else if (draft.mode === "relation") {
    if (!draft.entityId || !draft.contextId)
      throw new Error("请选择明确的客户或项目。");
  } else throw new Error("未知记录方式。");
}
export function buildOperations(draft, materialId) {
  validateDraft(draft);
  const evidence = [
    { materialId, quote: draft.source.quote, locator: { kind: "text" } },
  ];
  const entity = (ref, type, name) => ({
    op: "create_entity",
    ref,
    type,
    name: name.trim(),
    evidence,
  });
  const relation = (fromId, toId, kind) => ({
    op: "add_relation",
    fromId,
    toId,
    kind,
    evidence,
  });
  if (draft.mode === "hierarchy") {
    const ops = [entity("item", draft.type, draft.name)];
    let focusRef = "item";
    if (draft.type !== "product")
      ops.push(
        relation(
          draft.parentId,
          "$item",
          draft.type === "product_model"
            ? "product_has_model"
            : "model_has_version",
        ),
      );
    if (draft.type === "product" && draft.modelName?.trim()) {
      ops.push(
        entity("model", "product_model", draft.modelName),
        relation("$item", "$model", "product_has_model"),
      );
      focusRef = "model";
    }
    if (draft.type !== "product_version" && draft.versionName?.trim()) {
      ops.push(
        entity("version", "product_version", draft.versionName),
        relation("$" + focusRef, "$version", "model_has_version"),
      );
      focusRef = "version";
    }
    return { operations: ops, focusRef };
  }
  if (draft.mode === "relation")
    return {
      operations: [relation(draft.contextId, draft.entityId, "uses_product")],
      entityId: draft.entityId,
    };
  return {
    operations: [
      {
        op: "set_product_assertion",
        entityId: draft.entityId,
        key: draft.key,
        kind: draft.kind,
        status: draft.status,
        statement: draft.statement.trim(),
        conditions: draft.conditions?.trim() || null,
        contextEntityId: draft.contextId || null,
        ...(draft.kind === "capability" ? { reviewed: true } : {}),
        evidence,
      },
    ],
    entityId: draft.entityId,
  };
}
// A frozen payload and one key survive retries, including a lost commit reply.
// No authentication data is stored in this controller or browser storage.
export function createSubmission(call, draft, key) {
  validateDraft(draft);
  const input = structuredClone(draft);
  let materialId = input.source.materialId,
    proposalId,
    result,
    inFlight,
    uncertain = false;
  const state = () => ({
    materialId,
    proposalId,
    done: !!result,
    uncertain,
    input: structuredClone(input),
    key,
  });
  return {
    state,
    submit() {
      if (result) return Promise.resolve(result);
      if (inFlight) return inFlight;
      inFlight = (async () => {
        if (!materialId)
          materialId = (
            await call("crm_ingest", {
              text: input.source.text,
              filename: "产品资料原文.txt",
              source: input.source.label.trim(),
            })
          ).materialId;
        const plan = buildOperations(input, materialId);
        if (!proposalId)
          proposalId = (
            await call("crm_propose", {
              idempotencyKey: key,
              materialIds: [materialId],
              operations: plan.operations,
            })
          ).proposal.id;
        const committed = await call("crm_commit", { proposalId });
        if (!["committed", "conflict"].includes(committed.status))
          throw new Error("尚未确定同一建议的提交状态，请保留原提交重试");
        uncertain = false;
        result = {
          ...committed,
          materialId,
          focusId: plan.entityId || committed.result?.refs?.[plan.focusRef],
        };
        return result;
      })()
        .catch((error) => {
          if (![400, 401, 403, 404, 409, 413].includes(error.status))
            uncertain = true;
          // Once uncertain, authentication or validation failures cannot unlock it.
          throw error;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
