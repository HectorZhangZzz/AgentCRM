import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const applicationVersion = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
).version;
export const configPath = () =>
  path.resolve(
    process.env.CRM_CONFIG || path.join(projectRoot, ".local/config.json"),
  );
export function loadConfig() {
  const filename = configPath();
  let config;
  try {
    config = JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    throw new Error(
      "找不到有效配置。请先运行 ./ops/crm init；或设置 CRM_CONFIG。",
    );
  }
  if (config.version !== 1) throw new Error("不支持的配置版本");
  config.dataDir = path.isAbsolute(config.dataDir)
    ? config.dataDir
    : path.resolve(path.dirname(filename), config.dataDir);
  config.port ||= 4310;
  if (
    ![config.ownerToken, config.writerToken, config.readerToken].every(
      (x) => typeof x === "string" && x.length >= 32,
    )
  ) {
    throw new Error("配置缺少独立 owner / writer / reader 凭据");
  }
  return config;
}

export function loadClientConfig() {
  const filename = process.env.CRM_CLIENT_CONFIG;
  if (filename) {
    const client = JSON.parse(readFileSync(path.resolve(filename), "utf8"));
    if (
      !["writer", "reader", "owner"].includes(client.role) ||
      typeof client.token !== "string"
    )
      throw new Error("客户端配置无效");
    validateLocalUrl(client.url);
    return client;
  }
  const config = loadConfig();
  const role = process.env.CRM_ROLE || "writer";
  if (!["writer", "reader", "owner"].includes(role))
    throw new Error("CRM_ROLE 无效");
  const url = `http://127.0.0.1:${config.port}`;
  return { url, role, token: config[`${role}Token`] };
}

export function validateLocalUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "此发行版仅连接本机 HTTP。远程访问需另行配置并经用户授权。",
    );
  }
}

export async function api(
  client,
  pathname,
  body,
  { method = body === undefined ? "GET" : "POST" } = {},
) {
  validateLocalUrl(client.url);
  const response = await fetch(new URL(pathname, client.url), {
    method,
    headers: {
      Authorization: `Bearer ${client.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`服务未返回 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const error = new Error(data.error?.message || `HTTP ${response.status}`);
    error.code = data.error?.code || "HTTP_ERROR";
    error.status = response.status;
    error.details = data.error?.details;
    throw error;
  }
  return data;
}
