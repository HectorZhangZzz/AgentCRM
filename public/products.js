import {
  productTypes,
  assertionKinds,
  assertionStates,
  escapeHtml as e,
  validateDraft,
  createSubmission,
} from "./product-workflow.mjs";
const $ = (s) => document.querySelector(s),
  content = $("#product-content"),
  dialog = $("#product-dialog");
const state = {
  role: null,
  enabled: false,
  route: 0,
  draft: null,
  job: null,
  busy: false,
  contexts: [],
  materials: [],
  current: null,
  error: null,
};
const date = (x) =>
  x ? new Date(x).toLocaleString("zh-CN", { hour12: false }) : "未知";
const listUrl = (type = "product", q = "", page = 0) =>
  "#/products?" + new URLSearchParams({ type, q, page: String(page) });
const detailUrl = (id) => "#/entity/" + encodeURIComponent(id);
const notice = (text, error = false) => {
  $("#product-notice").textContent = text;
  $("#product-notice").className = "notice" + (error ? " error" : "");
};
async function request(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error("连接中断或未收到响应。请保留当前输入并重试核对。");
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("未收到完整响应。请保留当前草稿并核对或重试同一提交。");
  }
  if (!res.ok) {
    const err = new Error(data.error?.message || "请求失败");
    err.code = data.error?.code;
    err.status = res.status;
    err.details = data.error?.details;
    throw err;
  }
  return data;
}
const call = (name, args = {}) => request("/api/v1/tools/" + name, args);
const all = async (name, args = {}) => {
  let items = [],
    offset = 0,
    total;
  do {
    const r = await call(name, { ...args, limit: 200, offset });
    items.push(...r.items);
    offset += r.items.length;
    total = r.total;
    if (!r.items.length) break;
  } while (offset < total);
  if (items.length !== total)
    throw new Error("列表读取不完整，请重试后再选择关联对象。");
  return items;
};
function banner() {
  $("#draft-banner").hidden = !state.draft;
  $("#draft-banner span").textContent =
    state.job && !state.safeToEdit
      ? "当前提交内容和归属已固定，请继续核对同一提交；不要另建重复记录。"
      : "保留了一份未提交草稿，仅在此标签页内保存。";
  $("#resume-draft").disabled = state.role === "reader" || !state.enabled;
  $("#discard-draft").disabled =
    state.busy || (!!state.job && !state.safeToEdit);
}
function sourceButtons(evidence = []) {
  return evidence
    .map(
      (ev) =>
        `<button type="button" class="evidence" data-evidence="${e(ev.id)}">查看原文依据</button>`,
    )
    .join("");
}
const contextName = (id) =>
  state.contexts.find((x) => x.id === id)?.name || id || "未指定上下文";
function unavailable(title, text, button = "重新核对") {
  content.innerHTML = `<section class="unavailable"><h2>${e(title)}</h2><p>${e(text)}</p><button id="retry-session" class="secondary">${e(button)}</button><p class="muted"><a href="/">返回原客户工作台</a></p></section>`;
  $("#retry-session").onclick = start;
}
async function start() {
  try {
    const nonce = new URLSearchParams(location.hash.slice(1)).get("login");
    if (nonce) {
      history.replaceState(null, "", location.pathname + listUrl());
      await request("/api/session", { login: nonce });
    }
    const session = await request("/api/session");
    state.role = session.role;
    $("#product-identity").textContent = {
      reader: "只读身份 · 不可新增",
      writer: "录入身份 · 带依据保存",
      owner: "本机管理身份",
    }[state.role];
    const health = await request("/api/v1/status");
    $("#preview-banner").hidden = health.previewOnly !== true;
    state.enabled = health.features?.productLibrary === true;
    $("#new-product").hidden = !state.enabled || state.role === "reader";
    if (!state.enabled) {
      unavailable(
        "产品资料库尚未启用",
        "当前实例未启用产品工具。客户、材料和待办入口仍可使用；此页面不会开启配置或执行迁移。",
      );
      return;
    }
    state.contexts = (
      await Promise.all(
        ["customer", "project"].map((type) => all("crm_entities", { type })),
      )
    ).flat();
    await route();
  } catch (err) {
    state.enabled = false;
    $("#new-product").hidden = true;
    unavailable(
      err.status === 401 ? "请先登录产品资料库" : "暂时无法连接资料库",
      err.status === 401
        ? "会话未登录或已过期。请使用本机一次性登录链接；未提交草稿仍留在此标签页。"
        : err.message,
    );
  }
}
async function route() {
  const token = ++state.route;
  if (!state.enabled) return;
  if (dialog.open && !state.busy) dialog.close();
  const hash = location.hash.slice(1) || "/products";
  const [path, search = ""] = hash.split("?");
  const q = new URLSearchParams(search);
  state.current = null;
  content.innerHTML = '<p class="muted">正在读取已保存记录…</p>';
  try {
    if (path.startsWith("/entity/")) {
      const id = decodeURIComponent(path.slice(8));
      const d = await call("crm_product", { entityId: id });
      let ancestors = d.parents;
      if (d.entity.type === "product_version" && d.parents.length) {
        const parent = await call("crm_product", { entityId: d.parents[0].id });
        ancestors = [...parent.parents, ...d.parents];
      }
      if (token !== state.route) return;
      state.current = d;
      renderDetail(d, ancestors);
    } else {
      const type = Object.hasOwn(productTypes, q.get("type"))
        ? q.get("type")
        : "product";
      const query = q.get("q") || "";
      const page = Math.max(0, Number(q.get("page")) || 0);
      const [data, ...counts] = await Promise.all([
        call("crm_entities", { type, query, limit: 20, offset: page * 20 }),
        ...Object.keys(productTypes).map((type) =>
          call("crm_entities", { type, limit: 1 }),
        ),
      ]);
      if (token !== state.route) return;
      renderList(type, query, page, data, counts);
    }
  } catch (err) {
    if (token !== state.route) return;
    content.innerHTML = `<section class="unavailable"><h2>这次读取没有完成</h2><p>${e(err.message)}</p><button id="retry-route" class="secondary">重试当前页面</button><p><a href="${e(listUrl())}">返回产品列表</a></p></section>`;
    $("#retry-route").onclick = () => route();
  }
  banner();
}
function renderList(type, q, page, data, counts) {
  content.innerHTML = `<p class="product-intro">从产品到型号、再到版本，保留各自资料与适用边界。客户提出的指标、待验证判断和来源支持的能力分别记录。</p><div class="product-stats">${Object.entries(
    productTypes,
  )
    .map(
      ([t, label], i) =>
        `<span><strong>${counts[i].total}</strong>${label}</span>`,
    )
    .join(
      "",
    )}</div><nav class="product-tabs" aria-label="产品类型">${Object.entries(
    productTypes,
  )
    .map(
      ([t, label]) =>
        `<a href="${e(listUrl(t, q))}" ${t === type ? 'aria-current="page"' : ""}>${label}</a>`,
    )
    .join(
      "",
    )}</nav><form id="product-search-form" class="product-search"><input id="product-search" aria-label="搜索产品资料" placeholder="查找${e(productTypes[type])}名称、别名或已有事实" value="${e(q)}"><button class="secondary">搜索</button></form>${state.role === "reader" ? '<p class="scope-warning">当前为只读身份，可以查看来源和关联；新增入口不可用。</p>' : ""}${data.items.length ? `<section class="panel"><div class="row"><h3>${e(productTypes[type])}列表</h3><span class="muted">${data.total} 条匹配</span></div><div class="table-scroll"><table class="product-table"><thead><tr><th>名称与身份</th><th>已确认别名</th><th>查看</th></tr></thead><tbody>${data.items.map((item) => `<tr><td><a href="${e(detailUrl(item.id))}">${e(item.name)}</a><div class="object-id">${e(item.id)}</div></td><td>${e(item.aliases?.join("、") || "未记录")}</td><td><a href="${e(detailUrl(item.id))}" aria-label="打开${e(item.name)}">查看详情 →</a></td></tr>`).join("")}</tbody></table></div></section>` : `<div class="empty"><h2>${q ? "没有找到匹配记录" : "还没有" + e(productTypes[type]) + "资料"}</h2><p>${q ? "换一个名称、别名或类型继续查找。" : "从一份有明确来源的资料开始建立层级；不会自动写入示例。"}</p></div>`}<div class="pagination">${page > 0 ? `<a href="${e(listUrl(type, q, page - 1))}">← 上一页</a>` : "<span></span>"}<span class="muted">第 ${page + 1} 页 · 每页 20 条</span>${(page + 1) * 20 < data.total ? `<a href="${e(listUrl(type, q, page + 1))}">下一页 →</a>` : "<span></span>"}</div>`;
  $("#product-search-form").onsubmit = (event) => {
    event.preventDefault();
    const target = listUrl(type, $("#product-search").value.trim());
    if (location.hash === target) route();
    else location.hash = target;
  };
}
function renderAssertion(f) {
  return `<article class="assertion-item"><span class="pill ${f.value.kind === "requirement" ? "warn" : f.value.kind === "assessment" ? "gray" : ""}">${e(assertionStates[f.value.status])}</span><strong>${e(f.key.split(":").slice(2).join(":"))}</strong><p>${e(f.value.statement)}</p><p class="muted">条件：${e(f.value.conditions || "未记录，不能推断通用适用")}<br>上下文：${e(contextName(f.value.contextEntityId))}</p>${sourceButtons(f.evidence)}${f.history.length > 1 ? `<details><summary>${f.history.length} 个历史版本</summary>${f.history.map((h) => `<p>v${h.version} · ${e(assertionStates[h.value.status] || h.value.status)} · ${e(h.value.statement)} · ${e(date(h.createdAt))}</p>`).join("")}</details>` : ""}</article>`;
}
function renderDetail(d, ancestors) {
  if (
    state.saved?.entityId === d.entity.id &&
    d.materials.some((m) => m.id === state.saved.materialId)
  ) {
    notice("已持久保存并回读核验，来源材料 " + state.saved.materialId + "。");
    state.saved = null;
  }
  const type = d.entity.type;
  const next =
    type === "product"
      ? "product_model"
      : type === "product_model"
        ? "product_version"
        : null;
  content.innerHTML = `<div class="product-detail"><nav class="breadcrumb" aria-label="产品层级"><a href="${e(listUrl())}">产品资料库</a>${ancestors.map((a) => `<span>›</span><a href="${e(detailUrl(a.id))}">${e(a.name)}</a>`).join("")}<span>›</span><span>${e(d.entity.name)}</span></nav><div class="product-hero"><div><span class="pill">${e(productTypes[type])}</span><h2>${e(d.entity.name)}</h2><div class="object-id">稳定 ID · ${e(d.entity.id)}</div>${d.entity.aliases?.length ? `<p class="muted">别名：${e(d.entity.aliases.join("、"))}</p>` : ""}</div>${state.role !== "reader" ? `<div class="actions">${next ? `<button id="new-child">＋ 新增${e(productTypes[next])}</button>` : ""}<button id="new-assertion" class="secondary">＋ 记录要求 / 结论</button><button id="new-relation" class="secondary">关联客户 / 项目</button></div>` : '<span class="pill gray">只读查看</span>'}</div><div class="scope-warning">以下仅属于当前${e(productTypes[type])}；不继承父级或其他版本结论。“来源复核能力”表示录入者复核了文字依据，服务不会独立证明技术性能。</div>${d.children.length ? `<section class="panel"><h3>下一级 · ${e(next ? productTypes[next] : "关联身份")}</h3><div class="product-children">${d.children.map((c) => `<a href="${e(detailUrl(c.id))}"><span class="pill">${e(productTypes[c.type])}</span><strong>${e(c.name)}</strong><small class="muted">查看独立资料与依据 →</small></a>`).join("")}</div></section>` : next ? `<section class="panel"><h3>下一级 · ${e(productTypes[next])}</h3><p class="muted">尚无已关联${e(productTypes[next])}。从本页新增会固定所属${e(productTypes[type])}。</p></section>` : ""}<div class="assertion-grid">${[
    ["requirements", "requirement", "客户明确提出的目标，尚不代表产品支持。"],
    ["assessments", "assessment", "未知或待验证的判断，不当成测试通过。"],
    ["capabilities", "capability", "复核文字证据及适用条件，保留结论边界。"],
  ]
    .map(
      ([key, kind, help]) =>
        `<section class="panel"><h3>${e(assertionKinds[kind])} <span class="pill">${d[key].length}</span></h3><p class="section-caption">${e(help)}</p>${d[key].map(renderAssertion).join("") || '<p class="muted">暂无此类记录。</p>'}</section>`,
    )
    .join(
      "",
    )}</div><div class="split"><section class="panel"><h3>资料来源</h3>${sourceButtons(d.entity.evidence)}${d.materials.map((m) => `<div class="row"><div><strong>${e(m.filename)}</strong><p class="muted">${e(m.source || "来源未记录")} · ${e(date(m.occurredAt))}<br>SHA256 · ${e(m.sha256.slice(0, 16))}…</p><button class="text-button" data-material="${e(m.id)}">查看原件与来源</button></div></div>`).join("") || '<p class="muted">没有已关联材料。</p>'}</section><section class="panel"><h3>关联客户与项目</h3><p class="form-help">关联仅表示资料相关，不代表已采购、选型或完成适配。</p>${[...d.customers, ...d.projects].map((item) => `<div class="row"><div><strong>${e(item.name)}</strong><p class="muted">${item.type === "customer" ? "客户" : "项目"} · ${e(item.id)}</p></div></div>`).join("") || '<p class="muted">尚无直接关联。</p>'}${d.relations
    .filter((r) => r.kind === "uses_product")
    .map((r) => sourceButtons(r.evidence))
    .join(
      "",
    )}</section></div>${d.facts.length ? `<section class="panel"><h3>其他来源事实</h3><p class="muted">这些通用事实不自动作为产品能力。</p>${d.facts.map((f) => `<p><strong>${e(f.key)}</strong> · ${e(typeof f.value === "object" ? JSON.stringify(f.value) : f.value)} ${sourceButtons(f.evidence)}</p>`).join("")}</section>` : ""}<p class="muted">本页支持新增与回读。修改已有结论、名称或复杂归属请使用现有领域工具复核；冲突保留在客户工作台的“变更与冲突”。</p></div>`;
  if ($("#new-child"))
    $("#new-child").onclick = () =>
      newDraft("hierarchy", {
        type: next,
        parentId: d.entity.id,
        target: d.entity.name,
      });
  if ($("#new-assertion"))
    $("#new-assertion").onclick = () =>
      newDraft("assertion", { entityId: d.entity.id, target: d.entity.name });
  if ($("#new-relation"))
    $("#new-relation").onclick = () =>
      newDraft("relation", { entityId: d.entity.id, target: d.entity.name });
}
async function newDraft(mode, initial = {}) {
  if (state.draft) {
    notice("已有未提交草稿，请先继续或明确丢弃；不会覆盖原输入。", true);
    banner();
    return;
  }
  state.draft = {
    mode,
    type: "product",
    name: "",
    modelName: "",
    versionName: "",
    key: "",
    kind: "requirement",
    status: "requested",
    statement: "",
    conditions: "",
    contextId: "",
    reviewed: false,
    source: { text: "", quote: "", label: "", materialId: null },
    sourceMode: "paste",
    ...initial,
  };
  state.job = null;
  state.error = null;
  state.safeToEdit = false;
  await openDraft();
}
const options = (items, current) =>
  items
    .map(
      ([value, label]) =>
        `<option value="${e(value)}" ${current === value ? "selected" : ""}>${e(label)}</option>`,
    )
    .join("");
async function openDraft() {
  if (!state.draft || state.role === "reader" || !state.enabled) return;
  {
    try {
      state.materials = await all("crm_materials");
    } catch (err) {
      notice("材料列表暂未读取，可粘贴原始文字；" + err.message, true);
    }
  }
  renderForm();
  if (!dialog.open) dialog.showModal();
  banner();
}
function renderForm() {
  const d = state.draft,
    locked = !!state.job;
  const title =
    d.mode === "hierarchy"
      ? "建立" + productTypes[d.type]
      : d.mode === "assertion"
        ? "记录要求或结论"
        : "关联客户 / 项目";
  const contextOptions = [
    ["", "请选择明确的客户或项目"],
    ...state.contexts.map((item) => [
      item.id,
      (item.type === "customer" ? "客户" : "项目") + " · " + item.name,
    ]),
  ];
  const fields =
    d.mode === "hierarchy"
      ? `<label>${e(productTypes[d.type])}名称<input name="name" value="${e(d.name)}" autocomplete="off"></label>${d.type === "product" ? `<label>型号名称（可选）<input name="modelName" value="${e(d.modelName)}"></label>` : ""}${d.type !== "product_version" ? `<label>版本名称（可选，需有明确型号）<input name="versionName" value="${e(d.versionName)}"></label>` : ""}`
      : d.mode === "assertion"
        ? `<div class="form-split"><label>记录类别<select name="kind">${options(Object.entries(assertionKinds), d.kind)}</select></label><label>当前状态<select name="status">${options(
            {
              requirement: ["requested"],
              assessment: ["unknown", "pending"],
              capability: ["supported", "unsupported"],
            }[d.kind].map((k) => [k, assertionStates[k]]),
            d.status,
          )}</select></label></div><label>记录主题<input name="key" value="${e(d.key)}" placeholder="如 4K30解码，不含空格或冒号"></label><label>实际要求或结论<textarea name="statement">${e(d.statement)}</textarea></label><label>适用或测试条件${d.kind === "capability" ? "（必填）" : "（未知可留空）"}<input name="conditions" value="${e(d.conditions)}"></label><label>客户 / 项目上下文${d.kind === "requirement" ? "（必选）" : "（可选）"}<select name="contextId">${options(contextOptions, d.contextId)}</select></label>${d.kind === "capability" ? `<label class="check-label"><input name="reviewed" type="checkbox" ${d.reviewed ? "checked" : ""}>我已复核文字依据及条件；客户自述、产品要求或二进制定位不能直接当成实测能力。</label>` : ""}`
        : `<label>要关联的客户或项目<select name="contextId">${options(contextOptions, d.contextId)}</select></label><p class="form-help">仅增加有依据的资料关联，不创建订单、销售项目或待办。</p>`;
  $("#product-form-content").innerHTML =
    `<h2 id="form-title">${e(title)}</h2><div class="product-form-target"><small>固定归属对象</small><strong>${e(d.target || "新产品及其可选下级")}</strong><span class="object-id">${e(d.parentId || d.entityId || "保存后获得独立 ID")}</span></div><form id="product-form" class="product-form" novalidate><fieldset ${locked || state.busy ? "disabled" : ""}>${fields}<section class="evidence-fields"><h3>原始文字依据</h3><label>材料方式<select name="sourceMode">${options(
      [
        ["paste", "粘贴原始文字"],
        ["existing", "引用已保存的文字材料"],
      ],
      d.sourceMode,
    )}</select></label>${
      d.sourceMode === "existing"
        ? `<label>已保存材料<select name="materialId"><option value="">请选择可读取的文字材料</option>${state.materials
            .filter(
              (m) =>
                m.extractionStatus !== "unprocessed_binary" &&
                m.byteLength <= 33554432,
            )
            .map(
              (m) =>
                `<option value="${e(m.id)}" ${m.id === d.source.materialId ? "selected" : ""}>${e(m.filename)} · ${e(m.source || "来源未知")}</option>`,
            )
            .join("")}</select></label>`
        : `<label>来源说明<input name="label" value="${e(d.source.label)}" placeholder="如产品手册、客户原话或测试记录"></label>`
    }<label>原始文字<textarea name="text" ${d.sourceMode === "existing" ? "readonly" : ""}>${e(d.source.text)}</textarea></label><label>准确引文<textarea name="quote" placeholder="从原文复制能支持本次记录的一段连续文字">${e(d.source.quote)}</textarea></label><p class="form-help">引文必须与原文逐字相符，并支持所填名称、关系或结论。服务不代替技术核验；此页不自动读取图片或 Office 全文。</p></section></fieldset><div id="form-error" class="form-error" role="alert">${e(state.error || "")}</div><p id="submit-stage" class="form-help">${locked ? "本次内容和归属已固定；重试会核对同一提交，不另建记录。" : ""}</p><button id="save-product" type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? "正在保存，请勿关闭…" : locked ? "核对并重试同一提交" : "保存并回读"}</button>${locked && !state.busy && state.safeToEdit ? '<button id="edit-again" type="button" class="secondary">返回编辑</button>' : ""}</form>`;
  $("#cancel-draft").disabled = state.busy;
  $("#product-form").onsubmit = submitDraft;
  banner();
  if ($("#edit-again"))
    $("#edit-again").onclick = () => {
      state.job = null;
      state.error = null;
      state.safeToEdit = false;
      renderForm();
    };
}
async function submitDraft(event) {
  event.preventDefault();
  if (state.busy) return;
  state.error = null;
  try {
    validateDraft(state.draft);
    if (!state.job)
      state.job = createSubmission(call, state.draft, crypto.randomUUID());
  } catch (err) {
    $("#form-error").textContent = err.message;
    return;
  }
  state.busy = true;
  renderForm();
  try {
    const result = await state.job.submit();
    if (result.status === "conflict") {
      state.error =
        "已保存新旧差异，未覆盖原结论。请到客户工作台“变更与冲突”审阅；本页不自动解决冲突。材料 ID：" +
        result.materialId;
      state.safeToEdit = true;
      return;
    }
    const target = result.focusId;
    const materialId = result.materialId;
    state.saved = { entityId: target, materialId };
    state.draft = null;
    state.job = null;
    state.error = null;
    dialog.close();
    banner();
    notice("已持久保存，正在回读对应对象；读取失败时可重试，不需再次提交。");
    if (location.hash !== detailUrl(target))
      history.pushState(null, "", detailUrl(target));
    await route();
  } catch (err) {
    const uncertain = state.job.state().uncertain;
    state.error =
      err.message +
      (uncertain
        ? "\n此前提交结果尚未核对，这不表示原保存失败。请保持原内容、归属和同一提交重试，不可返回编辑或丢弃。"
        : "");
    if (err.status === 401)
      state.error +=
        "\n请在另一个标签页重新登录，再回此页重试；不要刷新当前草稿。";
    state.safeToEdit =
      !uncertain && [400, 401, 403, 404, 409, 413].includes(err.status);
    if (err.details?.candidates?.length)
      state.error +=
        "\n已有候选：" +
        err.details.candidates
          .map((c) => c.name + "（" + c.id + "）")
          .join("、");
  } finally {
    state.busy = false;
    if (state.draft) renderForm();
  }
}
$("#product-form-content").addEventListener("input", (event) => {
  if (!state.draft || state.job) return;
  const { name, type, checked, value } = event.target;
  if (!name) return;
  if (["text", "quote", "label"].includes(name))
    state.draft.source[name] = value;
  else if (!["sourceMode", "materialId", "kind"].includes(name))
    state.draft[name] = type === "checkbox" ? checked : value;
});
$("#product-form-content").addEventListener("change", async (event) => {
  if (!state.draft || state.job) return;
  const { name, value } = event.target;
  const d = state.draft;
  if (name === "kind") {
    d.kind = value;
    d.status = {
      requirement: "requested",
      assessment: "unknown",
      capability: "supported",
    }[value];
    d.reviewed = false;
    renderForm();
  } else if (name === "sourceMode") {
    d[d.sourceMode + "Source"] = structuredClone(d.source);
    d.sourceMode = value;
    d.source = structuredClone(
      d[value + "Source"] || {
        text: "",
        quote: "",
        label: "",
        materialId: null,
      },
    );
    renderForm();
  } else if (name === "materialId") {
    d.source = { text: "", quote: "", label: "", materialId: null };
    if (!value) {
      renderForm();
      return;
    }
    state.busy = true;
    renderForm();
    try {
      const m = await call("crm_material", {
        materialId: value,
        includeContent: true,
      });
      if (typeof m.content?.text !== "string")
        throw new Error("该材料没有可读取文字，请由宿主提取复核后再引用。");
      d.source = {
        text: m.content.text,
        quote: "",
        label: m.material.source || m.material.filename,
        materialId: value,
      };
      state.error = null;
    } catch (err) {
      state.error = err.message;
    } finally {
      state.busy = false;
      renderForm();
    }
  }
});
$("#new-product").onclick = () => newDraft("hierarchy");
$("#resume-draft").onclick = openDraft;
$("#discard-draft").onclick = () => {
  if (state.busy || (state.job && !state.safeToEdit)) return;
  state.draft = null;
  state.job = null;
  state.error = null;
  dialog.close();
  banner();
};
$("#cancel-draft").onclick = () => {
  if (!state.busy) {
    dialog.close();
    banner();
  }
};
dialog.addEventListener("cancel", (event) => {
  if (state.busy) event.preventDefault();
});
$("#source-close").onclick = () => $("#source-dialog").close();
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-evidence],[data-material]");
  if (!button) return;
  const sourceDialog = $("#source-dialog");
  $("#source-content").innerHTML =
    '<h2 id="source-title">原始依据</h2><p>正在读取…</p>';
  if (!sourceDialog.open) sourceDialog.showModal();
  try {
    if (button.dataset.evidence) {
      const d = await call("crm_evidence", {
        evidenceId: button.dataset.evidence,
      });
      $("#source-content").innerHTML =
        `<h2 id="source-title">原始依据</h2><p>${e(d.material.filename)}</p><blockquote>${e(d.evidence.quote)}</blockquote><p class="muted">定位：${e(JSON.stringify(d.evidence.locator))}</p><a href="/api/v1/materials/${e(d.material.id)}/content" download>下载原始材料</a>`;
    } else {
      const d = await call("crm_material", {
        materialId: button.dataset.material,
      });
      $("#source-content").innerHTML =
        `<h2 id="source-title">原件与来源</h2><h3>${e(d.material.filename)}</h3><p class="source-context">${e(d.material.source || "来源未记录")}</p><p class="object-id">SHA256 · ${e(d.material.sha256)}</p><p class="muted">保存原件不等于已解析全文。</p><a href="/api/v1/materials/${e(d.material.id)}/content" download>下载原始材料</a>`;
    }
  } catch (err) {
    $("#source-content").innerHTML =
      `<h2 id="source-title">依据暂未读取</h2><p class="form-error">${e(err.message)}</p>`;
  }
});
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).get("login")) {
    if (state.busy) {
      notice("保存正在进行，请等待同一提交完成后再恢复会话。", true);
      return;
    }
    start();
    return;
  }
  if (state.busy) {
    notice("保存仍在进行；请勿提交其他对象，原归属和草稿已固定。");
    return;
  }
  route();
});
window.addEventListener("beforeunload", (event) => {
  if (state.draft) {
    event.preventDefault();
    event.returnValue = "";
  }
});
start();
