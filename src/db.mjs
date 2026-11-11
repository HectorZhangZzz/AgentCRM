import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const { Pool } = pg;
export class DomainError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export async function openDatabase(
  databaseUrl,
  { productLibraryEnabled = false } = {},
) {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(5432104310)");
    await client.query("CREATE SCHEMA IF NOT EXISTS portable_crm");
    await client.query(
      "CREATE TABLE IF NOT EXISTS portable_crm.migrations (version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    const baseNames = (await readdir(dir)).filter((n) =>
      /^\d+_.*\.sql$/.test(n),
    );
    // Optional migrations are part of the checksum catalog but never auto-enabled.
    const optionalName = "002_product_entities.sql";
    const names = [...baseNames, optionalName].sort();
    const existing = (
      await client.query(
        "SELECT * FROM portable_crm.migrations ORDER BY version",
      )
    ).rows;
    for (const row of existing)
      if (!names.includes(row.version))
        throw new DomainError(
          "UNKNOWN_MIGRATION",
          "数据库版本比当前代码新，拒绝自动降级",
          409,
          { version: row.version },
        );
    for (const name of names) {
      const optional = name === optionalName;
      const sql = await readFile(
        `${dir}/${optional ? "optional/" : ""}${name}`,
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const old = existing.find((r) => r.version === name);
      if (old && old.checksum !== checksum)
        throw new DomainError(
          "MIGRATION_CHANGED",
          "迁移文件校验和改变，拒绝启动",
          409,
          { version: name },
        );
      if (!old && (!optional || productLibraryEnabled)) {
        await client.query(sql);
        await client.query(
          "INSERT INTO portable_crm.migrations(version,checksum) VALUES($1,$2)",
          [name, checksum],
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
    throw e;
  }
  client.release();
  return pool;
}
export async function transaction(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(5432104311)");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
