// Product identities and assertions reuse the domain's existing entities,
// relations, versioned facts and evidence. Nothing here calls an external service.
export const PRODUCT_TYPES = ["product", "product_model", "product_version"];
export const PRODUCT_ASSERTION_PREFIX = "product_assertion:";
const hierarchy = {
  product_has_model: ["product", "product_model"],
  model_has_version: ["product_model", "product_version"],
};
export function productRelationRule(kind, fromType, toType) {
  if (hierarchy[kind]) {
    const [from, to] = hierarchy[kind];
    return { valid: fromType === from && toType === to, singleParent: true };
  }
  if (kind === "uses_product")
    return {
      valid:
        ["customer", "project"].includes(fromType) &&
        PRODUCT_TYPES.includes(toType),
      singleParent: false,
    };
  return {
    valid: !PRODUCT_TYPES.includes(fromType) && !PRODUCT_TYPES.includes(toType),
    singleParent: false,
  };
}
export function normalizeProductAssertion(op, entity, context, fail) {
  const allowed = new Set([
    "op",
    "entityId",
    "key",
    "kind",
    "status",
    "statement",
    "conditions",
    "contextEntityId",
    "reviewed",
    "evidence",
    "expectedVersion",
  ]);
  for (const key of Object.keys(op))
    if (!allowed.has(key)) fail("VALIDATION", "未知产品断言字段", 400, { key });
  if (!PRODUCT_TYPES.includes(entity.type))
    fail("INVALID_PRODUCT", "产品断言必须属于产品、型号或版本");
  if (typeof op.key !== "string" || !/^[^:\s]{1,120}$/u.test(op.key))
    fail("VALIDATION", "产品断言key须为1至120个无空白及冒号的字符");
  if (typeof op.statement !== "string" || !op.statement.trim())
    fail("VALIDATION", "产品断言需要statement");
  if (
    op.conditions !== undefined &&
    op.conditions !== null &&
    typeof op.conditions !== "string"
  )
    fail("VALIDATION", "conditions须为文字或null");
  if (op.reviewed !== undefined && typeof op.reviewed !== "boolean")
    fail("VALIDATION", "reviewed须为布尔值");
  const states = {
    requirement: ["requested"],
    assessment: ["unknown", "pending"],
    capability: ["supported", "unsupported"],
  };
  if (!Object.hasOwn(states, op.kind) || !states[op.kind].includes(op.status))
    fail("INVALID_PRODUCT_ASSERTION", "要求、评估与能力的状态不可混用");
  if (context && !["customer", "project"].includes(context.type))
    fail("INVALID_PRODUCT_CONTEXT", "产品断言上下文必须为客户或项目");
  if (op.kind === "requirement" && !context)
    fail("INVALID_PRODUCT_CONTEXT", "客户要求必须指明客户或项目上下文");
  if (op.kind === "capability" && op.reviewed !== true)
    fail(
      "PRODUCT_REVIEW_REQUIRED",
      "能力记录需要明确复核及可匹配的文字证据；服务不会验证技术真实性",
    );
  return {
    op: "set_fact",
    entityId: entity.id,
    key: PRODUCT_ASSERTION_PREFIX + op.kind + ":" + op.key,
    value: {
      kind: op.kind,
      status: op.status,
      statement: op.statement,
      conditions: op.conditions ?? null,
      contextEntityId: context?.id ?? null,
      reviewed: op.kind === "capability",
      automaticInheritance: false,
    },
    classification: {
      requirement: "customer_claim",
      assessment: "inference",
      capability: "verified",
    }[op.kind],
    evidence: op.evidence,
    ...(op.expectedVersion === undefined
      ? {}
      : { expectedVersion: op.expectedVersion }),
  };
}
