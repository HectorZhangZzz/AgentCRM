// Explicit, prepared synthetic fixtures only; this script never starts services.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage = `Usage: npm run test:ui -- --fixture-root /ABS/SYNTHETIC/FIXTURE \\
  --browser-executable /ABS/CHROMIUM [--output-root /ABS/PRIVATE/RESULTS]
Or use --playwright-entry /ABS/playwright/index.mjs instead of --browser-executable.
Environment: CRM_UI_FIXTURE_ROOT, CRM_UI_BROWSER_EXECUTABLE,
             CRM_UI_PLAYWRIGHT_ENTRY, CRM_UI_OUTPUT_ROOT.
Requires prepared on/off/legacy preview-state.json and fresh synthetic services
on loopback ports 4325/4326/4327. This command does not create or reset fixtures.`;
const options = new Map();
const valueOptions = new Set([
  "--fixture-root",
  "--browser-executable",
  "--playwright-entry",
  "--output-root",
]);
let setup;
try {
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === "--help" || flag === "-h") {
      console.log(usage);
      process.exit(0);
    }
    if (flag === "--boundary-red") continue;
    if (!valueOptions.has(flag) || options.has(flag))
      throw Error("未知或重复的 UI 验收参数；使用 --help 查看说明。");
    const value = process.argv[++i];
    if (!value || value.startsWith("--"))
      throw Error("UI 验收参数缺少路径；使用 --help 查看说明。");
    options.set(flag, value);
  }
  const option = (flag, env) => options.get(flag) || process.env[env];
  const fixtureArg = option("--fixture-root", "CRM_UI_FIXTURE_ROOT");
  const executableArg = option(
    "--browser-executable",
    "CRM_UI_BROWSER_EXECUTABLE",
  );
  const playwrightArg = option("--playwright-entry", "CRM_UI_PLAYWRIGHT_ENTRY");
  if (!fixtureArg)
    throw Error("缺少 --fixture-root 或 CRM_UI_FIXTURE_ROOT；未访问任何实例。");
  if ((!executableArg && !playwrightArg) || (executableArg && playwrightArg))
    throw Error(
      "须且仅须提供 --browser-executable 或 --playwright-entry（或对应环境变量）；未访问任何实例。",
    );
  const sourceRoot = await fs.realpath(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(".." + path.sep) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  };
  async function externalDirectory(value, label) {
    if (!path.isAbsolute(value)) throw Error(label + "必须是绝对路径。");
    let resolved;
    try {
      resolved = await fs.realpath(value);
      if (!(await fs.stat(resolved)).isDirectory()) throw Error();
    } catch {
      throw Error(label + "不存在或不是目录；请先准备合成环境。");
    }
    if (inside(sourceRoot, resolved))
      throw Error(
        label + "必须位于源码目录之外，避免凭据或验收输出进入源码分享。",
      );
    return resolved;
  }
  async function jsonFile(filename, label) {
    try {
      return JSON.parse(await fs.readFile(filename, "utf8"));
    } catch {
      throw Error(label + "缺失、不可读或不是有效 JSON；未启动浏览器。");
    }
  }
  const fixtureRoot = await externalDirectory(
    fixtureArg,
    "合成 fixture 根目录",
  );
  const outputRoot = await externalDirectory(
    option("--output-root", "CRM_UI_OUTPUT_ROOT") || fixtureRoot,
    "验收输出根目录",
  );
  const preview = await jsonFile(
    path.join(fixtureRoot, "preview-state.json"),
    "合成状态文件",
  );
  if (!Array.isArray(preview.instances) || preview.instances.length !== 3)
    throw Error("需要 on/off/legacy 三个已准备的合成实例；未访问任何实例。");
  const labels = ["on", "off", "legacy"];
  const configs = [];
  for (const [index, item] of preview.instances.entries()) {
    if (
      item.url !== `http://127.0.0.1:${4325 + index}` ||
      !new RegExp(`^crm_product_ui_${labels[index]}_test_[a-z0-9_]+$`).test(
        item.database,
      ) ||
      !path.isAbsolute(item.config || "")
    )
      throw Error(
        "实例必须为按 on/off/legacy 排列的合成库及专用 loopback 端口；未访问任何实例。",
      );
    const configPath = await fs.realpath(item.config);
    if (inside(sourceRoot, configPath))
      throw Error("合成配置必须位于源码目录之外；未访问任何实例。");
    const cfg = await jsonFile(configPath, "合成实例配置");
    let database;
    try {
      database = decodeURIComponent(new URL(cfg.databaseUrl).pathname.slice(1));
    } catch {
      throw Error("合成配置的数据库地址无效；未访问任何实例。");
    }
    if (
      database !== item.database ||
      cfg.port !== 4325 + index ||
      cfg.previewOnly !== true ||
      cfg.productLibraryEnabled !== (index === 0) ||
      (index !== 2
        ? cfg.productUiEnabled !== true
        : cfg.productUiEnabled === true) ||
      !["reader", "writer", "owner"].every(
        (role) =>
          typeof cfg[role + "Token"] === "string" &&
          cfg[role + "Token"].length >= 32,
      )
    )
      throw Error(
        "合成配置的库名、端口、previewOnly、功能开关或临时凭据不符合验收前提；未访问任何实例。",
      );
    configs.push(cfg);
  }
  let executable = executableArg;
  if (playwrightArg) {
    if (!path.isAbsolute(playwrightArg))
      throw Error("Playwright 入口必须是绝对文件路径。");
    try {
      const runtime = await import(
        pathToFileURL(await fs.realpath(playwrightArg)).href
      );
      const chromium = runtime.chromium || runtime.default?.chromium;
      if (typeof chromium?.executablePath !== "function") throw Error();
      executable = chromium.executablePath();
    } catch {
      throw Error(
        "无法加载指定 Playwright 入口或解析 Chromium；请先安装依赖及浏览器。",
      );
    }
  }
  if (!path.isAbsolute(executable || ""))
    throw Error("Chromium 可执行文件必须使用绝对路径。");
  try {
    executable = await fs.realpath(executable);
    if (!(await fs.stat(executable)).isFile()) throw Error();
    await fs.access(executable, process.platform === "win32" ? 0 : 1);
  } catch {
    throw Error("指定 Chromium 不存在或不可执行；未访问任何实例。");
  }
  // Only reader requests are permitted until all three servers identify as previews.
  for (const [index, item] of preview.instances.entries()) {
    let status;
    try {
      const response = await fetch(item.url + "/api/v1/status", {
        headers: { Authorization: "Bearer " + configs[index].readerToken },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error();
      status = await response.json();
    } catch {
      throw Error(
        "合成实例未运行或临时 reader 凭据不匹配；未执行任何写入，也不会自动启动或重置实例。",
      );
    }
    if (status.previewOnly !== true)
      throw Error("实例未声明 previewOnly；验收停止，未执行任何写入。");
  }
  const root = await fs.mkdtemp(path.join(outputRoot, "ui-results-"));
  await fs.chmod(root, 0o700);
  setup = { root, preview, configs, executable };
} catch (error) {
  console.error("UI 验收前置条件失败：" + error.message);
  process.exit(1);
}
const { root, preview, configs, executable } = setup;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {
  at: new Date().toISOString(),
  browser: "explicit Chromium executable/headless CDP; disposable profile",
  syntheticOnly: true,
  checks: [],
  errors: [],
  screenshots: [],
};
const profile = await fs.mkdtemp(path.join(root, "chrome-profile-"));
await fs.chmod(profile, 0o700);
const log = await fs.open(root + "/chrome.log", "a", 0o600);
const chrome = spawn(
  executable,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + profile,
    "--no-first-run",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    "--window-size=1440,1100",
    "about:blank",
  ],
  { stdio: ["ignore", log.fd, log.fd] },
);
let browserStartupError;
chrome.once("error", () => {
  browserStartupError = true;
});
await log.close();
let ws,
  counter = 0;
const pending = new Map(),
  listeners = new Map();
function send(method, params = {}, sessionId) {
  const id = ++counter;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
}
function on(method, handler) {
  listeners.set(method, handler);
}
async function api(index, name, args = {}, role = "reader") {
  const cfg = configs[index];
  const response = await fetch(
    preview.instances[index].url + "/api/v1/tools/" + name,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg[role + "Token"],
      },
      body: JSON.stringify(args),
    },
  );
  const result = await response.json();
  assert.equal(response.status, 200, name);
  return result;
}
async function tab(index = 0, role = "writer", sharedContext) {
  const context =
    sharedContext ||
    (await send("Target.createBrowserContext")).browserContextId;
  const target = (
    await send("Target.createTarget", {
      url: "about:blank",
      browserContextId: context,
    })
  ).targetId;
  const session = (
    await send("Target.attachToTarget", { targetId: target, flatten: true })
  ).sessionId;
  const cmd = (m, p = {}) => send(m, p, session);
  await cmd("Page.enable");
  await cmd("Runtime.enable");
  await cmd("Network.enable");
  await cmd("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  let cookieName;
  async function authenticate(role) {
    const response = await fetch(
      preview.instances[index].url + "/api/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: configs[index][role + "Token"] }),
      },
    );
    assert.equal(response.status, 200);
    const pair = /^(crm_[a-z0-9_]+)=([^;]+)/.exec(
      response.headers.get("set-cookie"),
    );
    cookieName = pair[1];
    const cookie = pair[2];
    await cmd("Network.setCookie", {
      name: cookieName,
      value: cookie,
      url: preview.instances[index].url + "/",
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
  }
  if (role) await authenticate(role);
  const evaluate = async (expression) => {
    const r = await cmd("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.text +
          ": " +
          r.exceptionDetails.exception?.description,
      );
    return r.result.value;
  };
  const until = async (
    expression,
    message = "UI condition",
    timeout = 7000,
  ) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return;
      await wait(40);
    }
    throw Error(
      "Timed out: " +
        message +
        "; " +
        (await evaluate("document.body.innerText")).slice(-1800),
    );
  };
  const click = async (selector) => {
    const box = await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
    assert(box, "Clickable " + selector);
    await cmd("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...box,
    });
    await cmd("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...box,
    });
    if (
      [
        "#new-product",
        "#new-child",
        "#new-assertion",
        "#new-relation",
        "#resume-draft",
      ].includes(selector)
    )
      await until(
        'document.querySelector("#product-dialog").open',
        "form opened",
      );
  };
  const fill = async (selector, value) => {
    await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.matches(":disabled"))throw Error('Input unavailable');e.focus();e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await cmd("Input.insertText", { text: value });
  };
  const select = async (selector, value) =>
    evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  const nav = async (url) => {
    await cmd("Page.navigate", { url });
    await until('document.readyState==="complete"', "page ready");
  };
  const screenshot = async (name) => {
    await evaluate("window.scrollTo(0,0)");
    const metrics = await cmd("Page.getLayoutMetrics");
    const result = await cmd("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: await evaluate("innerWidth"),
        height: Math.min(2600, metrics.cssContentSize.height),
        scale: 1,
      },
    });
    const file = root + "/" + name;
    await fs.writeFile(file, Buffer.from(result.data, "base64"));
    report.screenshots.push(file);
    return file;
  };
  await nav(preview.instances[index].url + "/products");
  return {
    cmd,
    evaluate,
    until,
    click,
    fill,
    select,
    nav,
    screenshot,
    context,
    target,
    session,
    authenticate,
    getCookieName: () => cookieName,
  };
}
const mark = (name) => {
  report.checks.push(name);
  console.log("UI PASS: " + name);
};
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = (
        await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split("\n");
      break;
    } catch {}
    if (browserStartupError || chrome.exitCode !== null)
      throw Error(
        "Chrome did not start with default sandbox; see private chrome.log",
      );
    await wait(50);
  }
  assert(port, "Chrome endpoint");
  ws = new WebSocket("ws://127.0.0.1:" + port[0] + port[1]);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p?.reject(Error(data.error.message));
      else p?.resolve(data.result);
    } else listeners.get(data.method)?.(data.params, data.sessionId);
  });
  on("Runtime.exceptionThrown", (params) =>
    report.errors.push(params.exceptionDetails.text),
  );
  if (process.argv.includes("--boundary-red")) {
    const a = await tab(0, "writer");
    await a.until('document.body.innerText.includes("隔离预览")');
    const before = await a.evaluate('fetch("/api/session").then(r=>r.status)');
    assert.equal(before, 200);
    const b = await tab(1, "reader", a.context);
    await b.until('document.body.innerText.includes("产品资料库尚未启用")');
    const overwritten = await a.evaluate(
      'fetch("/api/session").then(r=>r.status)',
    );
    assert.equal(overwritten, 401);
    mark(
      "RED reproduced: second port login overwrites first port session cookie",
    );
    const legacy = await fetch(preview.instances[2].url + "/products");
    assert.equal(legacy.status, 200);
    mark("RED reproduced: missing UI flag still exposes product route");
    await a.authenticate("writer");
    await a.nav(preview.instances[0].url + "/products");
    await a.until(
      'document.querySelector("#new-product")&&!document.querySelector("#new-product").hidden',
    );
    let dropped = false;
    on("Fetch.requestPaused", async (params, session) => {
      if (session !== a.session) return;
      if (!dropped && params.responseStatusCode) {
        dropped = true;
        await send(
          "Fetch.failRequest",
          { requestId: params.requestId, errorReason: "Failed" },
          session,
        );
      } else
        await send(
          "Fetch.continueRequest",
          { requestId: params.requestId },
          session,
        );
    });
    await a.cmd("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/v1/tools/crm_commit", requestStage: "Response" },
      ],
    });
    await a.click("#new-product");
    await a.fill("[name=name]", "合成边界复现产品");
    await a.fill("[name=label]", "合成边界复现");
    await a.fill("[name=text]", "合成边界复现产品");
    await a.fill("[name=quote]", "合成边界复现产品");
    await a.click("#save-product");
    await a.until(
      'document.querySelector("#form-error").innerText.includes("尚未核对")',
    );
    await a.cmd("Fetch.disable");
    assert.equal(
      (
        await api(0, "crm_entities", {
          type: "product",
          query: "合成边界复现产品",
        })
      ).total,
      1,
    );
    await a.cmd("Network.deleteCookies", {
      name: a.getCookieName(),
      url: preview.instances[0].url + "/",
    });
    await a.click("#save-product");
    await a.until('document.querySelector("#edit-again")!==null');
    assert(
      !(await a.evaluate('document.querySelector("#discard-draft").disabled')),
    );
    mark(
      "RED reproduced: lost successful commit then 401 unlocks editing and discard",
    );
    report.completed = true;
    report.reproductionOnly = true;
  } else {
    const firstSession = await tab(0, "writer");
    await firstSession.until('document.body.innerText.includes("隔离预览")');
    const secondSession = await tab(1, "reader", firstSession.context);
    await secondSession.until(
      'document.body.innerText.includes("产品资料库尚未启用")',
    );
    assert.notEqual(
      firstSession.getCookieName(),
      secondSession.getCookieName(),
    );
    assert.equal(
      await firstSession.evaluate('fetch("/api/session").then(r=>r.status)'),
      200,
    );
    assert.equal(
      await secondSession.evaluate('fetch("/api/session").then(r=>r.status)'),
      200,
    );
    await secondSession.evaluate(
      'fetch("/api/session",{method:"DELETE"}).then(r=>r.status)',
    );
    assert.equal(
      await firstSession.evaluate('fetch("/api/session").then(r=>r.status)'),
      200,
    );
    assert.equal(
      await secondSession.evaluate('fetch("/api/session").then(r=>r.status)'),
      401,
    );
    await secondSession.authenticate("reader");
    const cookies = (
      await secondSession.cmd("Network.getCookies", {
        urls: [preview.instances[1].url],
      })
    ).cookies;
    const other = cookies.find((c) => c.name === secondSession.getCookieName());
    assert(other);
    await firstSession.cmd("Network.setCookie", {
      name: firstSession.getCookieName(),
      value: other.value,
      url: preview.instances[0].url + "/",
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    assert.equal(
      await firstSession.evaluate('fetch("/api/session").then(r=>r.status)'),
      401,
    );
    assert.equal(
      await secondSession.evaluate('fetch("/api/session").then(r=>r.status)'),
      200,
    );
    await firstSession.authenticate("writer");
    mark(
      "separate preview cookies: cross-port login/logout isolated and foreign instance cookie rejected",
    );
    const legacyResponse = await fetch(preview.instances[2].url + "/");
    assert.equal(
      await legacyResponse.text(),
      await fs.readFile(
        new URL("../public/index.html", import.meta.url),
        "utf8",
      ),
    );
    for (const route of [
      "/products",
      "/products.js",
      "/workspace.js",
      "/product-workflow.mjs",
    ])
      assert.equal((await fetch(preview.instances[2].url + route)).status, 404);
    assert.deepEqual(
      (await api(2, "crm_health")).migrations.map((m) => m.version),
      ["001_initial.sql"],
    );
    const legacy = await tab(2, "reader");
    await legacy.nav(preview.instances[2].url + "/");
    await legacy.until('document.body.innerText.includes("客户与项目")');
    assert(
      !(await legacy.evaluate(
        'document.querySelector("#nav").innerText.includes("产品资料库")',
      )),
    );
    mark(
      "missing UI flag keeps exact legacy root bytes, hides new routes/navigation and never applies 002",
    );
    const unauth = await tab(0, null);
    await unauth.until(
      'document.body.innerText.includes("请先登录产品资料库")',
    );
    assert(
      await unauth.evaluate('document.querySelector("#new-product").hidden'),
    );
    mark("unauthorized page shows sign-in state without writable controls");
    const off = await tab(1, "reader");
    await off.until('document.body.innerText.includes("产品资料库尚未启用")');
    const offHealth = await api(1, "crm_health");
    assert.deepEqual(
      offHealth.migrations.map((m) => m.version),
      ["001_initial.sql"],
    );
    await off.nav(preview.instances[1].url + "/");
    await off.until('document.body.innerText.includes("客户与项目")');
    mark(
      "feature disabled keeps only 001 and legacy customer workspace usable",
    );
    const w = await tab();
    await w.until('document.body.innerText.includes("还没有产品资料")');
    assert(await w.evaluate('document.body.innerText.includes("隔离预览")'));
    mark("empty product list and synthetic-preview notice");
    await w.fill("#product-search", "不存在的合成关键字");
    await w.click("#product-search-form button");
    await w.until('document.body.innerText.includes("没有找到匹配记录")');
    await w.fill("#product-search", "");
    await w.click("#product-search-form button");
    await w.until('document.body.innerText.includes("还没有产品资料")');
    mark("search no-results and return to empty list");
    await w.click("#new-product");
    await w.until('document.querySelector("#product-dialog").open');
    const original =
      "合成演示系列，型号 SYN-100，版本 R1；仅用于隔离页面验收。";
    await w.fill("[name=name]", "合成演示系列");
    await w.fill("[name=modelName]", "SYN-100");
    await w.fill("[name=versionName]", "R1");
    await w.fill("[name=label]", "合成产品手册·UI验收");
    await w.fill("[name=text]", original);
    await w.fill("[name=quote]", "不在原文中");
    const countBefore = (await api(0, "crm_entities")).total;
    await w.click("#save-product");
    await w.until(
      'document.querySelector("#form-error").innerText.includes("原始文字")',
    );
    assert.equal((await api(0, "crm_entities")).total, countBefore);
    await w.click("#cancel-draft");
    await w.click("#resume-draft");
    assert.equal(
      await w.evaluate('document.querySelector("[name=name]").value'),
      "合成演示系列",
    );
    await w.select("[name=sourceMode]", "existing");
    await w.select("[name=sourceMode]", "paste");
    assert.equal(
      await w.evaluate('document.querySelector("[name=text]").value'),
      original,
    );
    await w.fill("[name=quote]", original);
    mark(
      "invalid quote blocks requests; cancel/resume and source-mode changes preserve inputs",
    );
    await w.click("#save-product");
    await w.until('document.body.innerText.includes("已持久保存并回读核验")');
    const versionId = await w.evaluate('location.hash.split("/entity/")[1]');
    const version = await api(0, "crm_product", { entityId: versionId });
    const modelId = version.parents[0].id;
    const model = await api(0, "crm_product", { entityId: modelId });
    const productId = model.parents[0].id;
    assert.equal((await api(0, "crm_entities", { type: "product" })).total, 1);
    assert.equal(
      (await api(0, "crm_entities", { type: "product_model" })).total,
      1,
    );
    assert.equal(
      (await api(0, "crm_entities", { type: "product_version" })).total,
      1,
    );
    mark(
      "browser creates product/model/version atomically and reads correct hierarchy",
    );
    await w.click(".breadcrumb a:nth-of-type(2)");
    await w.until('document.body.innerText.includes("下一级 · 型号")');
    await w.click(".product-children a");
    await w.until('document.body.innerText.includes("下一级 · 版本")');
    await w.click(".product-children a");
    await w.until(
      'document.querySelector(".product-hero h2")?.innerText==="R1"',
    );
    await w.cmd("Runtime.evaluate", { expression: "history.back()" });
    await w.until(
      'document.querySelector(".product-hero h2")?.innerText==="SYN-100"',
    );
    await w.cmd("Runtime.evaluate", { expression: "history.forward()" });
    await w.until(
      'document.querySelector(".product-hero h2")?.innerText==="R1"',
    );
    mark(
      "hierarchy drill-down and browser back/forward restore matching object",
    );
    const contexts = (await api(0, "crm_entities", { type: "project" })).items,
      customer = (await api(0, "crm_entities", { type: "customer" })).items[0];
    async function source(t, text) {
      await t.fill("[name=label]", "合成 UI 记录");
      await t.fill("[name=text]", text);
      await t.fill("[name=quote]", text);
    }
    async function record(kind, key, statement, extra = {}) {
      await w.click("#new-assertion");
      if (kind !== "requirement") await w.select("[name=kind]", kind);
      await w.fill("[name=key]", key);
      await w.fill("[name=statement]", statement);
      if (extra.context) await w.select("[name=contextId]", extra.context);
      if (extra.conditions) await w.fill("[name=conditions]", extra.conditions);
      await source(w, statement);
      if (kind === "capability") {
        await w.click("#save-product");
        await w.until(
          'document.querySelector("#form-error").innerText.includes("需明确复核")',
        );
        await w.click("[name=reviewed]");
      }
      await w.click("#save-product");
      await w.until(
        '!document.querySelector("#product-dialog").open && document.body.innerText.includes("已持久保存并回读核验")',
      );
    }
    await record(
      "requirement",
      "合成4K30目标",
      "客户提出合成4K30目标，尚未验证产品支持。",
      { context: contexts[0].id },
    );
    await record(
      "assessment",
      "合成适配评估",
      "合成配置适配仍未知，等待验证。",
    );
    await record(
      "capability",
      "合成配置能力",
      "合成测试记录只支持配置A，不能外推其他条件。",
      { conditions: "合成板卡A / 软件v1 / 本次测试参数" },
    );
    const profileNow = await api(0, "crm_product", { entityId: versionId });
    assert.equal(profileNow.requirements.length, 1);
    assert.equal(profileNow.assessments.length, 1);
    assert.equal(profileNow.capabilities.length, 1);
    assert.equal(
      (await api(0, "crm_product", { entityId: modelId })).capabilities.length,
      0,
    );
    mark(
      "three evidence classes and capability review validation; no inherited capability",
    );
    await w.click("#new-relation");
    await w.select("[name=contextId]", customer.id);
    await source(w, "合成客户与 R1 资料相关，不表示采购或采用。");
    await w.click("#save-product");
    await w.until('!document.querySelector("#product-dialog").open');
    await w.until('document.body.innerText.includes("合成客户·预览专用")');
    mark(
      "browser associates existing synthetic customer without creating sales project/task",
    );
    await w.click("[data-evidence]");
    await w.until(
      'document.querySelector("#source-dialog").open && document.querySelector("#source-content blockquote")',
    );
    await w.click("#source-close");
    await w.click("[data-material]");
    await w.until(
      'document.querySelector("#source-content").innerText.includes("SHA256")',
    );
    await w.click("#source-close");
    mark("evidence and raw-material dialogs display original quote and hash");
    await w.screenshot("product-detail.png");
    // Keep an unsaved assertion bound to R1 while moving back to the parent.
    await w.click("#new-assertion");
    await w.fill("[name=key]", "保留的合成草稿");
    await w.fill("[name=statement]", "不丢弃输入");
    await w.click("#cancel-draft");
    await w.click(".breadcrumb a:nth-of-type(3)");
    await w.until(
      'document.querySelector(".product-hero h2")?.innerText==="SYN-100"',
    );
    await w.click("#resume-draft");
    assert.equal(
      await w.evaluate('document.querySelector("[name=key]").value'),
      "保留的合成草稿",
    );
    assert(
      await w.evaluate(
        'document.querySelector(".product-form-target").innerText.includes(' +
          JSON.stringify(versionId) +
          ")",
      ),
    );
    await w.click("#cancel-draft");
    await w.click("#discard-draft");
    mark("navigation preserves draft and fixed original object identity");
    // Same-parent duplicate using the identical already stored original.
    await w.cmd("Runtime.evaluate", {
      expression: "location.hash=" + JSON.stringify("#/entity/" + productId),
    });
    await w.until(
      'document.querySelector(".product-hero h2")?.innerText==="合成演示系列"',
    );
    await w.click("#new-child");
    await w.fill("[name=name]", "SYN-100");
    await w.select("[name=sourceMode]", "existing");
    await w.select("[name=materialId]", version.materials[0].id);
    await w.until(
      'document.querySelector("[name=text]").value.includes("合成演示系列")',
    );
    await w.fill("[name=quote]", original);
    const modelCount = (await api(0, "crm_entities", { type: "product_model" }))
      .total;
    await w.click("#save-product");
    await w.until(
      'document.querySelector("#form-error").innerText.includes("同一原始证据")',
    );
    assert.equal(
      (await api(0, "crm_entities", { type: "product_model" })).total,
      modelCount,
    );
    await w.click("#cancel-draft");
    await w.click("#discard-draft");
    mark(
      "same-parent duplicate rejected and original input retained; no extra model",
    );
    // Lose a real commit response AFTER the synthetic server has answered.
    let dropped = false;
    on("Fetch.requestPaused", async (params, session) => {
      if (session !== w.session) return;
      if (!dropped && params.responseStatusCode) {
        dropped = true;
        await send(
          "Fetch.failRequest",
          { requestId: params.requestId, errorReason: "Failed" },
          session,
        );
      } else
        await send(
          "Fetch.continueRequest",
          { requestId: params.requestId },
          session,
        );
    });
    await w.cmd("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/v1/tools/crm_commit", requestStage: "Response" },
      ],
    });
    await w.click("#new-product");
    await w.fill("[name=name]", "合成重试产品");
    await source(w, "合成重试产品，仅用于验证响应丢失后的幂等重试。");
    await w.click("#save-product");
    await w.until(
      'document.querySelector("#form-error").innerText.includes("尚未核对")',
    );
    assert(dropped);
    assert(
      await w.evaluate(
        'document.querySelector("[name=name]").matches(":disabled")',
      ),
    );
    assert(
      await w.evaluate('document.querySelector("#discard-draft").disabled'),
    );
    await w.cmd("Fetch.disable");
    const committedBeforeRetry = (
      await api(0, "crm_entities", { type: "product", query: "合成重试产品" })
    ).items[0].id;
    await w.cmd("Network.deleteCookies", {
      name: w.getCookieName(),
      url: preview.instances[0].url + "/",
    });
    await w.click("#save-product");
    await w.until(
      'document.querySelector("#form-error").innerText.includes("另一个标签页")',
    );
    assert.equal(
      await w.evaluate('document.querySelector("#edit-again")'),
      null,
    );
    assert(
      await w.evaluate('document.querySelector("#discard-draft").disabled'),
    );
    assert(
      await w.evaluate(
        'document.querySelector("[name=name]").matches(":disabled")',
      ),
    );
    await w.authenticate("writer");
    await w.click("#save-product");
    await w.until(
      '!document.querySelector("#product-dialog").open && document.querySelector(".product-hero h2")?.innerText==="合成重试产品"',
    );
    assert.equal(
      (await api(0, "crm_entities", { type: "product", query: "合成重试产品" }))
        .total,
      1,
    );
    assert.equal(
      await w.evaluate('location.hash.split("/entity/")[1]'),
      committedBeforeRetry,
    );
    mark(
      "lost successful commit, then 401, stays locked; re-login confirms same proposal/identity without duplicate",
    );
    // Stored hostile markup is displayed literally, with no script execution.
    await w.click("#new-product");
    const hostile = '<img src=x onerror="globalThis.__productXss=1">';
    await w.fill("[name=name]", hostile);
    await source(w, hostile);
    await w.click("#save-product");
    await w.until('!document.querySelector("#product-dialog").open');
    assert.equal(await w.evaluate("globalThis.__productXss"), undefined);
    assert.equal(
      await w.evaluate('document.querySelector(".product-hero h2").innerText'),
      hostile,
    );
    assert.equal(
      await w.evaluate(
        'document.querySelectorAll("#product-content img").length',
      ),
      0,
    );
    mark("stored name/quote markup escaped; CSP retained; no script execution");
    const reader = await tab(0, "reader");
    await reader.until('document.body.innerText.includes("当前为只读身份")');
    await reader.cmd("Runtime.evaluate", {
      expression: "location.hash=" + JSON.stringify("#/entity/" + versionId),
    });
    await reader.until('document.body.innerText.includes("只读查看")');
    assert(
      await reader.evaluate('document.querySelector("#new-product").hidden'),
    );
    assert.equal(
      await reader.evaluate('document.querySelector("#new-assertion")'),
      null,
    );
    const forbidden = await reader.evaluate(
      'fetch("/api/v1/tools/crm_propose",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idempotencyKey:"denied-ui",materialIds:[],operations:[]})}).then(r=>r.status)',
    );
    assert.equal(forbidden, 403);
    mark("reader UI has no writable controls and server refuses forged write");
    await reader.cmd("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await reader.screenshot("product-mobile.png");
    assert(
      await reader.evaluate("document.documentElement.scrollWidth<=innerWidth"),
    );
    mark("mobile layout has no horizontal page overflow");
    await w.nav(preview.instances[0].url + "/products#/entity/" + versionId);
    await w.until(
      'document.querySelector(".product-hero h2")?.innerText==="R1"',
    );
    await w.screenshot("product-detail.png");
    assert.equal(
      (await api(0, "crm_tasks", { includeCompleted: true })).total,
      0,
    );
    assert.equal(await w.evaluate("document.cookie"), "");
    assert.equal(
      await w.evaluate("localStorage.length+sessionStorage.length"),
      0,
    );
    mark(
      "no front-end credential or draft persistence; session cookie remains HttpOnly",
    );
    // The local preview helper may point at another fixture; use only the
    // explicitly validated instance instead of invoking an ambient helper.
    const loginResponse = await fetch(
      preview.instances[0].url + "/api/login-link",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + configs[0].ownerToken },
      },
    );
    assert.equal(loginResponse.status, 200);
    const loginResult = await loginResponse.json();
    loginResult.url = loginResult.url.replace("/#login=", "/products#login=");
    assert(
      loginResult.url.startsWith(preview.instances[0].url + "/products#login="),
    );
    const loginTab = await tab(0, null);
    await loginTab.nav(loginResult.url);
    await loginTab.until(
      'document.querySelector("#product-identity").innerText.includes("本机管理身份")',
    );
    assert(!(await loginTab.evaluate('location.hash.includes("login=")')));
    mark(
      "explicit synthetic preview one-use login API works and removes nonce from address",
    );
    report.completed = true;
  }
} catch (err) {
  report.completed = false;
  report.failure = err.message;
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  try {
    if (ws?.readyState === WebSocket.OPEN) await send("Browser.close");
  } catch {}
  chrome.kill("SIGTERM");
  await fs.writeFile(
    root + "/browser-results.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      completed: report.completed,
      checks: report.checks.length,
      screenshots: report.screenshots,
      failure: report.failure,
    }),
  );
}
