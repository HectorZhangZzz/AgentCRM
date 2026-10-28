const $ = (s) => document.querySelector(s);
const MAX_MATERIAL_BYTES = 500_000_000;
const MAX_INLINE_BYTES = 32 * 1024 * 1024;
const e = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
const fieldLabels = {
  agent_quantity: "智能体数量",
  annual_device_forecast: "年度设备预测",
  purchase_quantity_clarification: "数量口径",
  quote_status: "报价进度",
  sample_device_quantity: "样品设备数量",
  device_demand: "设备需求",
  order_status: "订单状态",
  progress_status: "项目进度",
  ddr_spec_check: "DDR 规格核对",
  next_visit_at: "下次拜访时间",
  communication_role: "已知沟通职责",
  annualForecast: "年度预测",
  quantity: "数量",
  unit: "单位",
  certainty: "确定程度",
  orderEvidence: "订单依据",
  purchaseCommitment: "采购承诺",
  deviceQuantity: "是否设备数量",
  min: "最少",
  max: "最多",
};
const fieldLabel = (key) => fieldLabels[key] || key;
const value = (x) => {
  if (x === null || x === undefined) return "未知";
  if (typeof x === "boolean") return x ? "是" : "否";
  if (Array.isArray(x)) return x.map(value).join("、");
  if (typeof x === "object") {
    const used = new Set();
    let head = "";
    if (x.min !== undefined && x.max !== undefined) {
      head = `${x.min}～${x.max}${x.unit || ""}`;
      ["min", "max", "unit"].forEach((k) => used.add(k));
    } else if (x.quantity !== undefined && x.unit) {
      head = `${x.quantity}${x.unit}`;
      ["quantity", "unit"].forEach((k) => used.add(k));
    }
    const rest = Object.entries(x)
      .filter(([k]) => !used.has(k))
      .map(([k, v]) => fieldLabel(k) + "：" + value(v));
    return [head, ...rest].filter(Boolean).join("；");
  }
  if (
    typeof x === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(x) &&
    !Number.isNaN(Date.parse(x))
  )
    return date(x);
  return String(x);
};
const actionLabels = {
  material_link: "关联材料",
  material_ingest: "保存原件",
  material_receipt: "记录来源",
  material_duplicate_receipt: "识别重复材料",
  fact_set: "更新结论",
  task_create: "建立待办",
  task_update: "更新待办",
  entity_create: "建立档案",
  relation_create: "建立关联",
  material_reassign: "纠正归属",
  reassign_object: "纠正记录归属",
  proposal_commit: "提交更新",
  proposal_conflict: "保留信息冲突",
  evidence_create: "保存原文依据",
};
const statusLabels = {
  todo: "待办",
  in_progress: "进行中",
  awaiting_feedback: "待反馈",
  on_hold: "暂缓",
  completed: "已完成",
  cancelled: "已取消",
};
const classLabels = {
  user_provided: "用户提供",
  customer_claim: "客户自述",
  verified: "已核验",
  inference: "推测",
  suggestion: "建议",
};
const typeLabels = {
  customer: "客户",
  project: "项目",
  contact: "联系人",
  organization: "关联组织",
  issue: "技术/供应链问题",
};
const partyLabels = {
  self: "我的行动",
  colleague: "同事行动",
  customer: "客户承诺",
  waiting: "等待反馈",
};
let view = "customers",
  selectedCustomer = null,
  role = "reader";
async function request(
  url,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error?.message || "请求失败");
    error.details = data.error?.details;
    throw error;
  }
  return data;
}
const call = (name, args = {}) => request("/api/v1/tools/" + name, args);
function notice(text, error = false) {
  $("#notice").textContent = text;
  $("#notice").className = "notice" + (error ? " error" : "");
}
function modal(content) {
  $("#modal-content").innerHTML = content;
  $("#modal").showModal();
}
$("#modal-close").onclick = () => $("#modal").close();
function refs(list = []) {
  return list
    .map(
      (ev) =>
        `<button class="evidence" data-evidence="${e(ev.id)}">原文依据 · ${e(ev.id.slice(0, 7))}</button>`,
    )
    .join("");
}
function coverage(c = {}) {
  return `<div class="cover">覆盖 ${e(c.materialsIncluded ?? 0)} 份已关联材料 · 状态更新至 ${e(date(c.updatedThrough))}<br>${e(c.scope || "仅本机已有材料，不代表完整客户历史")}。${c.missing?.length ? `存在 ${c.missing.length} 项时间/内容缺失或未提取标记。` : ""}</div>`;
}
const empty = (title, text) =>
  `<div class="empty"><h2>${e(title)}</h2><p>${e(text)}</p></div>`;
async function load() {
  $("#notice").classList.add("hidden");
  $("#page-title").textContent = {
    customers: "客户与项目",
    inbox: "材料收件箱",
    tasks: "行动与承诺",
    changes: "变更与冲突",
    settings: "数据与交接",
  }[view];
  $("#nav")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  try {
    await {
      customers: customers,
      inbox: inbox,
      tasks: tasks,
      changes: changes,
      settings: settings,
    }[view]();
  } catch (err) {
    notice(err.message, true);
  }
}
async function customers(query = "") {
  const data = await call("crm_entities", {
    type: "customer",
    query,
    limit: 100,
  });
  $("#content").innerHTML =
    `<p class="muted">一客一档，一项目一卡。重要结论保留来源，未知内容保持未知。</p><div class="toolbar"><input id="customer-search" placeholder="搜索客户名称或已确认的别名" value="${e(query)}"><button id="search-go" class="secondary">搜索</button></div>${data.items.length ? `<div class="grid">${data.items.map((c) => `<article class="card"><div class="monogram">${e(c.name.slice(0, 1))}</div><h3>${e(c.name)}</h3><p class="muted">${c.aliases?.length ? "别名：" + e(c.aliases.join("、")) : "稳定档案 · " + e(c.id.slice(0, 8))}</p><button class="text-button" data-customer="${e(c.id)}">查看客户全景 →</button></article>`).join("")}</div>` : empty("从一份材料，开始积累", "先在材料收件箱录入沟通文字、截图或文件，再由已连接的 Agent 识别归属并更新客户档案。也可以先建立客户。")}<footer>按原名与明确别名检索；同音名称不会自动合并。${data.total > 100 ? "当前仅显示前 100 个匹配客户，请缩小搜索范围。" : ""}</footer>`;
  $("#search-go").onclick = () =>
    customers($("#customer-search").value).catch((err) =>
      notice(err.message, true),
    );
  $("#customer-search").onkeydown = (event) => {
    if (event.key === "Enter") $("#search-go").click();
  };
}
async function customer(id) {
  selectedCustomer = id;
  const d = await call("crm_customer", { entityId: id });
  const facts = (d.facts || [])
    .map(
      (f) =>
        `<div class="fact"><div class="key">${e(fieldLabel(f.key))}${f.entityId !== id ? ` · ${e(d.projects.find((p) => p.id === f.entityId)?.name || "关联实体")}` : ""}</div><div class="value">${e(value(f.value))}</div><span class="pill ${f.classification === "customer_claim" ? "warn" : ""}">${e(classLabels[f.classification] || f.classification)}</span>${refs(f.evidence)}${f.history?.length > 1 ? `<details><summary>查看 ${f.history.length} 个历史版本</summary>${f.history.map((h) => `<p>v${h.version} · ${e(value(h.value))} · ${e(date(h.createdAt))}</p>`).join("")}</details>` : ""}${role === "owner" ? `<button class="text-button" data-correct-fact="${e(f.id)}">更正该结论</button>` : ""}</div>`,
    )
    .join("");
  $("#content").innerHTML =
    `<button class="text-button" id="back-customers">← 返回客户列表</button><div class="detail-title"><h2>${e(d.entity.name)}</h2><span class="pill">${e(typeLabels[d.entity.type])}</span></div>${coverage(d.coverage)}<div class="split"><div><section class="panel"><h3>当前结论与证据</h3>${facts || '<p class="muted">还没有带来源的结构化结论。请让 Agent 处理收件箱材料。</p>'}</section><section class="panel"><h3>主要项目</h3>${d.projects.map((p) => `<div class="row"><div><strong>${e(p.name)}</strong><p class="muted">项目 ID：${e(p.id)}</p></div><span class="pill">独立项目</span></div>`).join("") || '<p class="muted">尚无项目记录。</p>'}</section><section class="panel"><h3>关键人与关联组织</h3>${[...d.contacts, ...(d.organizations || [])].map((c) => `<div class="row"><div><strong>${e(c.name)}</strong><p class="muted">${e(typeLabels[c.type])} · 职务以有来源的记录为准</p>${(c.facts || []).map((f) => `<p>${e(fieldLabel(f.key))}：${e(value(f.value))} ${refs(f.evidence)}</p>`).join("")}</div></div>`).join("") || '<p class="muted">尚无联系人记录；不会补造姓名或职务。</p>'}</section></div><div><section class="panel"><h3>未完成行动与承诺 <span class="pill">${d.tasks.length}</span></h3>${renderTasks(d.tasks)}</section><section class="panel"><h3>沟通与原始材料</h3>${d.materials.map((m) => `<div class="row"><div><strong>${e(m.filename)}</strong><p class="muted">沟通：${e(date(m.occurredAt))}<br>录入：${e(date(m.createdAt))}</p><button class="text-button" data-material="${e(m.id)}">查看原文和归属</button></div></div>`).join("") || '<p class="muted">还没有关联材料。</p>'}</section><section class="panel"><h3>技术与供应链问题</h3>${d.issues.map((i) => `<p><strong>${e(i.name)}</strong></p>${(i.facts || []).map((f) => `<p>${e(fieldLabel(f.key))}：${e(value(f.value))}${refs(f.evidence)}</p>`).join("")}`).join("") || '<p class="muted">没有已记录的问题；不等于已核实无问题。</p>'}</section></div></div><section class="panel"><h3>变更时间线</h3><div class="timeline">${
      d.timeline
        .slice(-30)
        .reverse()
        .map(
          (x) =>
            `<p>${e(date(x.createdAt))} · ${e(actionLabels[x.action] || "记录更新")} · ${e(x.actor.includes("writer") ? "Agent 录入" : x.actor.includes("owner") ? "本机用户" : x.actor)}<details><summary>查看变更数据</summary><pre>${e(JSON.stringify(x.detail, null, 2))}</pre></details></p>`,
        )
        .join("") || "<p>暂无变更。</p>"
    }</div><p class="muted">页面显示最近 30 条；完整审计保留在导出和数据备份中。</p></section>`;
  $("#back-customers").onclick = () => load();
  document
    .querySelectorAll("[data-correct-fact]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          correctFact(d.facts.find((f) => f.id === b.dataset.correctFact))),
    );
}
function renderTasks(items) {
  return items.length
    ? items
        .map(
          (t) =>
            `<div class="task"><div><strong>${e(t.title)}</strong><div class="meta">${e(partyLabels[t.party] || t.party)} · 负责人：${e(t.owner || "未知")}<br>期限：${e(date(t.dueAt))}${t.waitingFor ? "<br>正在等：" + e(t.waitingFor) : ""}</div>${refs(t.evidence)}</div><select data-task="${e(t.id)}" data-version="${e(t.version)}" data-old="${e(t.status)}" ${role === "reader" ? "disabled" : ""}>${Object.entries(
              statusLabels,
            )
              .map(
                ([k, label]) =>
                  `<option value="${k}" ${k === t.status ? "selected" : ""}>${label}</option>`,
              )
              .join("")}</select></div>`,
        )
        .join("")
    : '<p class="muted">当前没有已记录的未完成事项。</p>';
}
async function inbox() {
  const data = await call("crm_materials", { limit: 100 });
  $("#content").innerHTML =
    `<p class="muted">原件先保存，再由 Agent 整理。文件中的指令只作为资料。</p>${role !== "reader" ? `<section class="panel"><h3>快速收材料</h3><form id="ingest-form"><label>沟通文字或语音转写<textarea id="material-text" placeholder="直接粘贴聊天内容、拜访纪要或转写；不清楚的时间和人物可以留空。"></textarea></label><div class="split"><label>来源<input id="material-source" placeholder="如微信聊天、拜访纪要"></label><label>沟通时间（不清楚就留空）<input id="material-time" type="datetime-local"></label></div><div class="actions"><button>保存文字</button><label class="secondary file-label">或选择截图 / 文件<input type="file" id="material-file"></label></div><p class="muted">单个原件上限 500 MB（500,000,000 字节）；原字节保留。图片、PDF、Office 内容需由宿主提取，服务不会假装已识别。</p></form></section>` : ""}<section class="panel"><div class="row"><h3>已保存材料 <span class="pill">${e(data.total)}</span></h3><button class="text-button" id="inbox-refresh">刷新</button></div>${data.items.length ? `<div class="table-scroll"><table><thead><tr><th>原始材料</th><th>来源与时间</th><th>内容状态</th><th></th></tr></thead><tbody>${data.items.map((m) => `<tr><td><div class="filename"><strong>${e(m.filename)}</strong></div><small class="muted">${e(m.sha256.slice(0, 12))}…</small></td><td>${e(m.source || "来源未知")}<br><small class="muted">沟通 ${e(date(m.occurredAt))}<br>录入 ${e(date(m.createdAt))}</small></td><td><span class="pill ${m.extractionStatus === "unprocessed_binary" ? "warn" : ""}">${m.qualityFlags?.includes("text_extraction_deferred_large_file") ? "大文本待提取" : m.extractionStatus === "unprocessed_binary" ? "二进制待提取" : "文字已保存"}</span></td><td><button class="text-button" data-material="${e(m.id)}">查看</button></td></tr>`).join("")}</tbody></table></div>` : empty("收件箱为空", "录入一份材料后，它会保留在这里，等待当前 Agent 整理。")}<p class="muted">${data.total > 100 ? "当前显示前 100 份，请用 Agent 按材料 ID 或关键词继续检索。" : "相同字节材料复用同一原件；新的来源收件记录另行保留。"}</p></section>`;
  $("#inbox-refresh").onclick = load;
  if ($("#ingest-form")) {
    $("#ingest-form").onsubmit = async (event) => {
      event.preventDefault();
      await busy(async () => {
        const text = $("#material-text").value;
        if (!text.trim()) throw new Error("请先粘贴文字。");
        const result = await call("crm_ingest", {
          text,
          filename:
            "沟通记录-" + new Date().toISOString().slice(0, 10) + ".txt",
          source: $("#material-source").value || "本机文字录入",
          occurredAt: $("#material-time").value
            ? new Date($("#material-time").value).toISOString()
            : null,
        });
        await load();
        notice(
          (result.duplicate
            ? "已识别重复材料，复用原件。"
            : "材料已持久保存。") + " 可让已连接的 Agent 整理收件箱。",
        );
      });
    };
    $("#material-file").onchange = async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      await busy(async () => {
        if (file.size > MAX_MATERIAL_BYTES)
          throw new Error("单个原件上限 500 MB（500,000,000 字节）");
        const q = new URLSearchParams({
          filename: file.name,
          source: $("#material-source").value || "本机文件上传",
        });
        if ($("#material-time").value)
          q.set(
            "occurredAt",
            new Date($("#material-time").value).toISOString(),
          );
        notice("正在保存原件，请等待上传完成。");
        const res = await fetch("/api/v1/upload?" + q, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "上传失败");
        await load();
        notice(
          data.duplicate
            ? "相同文件已存在，已复用原件。"
            : "原件已保存，等待 Agent 提取与归档。",
        );
      });
    };
  }
}
async function tasks() {
  const showCompleted = sessionStorage.getItem("includeCompleted") === "true";
  const d = await call("crm_tasks", {
    includeCompleted: showCompleted,
    limit: 200,
  });
  $("#content").innerHTML =
    `<p class="muted">分清我的行动、同事行动、客户承诺和等待对象。录入待办不会自动开启提醒。</p><div class="toolbar"><label class="inline"><input type="checkbox" id="include-completed" ${showCompleted ? "checked" : ""}>包括已完成和已取消</label></div><section class="panel">${renderTasks(d.items)}</section><footer>${d.total > 200 ? "当前显示前 200 项，请用 Agent 按客户缩小范围。" : "事项状态和来源历史均保留，可随时回查。"}</footer>`;
  $("#include-completed").onchange = () => {
    sessionStorage.setItem("includeCompleted", $("#include-completed").checked);
    load();
  };
}
async function changes() {
  const data = await call("crm_proposals", { limit: 100 });
  $("#content").innerHTML =
    `<p class="muted">普通无冲突更新可以由 Agent 提交；新旧冲突保留差异，由你决定。版本已变化时须重新读取和提交。</p>${data.items.length ? data.items.map((p) => `<section class="panel"><div class="row"><div><h3>更新建议 <small class="muted">${e(p.id.slice(0, 8))}</small></h3><span class="pill ${p.status === "conflict" ? "warn" : ""}">${e({ pending: "待提交", committed: "已提交", conflict: "信息冲突" }[p.status] || p.status)}</span><span class="muted">${e(date(p.createdAt))}</span></div>${p.status !== "committed" && role !== "reader" ? `<button data-commit="${e(p.id)}" data-conflict="${p.status === "conflict"}">${p.status === "conflict" ? "确认采用新信息" : "提交更新"}</button>` : ""}</div>${p.conflicts?.length ? `<pre>${e(JSON.stringify(p.conflicts, null, 2))}</pre>` : ""}<details ${p.status === "conflict" ? "open" : ""}><summary>查看操作、原始依据和版本</summary><pre>${e(JSON.stringify(p.operations, null, 2))}</pre></details></section>`).join("") : empty("暂无建议更新", "让 Agent 读取材料、提出有依据的更新后，处理记录会出现在这里。")}`;
}
async function settings() {
  const d = await request("/api/v1/status");
  $("#content").innerHTML =
    `<section class="panel"><h3>可迁移的本机资料库</h3><div class="statline"><div><strong>v${e(d.version)}</strong>应用版本</div><div><strong>${e(d.contractVersion)}</strong>工具契约</div><div><strong>${d.storage.available ? "正常" : "异常"}</strong>原件存储</div></div><p class="muted">服务不配置模型；使用当前宿主 Agent 的推理能力。当前没有启用定时提醒、邮件发送或公开访问。</p></section><section class="panel"><h3>Twenty CRM 投影</h3><p>普通客户、联系人和项目同步到保留的 Twenty。证据、完整历史和六态待办以本工作台为准。</p><p>状态：${e(d.projection.status)} · 已同步 ${e(d.projection.synced)} 项 · ${e(date(d.projection.lastSyncAt))}</p>${d.projection.errors?.length ? `<pre>${e(JSON.stringify(d.projection.errors, null, 2))}</pre>` : ""}${role === "owner" ? '<button id="sync-projection" class="secondary">重新同步投影</button>' : ""}</section><section class="panel"><h3>备份、导出与交接</h3><p>完整迁移包含数据库、原始材料、应用版本和配置。JSON 导出方便检查与迁移，不代替包含原件的完整备份。</p><pre>./ops/crm backup\n./ops/crm verify &lt;备份目录&gt;\n./ops/crm restore &lt;备份文件&gt; --target &lt;项目外全新目录&gt;</pre><p class="muted">具体命令及跨机器安装见项目 docs/INSTALL.md、docs/MIGRATION.md；交给 dots 时先读 docs/HANDOFF.md 和 AGENTS.md。</p>${role === "owner" ? '<button id="export-json">下载结构化 JSON</button>' : ""}</section><section class="panel soft"><h3>第一次让 Agent 帮你整理</h3><p>连接项目 MCP 与 Skill 后，可以说：“整理材料收件箱，更新客户和项目；只在关键歧义或新旧冲突时问我。”</p><p>之后可问：“这家客户现在什么情况？”“明天拜访应该聊什么？”“还有谁在等我们的回复？”</p><p class="muted">如果宿主尚未连接，本工作台仍可保存原件、查阅记录和进行人工维护，但不会自行调用模型整理。</p></section>`;
  if ($("#sync-projection"))
    $("#sync-projection").onclick = () =>
      busy(async () => {
        await request("/api/v1/projection/sync", {});
        await load();
      });
  if ($("#export-json"))
    $("#export-json").onclick = () =>
      busy(async () => {
        const data = await request("/api/v1/export", {});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], {
            type: "application/json",
          }),
        );
        a.download =
          "agent-crm-" + new Date().toISOString().slice(0, 10) + ".json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
}
async function busy(fn) {
  try {
    await fn();
  } catch (err) {
    notice(
      err.message + (err.details ? " " + JSON.stringify(err.details) : ""),
      true,
    );
  }
}
async function material(id) {
  let d = await call("crm_material", {
    materialId: id,
    includeContent: false,
  });
  const m = d.material;
  const byteLength = Number(m.byteLength ?? m.byteSize ?? m.sizeBytes);
  if (m.extractionStatus === "text_received" && byteLength <= MAX_INLINE_BYTES)
    d = await call("crm_material", { materialId: id, includeContent: true });
  const contentNote = m.qualityFlags?.includes(
    "text_extraction_deferred_large_file",
  )
    ? "大文本原件已保存；正文提取暂缓，请下载原件后分段处理。"
    : "二进制原件已保存；本服务没有自动 OCR 或文档内容核验，须由宿主提取并标记来源位置。";
  modal(
    `<h2>${e(m.filename)}</h2><p class="muted">${e(m.mimeType)} · ${e(m.byteSize ?? m.sizeBytes ?? m.byteLength ?? "")} bytes<br>SHA256：${e(m.sha256)}<br>沟通时间：${e(date(m.occurredAt))} · 录入：${e(date(m.createdAt))}</p><p>归属：${d.entities.map((x) => e(x.name)).join("、") || "尚未归属"}</p>${d.content?.text !== undefined ? `<blockquote>${e(d.content.text)}</blockquote>` : `<p class="muted">${e(contentNote)}</p>`}<div class="actions"><a href="/api/v1/materials/${e(id)}/content" download>下载原件</a>${role === "owner" ? `<button id="reassign-material" class="secondary">纠正材料归属</button>` : ""}</div><details><summary>收件记录与质量标记</summary><pre>${e(JSON.stringify({ receipts: d.receipts, qualityFlags: m.qualityFlags, extractionStatus: m.extractionStatus }, null, 2))}</pre></details>`,
  );
  if ($("#reassign-material"))
    $("#reassign-material").onclick = () => reassign(d);
}
async function reassign(d) {
  const entities = await call("crm_entities", { limit: 200 });
  modal(
    `<h2>纠正材料归属</h2><p>安全移动仅由这份材料支持的事实和待办；涉及其他来源或项目的部分会列为待处理并保留原关联。</p><form id="reassign-form"><label>当前归属<select id="from-entity">${d.entities.map((x) => `<option value="${e(x.id)}">${e(x.name)}</option>`).join("")}</select></label><label>应归属到<select id="to-entity">${entities.items.map((x) => `<option value="${e(x.id)}">${e(x.name)}（${e(typeLabels[x.type])}）</option>`).join("")}</select></label><label>更正原因<input id="reassign-reason" required></label><div class="actions"><button>保存纠正并保留历史</button></div></form>`,
  );
  $("#reassign-form").onsubmit = (event) => {
    event.preventDefault();
    busy(async () => {
      const result = await call("crm_reassign", {
        materialId: d.material.id,
        fromEntityId: $("#from-entity").value,
        toEntityId: $("#to-entity").value,
        reason: $("#reassign-reason").value,
        expectedVersion: d.material.version,
        idempotencyKey: crypto.randomUUID(),
      });
      $("#modal").close();
      await load();
      notice(
        result.pending.length
          ? `已安全处理 ${result.moved.length} 项；${result.pending.length} 项因多源或项目关联需要进一步确认。`
          : "材料归属已纠正，历史已保留。",
      );
    });
  };
}
async function correctFact(f) {
  const next = prompt(
    "输入更正后的值（数字/对象可用 JSON；普通文字直接填写）",
    value(f.value),
  );
  if (next === null) return;
  const reason = prompt("请记录更正依据或原文（会保存为用户提供的材料）");
  if (!reason) return;
  await busy(async () => {
    let parsed;
    try {
      parsed = JSON.parse(next);
    } catch {
      parsed = next;
    }
    const text = `用户更正 ${f.key} 为 ${next}。依据：${reason}`;
    const m = await call("crm_ingest", {
      text,
      filename: "人工更正.txt",
      source: "用户在本机工作台提供的更正",
    });
    const p = await call("crm_propose", {
      idempotencyKey: crypto.randomUUID(),
      materialIds: [m.material.id],
      operations: [
        {
          op: "set_fact",
          entityId: f.entityId,
          key: f.key,
          value: parsed,
          classification: "user_provided",
          expectedVersion: f.version,
          evidence: [
            {
              materialId: m.material.id,
              quote: text,
              locator: { kind: "text" },
            },
          ],
        },
      ],
    });
    const result = await call("crm_commit", { proposalId: p.proposal.id });
    if (result.status === "conflict") {
      view = "changes";
      await load();
      notice("新旧信息已保留，请查看差异后决定是否采用新信息。");
    } else await customer(selectedCustomer);
  });
}
$("#nav").onclick = (event) => {
  const button = event.target.closest("[data-view]");
  if (button) {
    view = button.dataset.view;
    selectedCustomer = null;
    load();
  }
};
document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.customer) busy(() => customer(target.dataset.customer));
  if (target.dataset.material) busy(() => material(target.dataset.material));
  if (target.dataset.evidence)
    busy(async () => {
      const d = await call("crm_evidence", {
        evidenceId: target.dataset.evidence,
      });
      modal(
        `<h2>原始依据</h2><span class="pill">${e(d.evidence.verification)}</span><blockquote>${e(d.evidence.quote)}</blockquote><p>${e(d.material.filename)} · 沟通 ${e(date(d.material.occurredAt))}</p><pre>${e(JSON.stringify(d.evidence.locator, null, 2))}</pre><a href="/api/v1/materials/${e(d.material.id)}/content" download>下载原始材料</a>`,
      );
    });
  if (target.dataset.commit)
    busy(async () => {
      const resolve = target.dataset.conflict === "true";
      if (resolve && role !== "owner")
        throw new Error("需要管理身份确认冲突。");
      if (
        resolve &&
        !confirm(
          "请先查看差异和原始依据。确认采用建议的新信息，同时保留旧版本？",
        )
      )
        return;
      const result = await call("crm_commit", {
        proposalId: target.dataset.commit,
        resolveConflicts: resolve,
      });
      await load();
      notice(
        result.status === "conflict"
          ? "发现新旧冲突，未覆盖原有事实。"
          : "更新已提交，来源与历史已保存。",
      );
    });
});
document.addEventListener("change", (event) => {
  const select = event.target.closest("[data-task]");
  if (!select) return;
  const next = select.value;
  const previous = select.dataset.old;
  select.value = previous;
  const reason = prompt(
    `记录将事项改为“${statusLabels[next]}”的依据（不清楚时请取消）`,
  );
  if (!reason) return;
  busy(async () => {
    const text = `用户将待办 ${select.dataset.task} 从 ${statusLabels[previous]} 改为 ${statusLabels[next]}。依据：${reason}`;
    const m = await call("crm_ingest", {
      text,
      filename: "待办状态变更.txt",
      source: "本机用户反馈",
    });
    await call("crm_task_update", {
      taskId: select.dataset.task,
      expectedVersion: Number(select.dataset.version),
      status: next,
      idempotencyKey: crypto.randomUUID(),
      evidence: [
        { materialId: m.material.id, quote: text, locator: { kind: "text" } },
      ],
    });
    if (view === "customers" && selectedCustomer)
      await customer(selectedCustomer);
    else await load();
    notice("待办已更新，旧状态和依据已保留。");
  });
});
$("#new-customer").onclick = () => {
  const name = prompt("客户名称（现有同名档案请先检索，不会按同音自动合并）");
  if (!name?.trim()) return;
  busy(async () => {
    const text = "用户建立客户档案：" + name.trim();
    const m = await call("crm_ingest", {
      text,
      filename: "客户建档.txt",
      source: "用户明确提供",
    });
    const p = await call("crm_propose", {
      idempotencyKey: crypto.randomUUID(),
      materialIds: [m.material.id],
      operations: [
        {
          op: "create_entity",
          ref: "customer",
          type: "customer",
          name: name.trim(),
          evidence: [
            {
              materialId: m.material.id,
              quote: text,
              locator: { kind: "text" },
            },
          ],
        },
      ],
    });
    const c = await call("crm_commit", { proposalId: p.proposal.id });
    view = "customers";
    await load();
    await customer(c.result.refs.customer);
  });
};
$("#logout").onclick = async () => {
  await request("/api/session", undefined, "DELETE");
  location.reload();
};
$("#login-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await request("/api/session", { token: $("#login-token").value });
    $("#login-token").value = "";
    await start();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
};
async function start() {
  try {
    const nonce = new URLSearchParams(location.hash.slice(1)).get("login");
    if (nonce) {
      history.replaceState(null, "", location.pathname);
      await request("/api/session", { login: nonce });
    }
    const session = await request("/api/session");
    role = session.role;
    $("#identity").textContent = {
      owner: "本机管理身份",
      writer: "Agent 录入身份",
      reader: "只读身份",
    }[role];
    $("#login").classList.add("hidden");
    $("#shell").classList.remove("hidden");
    $("#new-customer").hidden = role === "reader";
    await load();
  } catch (err) {
    $("#login").classList.remove("hidden");
    $("#shell").classList.add("hidden");
    if (err.message !== "请先登录，或提供对应权限的 Bearer 凭据")
      $("#login-error").textContent = err.message;
  }
}
start();
