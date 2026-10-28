import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  api,
  loadClientConfig,
  loadConfig,
  projectRoot,
  validateLocalUrl,
} from "./config.mjs";
import { MAX_MATERIAL_BYTES } from "./material-storage.mjs";
import { parseConnectionArgs, renderConnection } from "./connections.mjs";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "connection") {
    process.stdout.write(
      renderConnection({
        root: projectRoot,
        node: process.execPath,
        ...parseConnectionArgs(args),
      }).text,
    );
  } else if (command === "open" || command === "login-url") {
    const cfg = loadConfig();
    const link = await api(
      { url: `http://127.0.0.1:${cfg.port}`, token: cfg.ownerToken },
      "/api/login-link",
      {},
    );
    if (command === "login-url") console.log(link.url);
    else {
      const child = spawn(
        process.platform === "darwin" ? "open" : "xdg-open",
        [link.url],
        { detached: true, stdio: "ignore" },
      );
      child.on("error", () =>
        console.error("无法自动打开，请在本机运行 npm run crm -- login-url。"),
      );
      child.unref();
      console.log("已请求打开本机 Agent CRM 控制台。");
    }
  } else {
    const client = loadClientConfig();
    let result;
    if (command === "status") result = await api(client, "/api/v1/status");
    else if (command === "tools") result = await api(client, "/api/v1/tools");
    else if (command === "call") {
      const body = args[1]?.startsWith("@")
        ? JSON.parse(await readFile(args[1].slice(1), "utf8"))
        : JSON.parse(args[1] || "{}");
      result = await api(
        client,
        "/api/v1/tools/" + encodeURIComponent(args[0]),
        body,
      );
    } else if (command === "ingest") {
      if (!args[0])
        throw new Error("用法：npm run crm -- ingest /path/to/file");
      const file = await stat(args[0]);
      if (!file.isFile()) throw new Error("材料路径必须是普通文件");
      if (file.size > MAX_MATERIAL_BYTES)
        throw new Error("单个原件上限 500 MB（500,000,000 字节）");
      const mimeTypes = {
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".csv": "text/csv",
        ".json": "application/json",
        ".log": "text/plain",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pptx":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".zip": "application/zip",
      };
      const query = new URLSearchParams({
        filename: path.basename(args[0]),
        source: args[1] || "本机文件导入",
      });
      validateLocalUrl(client.url);
      const input = createReadStream(args[0]);
      try {
        const response = await fetch(
          new URL("/api/v1/upload?" + query, client.url),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${client.token}`,
              "Content-Type":
                mimeTypes[path.extname(args[0]).toLowerCase()] ||
                "application/octet-stream",
              "Content-Length": String(file.size),
            },
            body: input,
            duplex: "half",
            signal: AbortSignal.timeout(10 * 60 * 1000),
          },
        );
        try {
          result = await response.json();
        } catch {
          throw new Error(`服务未返回 JSON（HTTP ${response.status}）`);
        }
        if (!response.ok) {
          const error = new Error(
            result.error?.message || `HTTP ${response.status}`,
          );
          error.code = result.error?.code || "HTTP_ERROR";
          error.status = response.status;
          error.details = result.error?.details;
          throw error;
        }
      } finally {
        input.destroy();
      }
    } else
      throw new Error(
        "命令：status | tools | call <tool> <JSON 或 @文件> | ingest <文件> [来源] | open | login-url",
      );
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        code: error.code || "CLI_ERROR",
        message: error.message,
        details: error.details,
      },
    }),
  );
  process.exitCode = 1;
}
