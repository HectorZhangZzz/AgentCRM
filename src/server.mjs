import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { loadConfig, projectRoot, applicationVersion } from "./config.mjs";
import { createDomain } from "./domain.mjs";
import { createProjection } from "./twenty-projection.mjs";
import { MAX_MATERIAL_BYTES, MAX_JSON_BYTES } from "./material-storage.mjs";

const config = loadConfig();
const domain = await createDomain(config);
const projection = createProjection(config, domain);
const sessions = new Map();
const loginLinks = new Map();
const ownerOnly = new Set(["crm_reassign"]);
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
function roleFor(token) {
  for (const role of ["owner", "writer", "reader"])
    if (equal(token, config[`${role}Token`])) return role;
  return null;
}
function identity(req) {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  if (bearer) {
    const role = roleFor(bearer);
    return role ? { role, actor: `local-${role}` } : null;
  }
  const sessionId = /(?:^|;\s*)crm_session=([a-zA-Z0-9_-]+)/.exec(
    req.headers.cookie || "",
  )?.[1];
  const session = sessions.get(sessionId);
  if (session && session.expires > Date.now())
    return { role: session.role, actor: `console-${session.role}` };
  if (sessionId) sessions.delete(sessionId);
  return null;
}
function failure(code, message, status = 400, details) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  e.details = details;
  throw e;
}
async function readBody(req) {
  if (Number(req.headers["content-length"]) > MAX_JSON_BYTES)
    failure("TOO_LARGE", "JSON 请求上限 48 MiB；大文件请使用原件上传接口", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES)
      failure(
        "TOO_LARGE",
        "JSON 请求上限 48 MiB；大文件请使用原件上传接口",
        413,
      );
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    return bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  } catch {
    failure("BAD_JSON", "JSON 格式无效");
  }
}
function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function setSession(res, role) {
  const session = randomBytes(32).toString("base64url");
  sessions.set(session, { role, expires: Date.now() + 12 * 3600000 });
  res.setHeader(
    "Set-Cookie",
    `crm_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
  );
}
function requireIdentity(req) {
  const ctx = identity(req);
  if (!ctx)
    failure("UNAUTHORIZED", "请先登录，或提供对应权限的 Bearer 凭据", 401);
  return ctx;
}
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    const hosts = new Set([
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
    ]);
    if (!hosts.has(req.headers.host))
      failure("INVALID_HOST", "仅接受本机指定地址", 403);
    const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
    if (
      req.headers.origin &&
      !new Set([...hosts].map((h) => "http://" + h)).has(req.headers.origin)
    )
      failure("INVALID_ORIGIN", "来源不受信任", 403);
    if (req.method === "GET" && url.pathname === "/healthz") {
      await domain.health();
      return json(res, {
        ok: true,
        application: "agent-crm",
        version: applicationVersion,
        contractVersion: 1,
        modelConfigured: false,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      const body = await readBody(req);
      let role;
      if (body.login) {
        const link = loginLinks.get(body.login);
        loginLinks.delete(body.login);
        if (link?.expires > Date.now()) role = "owner";
      } else role = roleFor(body.token);
      if (!role) failure("UNAUTHORIZED", "凭据无效或一次性链接已过期", 401);
      setSession(res, role);
      return json(res, { role });
    }
    if (req.method === "DELETE" && url.pathname === "/api/session") {
      res.setHeader(
        "Set-Cookie",
        "crm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
      return json(res, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/session") {
      const ctx = requireIdentity(req);
      return json(res, { role: ctx.role });
    }
    if (req.method === "POST" && url.pathname === "/api/login-link") {
      const ctx = requireIdentity(req);
      if (ctx.role !== "owner")
        failure("FORBIDDEN", "只有本机管理身份可创建控制台登录链接", 403);
      const nonce = randomBytes(24).toString("base64url");
      loginLinks.set(nonce, { expires: Date.now() + 60000 });
      for (const [key, item] of loginLinks)
        if (item.expires < Date.now()) loginLinks.delete(key);
      return json(res, {
        url: `http://127.0.0.1:${config.port}/#login=${nonce}`,
        expiresInSeconds: 60,
      });
    }
    if (url.pathname.startsWith("/api/v1/")) {
      const ctx = requireIdentity(req);
      if (req.method === "GET" && url.pathname === "/api/v1/tools")
        return json(res, {
          version: 1,
          tools: domain.tools.filter(
            (t) =>
              (ctx.role !== "reader" || t.readOnly) &&
              (ctx.role === "owner" || !ownerOnly.has(t.name)),
          ),
        });
      if (req.method === "GET" && url.pathname === "/api/v1/status")
        return json(res, {
          ...(await domain.health()),
          projection: projection.status(),
        });
      if (req.method === "POST" && url.pathname === "/api/v1/export") {
        if (ctx.role !== "owner")
          failure("FORBIDDEN", "结构化数据导出需要管理身份", 403);
        return json(res, {
          ...(await domain.exportData()),
          scope: {
            kind: "structured-records-only",
            originalsIncluded: false,
            completeBackupCommand: "./ops/crm backup",
            note: "此 JSON 不包含二进制原件，不能单独作为完整迁移备份。",
          },
        });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/projection/sync") {
        if (ctx.role !== "owner")
          failure("FORBIDDEN", "投影同步需要管理身份", 403);
        return json(res, await projection.sync());
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/v1/tools/")) {
        const name = decodeURIComponent(
          url.pathname.slice("/api/v1/tools/".length),
        );
        const result = await domain.call(name, await readBody(req), ctx);
        if (!domain.tools.find((t) => t.name === name)?.readOnly)
          projection.schedule();
        return json(res, result);
      }
      if (req.method === "POST" && url.pathname === "/api/v1/upload") {
        if (ctx.role === "reader")
          failure("FORBIDDEN", "只读身份不能上传材料", 403);
        if (Number(req.headers["content-length"]) > MAX_MATERIAL_BYTES)
          failure(
            "MATERIAL_TOO_LARGE",
            "单个原件上限 500 MB（500,000,000 字节）",
            413,
          );
        const result = await domain.ingestStream(
          req,
          {
            filename: url.searchParams.get("filename") || "upload.bin",
            mimeType: req.headers["content-type"] || "application/octet-stream",
            source: url.searchParams.get("source") || "本机控制台上传",
            occurredAt: url.searchParams.get("occurredAt") || null,
          },
          ctx,
        );
        return json(res, result);
      }
      const material = /^\/api\/v1\/materials\/([a-f0-9-]+)\/content$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && material) {
        const { material: original, handle } = await domain.openOriginal(
          material[1],
          ctx,
        );
        try {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(
              original.byteLength ?? original.byteSize ?? original.sizeBytes,
            ),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(original.filename || "material.bin")}`,
            "Cache-Control": "no-store",
          });
          await pipeline(
            handle.createReadStream({ start: 0, autoClose: true }),
            res,
          );
          return;
        } finally {
          await handle.close().catch(() => {});
        }
      }
      failure("NOT_FOUND", "接口不存在", 404);
    }
    const staticFiles = {
      "/": "index.html",
      "/app.js": "app.js",
      "/style.css": "style.css",
    };
    if (req.method === "GET" && Object.hasOwn(staticFiles, url.pathname)) {
      const file = staticFiles[url.pathname],
        type = file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html";
      res.writeHead(200, {
        "Content-Type": type + "; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return res.end(await readFile(path.join(projectRoot, "public", file)));
    }
    failure("NOT_FOUND", "页面不存在", 404);
  } catch (error) {
    if (!req.complete) {
      if (!res.headersSent) res.setHeader("Connection", "close");
      req.resume();
    }
    if (!error.status)
      console.error(
        JSON.stringify({
          event: "request_failed",
          code: error.code || "INTERNAL",
          message: error.message?.replace(
            /postgres(?:ql)?:\/\/[^\s]+/g,
            "[database]",
          ),
        }),
      );
    if (!res.headersSent)
      json(
        res,
        {
          error: {
            code: error.code || "INTERNAL",
            message: error.status
              ? error.message
              : "服务遇到错误，请查看本机日志",
            details: error.status ? error.details : undefined,
          },
        },
        error.status || 500,
      );
    else res.destroy();
  }
});
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 15000;
server.listen(config.port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      event: "ready",
      url: `http://127.0.0.1:${config.port}`,
      contractVersion: 1,
    }),
  );
  projection.schedule();
});
async function shutdown() {
  projection.stop();
  server.close();
  await domain.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
