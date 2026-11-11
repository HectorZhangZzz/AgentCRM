import { writeFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { projectRoot, loadConfig } from "../src/config.mjs";

// New databases per run: this runner never resets the user's business schema.
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const tag = Date.now().toString(36) + "_" + randomBytes(3).toString("hex");
const directory = path.join(projectRoot, ".local/test-runs", tag);
await mkdir(directory, { recursive: true, mode: 0o700 });
const names = [
  `crm_domain_test_${tag}`,
  `crm_http_test_${tag}`,
  `crm_large_test_${tag}`,
  `crm_product_test_${tag}`,
  `crm_product_restore_test_${tag}`,
];
try {
  for (const name of names) await pool.query(`CREATE DATABASE "${name}"`);
  const urls = names.map((name) => {
    const u = new URL(config.databaseUrl);
    u.pathname = "/" + name;
    return u.toString();
  });
  const httpConfig = {
    version: 1,
    port: 4390,
    dataDir: path.join(directory, "http-data"),
    databaseUrl: urls[1],
    productLibraryEnabled: true,
    productUiEnabled: true,
    // Optional reuse keeps this acceptance run from creating new credentials.
    // These private fixtures only bind the isolated HTTP test ports.
    ...Object.fromEntries(
      ["owner", "writer", "reader"].map((role) => [
        role + "Token",
        process.env.CRM_TEST_REUSE_AUTH === "1"
          ? config[role + "Token"]
          : randomBytes(32).toString("hex"),
      ]),
    ),
  };
  const filename = path.join(directory, "http-config.json");
  await writeFile(filename, JSON.stringify(httpConfig), { mode: 0o600 });
  const largeFilename = path.join(directory, "large-config.json");
  await writeFile(
    largeFilename,
    JSON.stringify({
      ...httpConfig,
      port: 4392,
      dataDir: path.join(directory, "large-data"),
      databaseUrl: urls[2],
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "test/domain.integration.test.mjs",
      "test/http-mcp.test.mjs",
      "test/large-file.test.mjs",
      "test/connections.test.mjs",
      "test/projection.test.mjs",
      "test/products.test.mjs",
      "test/product-workflow.test.mjs",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        CRM_TEST_DATABASE_URL: urls[0],
        CRM_PRODUCT_TEST_DATABASE_URL: urls[3],
        CRM_PRODUCT_RESTORE_DATABASE_URL: urls[4],
        CRM_PRODUCT_TEST_DATA_DIR: path.join(directory, "product-data"),
        CRM_TEST_DATA_DIR: path.join(directory, "domain-data"),
        CRM_TEST_KEEP_DATA: "1",
        CRM_HTTP_TEST_CONFIG: filename,
        CRM_LARGE_TEST_CONFIG: largeFilename,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const chunks = [];
  child.stdout.on("data", (b) => {
    chunks.push(b);
    process.stdout.write(b);
  });
  child.stderr.on("data", (b) => {
    chunks.push(b);
    process.stderr.write(b);
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  const retain = code !== 0 || process.env.CRM_TEST_KEEP_DATA === "1";
  if (!retain) {
    // Only remove the five random database names this invocation created.
    for (const name of names)
      await pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await rm(directory, { recursive: true, force: true });
  }
  await mkdir(path.join(projectRoot, "test/results"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "test/results/latest.tap"),
    Buffer.concat(chunks),
  );
  await writeFile(
    path.join(projectRoot, "test/results/automated.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        exitCode: code,
        databases: names,
        scope:
          "independent synthetic databases; actual HTTP and official MCP client; no model calls",
        tap: "latest.tap",
        retainedForInspection: retain,
        successfulRunCleanup: !retain,
      },
      null,
      2,
    ),
  );
  process.exitCode = code || 0;
} finally {
  await pool.end();
}
