import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { createDomain } from "../src/domain.mjs";
import { projectRoot } from "../src/config.mjs";
import {
  MAX_MATERIAL_BYTES,
  MAX_INLINE_BYTES,
  MAX_JSON_BYTES,
} from "../src/material-storage.mjs";

const configFile = process.env.CRM_LARGE_TEST_CONFIG;
const writer = { role: "writer", actor: "synthetic-large-file-writer" };
const reader = { role: "reader", actor: "synthetic-large-file-reader" };
const chunk = Buffer.alloc(1024 * 1024, 0xa5);

// The fixture is generated a chunk at a time; no 500 MB fixture is committed or
// assembled in memory. An independent streaming hash checks the returned bytes.
function generatedStream(length, hash) {
  return Readable.from(
    (async function* () {
      let remaining = length;
      while (remaining > 0) {
        const part = chunk.subarray(0, Math.min(chunk.length, remaining));
        hash?.update(part);
        yield part;
        remaining -= part.length;
      }
    })(),
  );
}

async function filesUnder(directory) {
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else files.push(path.relative(directory, filename));
    }
  }
  await visit(directory);
  return files.sort();
}

test(
  "500 MB streamed originals: exact boundary, round trip, failures and compatibility",
  { skip: !configFile, timeout: 180000 },
  async (t) => {
    const cfg = JSON.parse(await readFile(configFile, "utf8"));
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
    const database = (await pool.query("SELECT current_database() db")).rows[0]
      .db;
    assert.match(
      database,
      /test_/i,
      "Only an isolated synthetic test database is allowed",
    );
    assert.equal(MAX_MATERIAL_BYTES, 500_000_000);
    assert.equal(MAX_INLINE_BYTES, 32 * 1024 * 1024);
    assert.equal(MAX_JSON_BYTES, 48 * 1024 * 1024);
    let domain = await createDomain(cfg);
    assert.equal(
      Number(
        (await pool.query("SELECT count(*) n FROM portable_crm.materials"))
          .rows[0].n,
      ),
      0,
      "Refuse to run against an existing material collection",
    );
    const base = `http://127.0.0.1:${cfg.port}`;
    const server = spawn(process.execPath, ["src/server.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, CRM_CONFIG: configFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [server.stdout, server.stderr]) {
      stream.on("data", (b) => {
        output = (output + b).slice(-2000);
      });
    }
    const result = {
      at: new Date().toISOString(),
      limitBytes: MAX_MATERIAL_BYTES,
      checks: [],
    };
    let largeId;
    const auth = (role = "writer") => ({
      Authorization: `Bearer ${cfg[role + "Token"]}`,
    });
    const countMaterials = async () =>
      Number(
        (await pool.query("SELECT count(*) n FROM portable_crm.materials"))
          .rows[0].n,
      );
    const record = (name) => result.checks.push(name);
    try {
      let healthy = false;
      for (let n = 0; n < 100; n++) {
        if (server.exitCode !== null)
          throw new Error("Large-file test server failed: " + output);
        try {
          healthy = (await fetch(base + "/healthz")).ok;
          if (healthy) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(healthy, "Test server did not become healthy");

      await t.test(
        "exactly 500,000,000 bytes upload and download with matching hash",
        async () => {
          const expected = createHash("sha256");
          const startedAt = Date.now();
          const response = await fetch(
            base +
              "/api/v1/upload?filename=synthetic-boundary-500MB.bin&source=large-file-test",
            {
              method: "POST",
              headers: {
                ...auth(),
                "Content-Type": "application/octet-stream",
                "Content-Length": String(MAX_MATERIAL_BYTES),
              },
              body: generatedStream(MAX_MATERIAL_BYTES, expected),
              duplex: "half",
            },
          );
          assert.equal(response.status, 200, await response.clone().text());
          const body = await response.json();
          largeId = body.materialId;
          const expectedSha256 = expected.digest("hex");
          assert.equal(Number(body.material.byteLength), MAX_MATERIAL_BYTES);
          assert.equal(body.material.sha256, expectedSha256);
          assert.equal(body.duplicate, false);
          assert.equal(
            (await stat(path.join(cfg.dataDir, body.material.objectPath))).size,
            MAX_MATERIAL_BYTES,
          );
          const download = await fetch(
            base + `/api/v1/materials/${largeId}/content`,
            {
              headers: auth("reader"),
            },
          );
          assert.equal(download.status, 200);
          assert.equal(
            Number(download.headers.get("content-length")),
            MAX_MATERIAL_BYTES,
          );
          const actual = createHash("sha256");
          let received = 0;
          for await (const part of download.body) {
            received += part.length;
            actual.update(part);
          }
          assert.equal(received, MAX_MATERIAL_BYTES);
          assert.equal(actual.digest("hex"), expectedSha256);
          result.boundary = {
            materialId: largeId,
            bytes: received,
            sha256: expectedSha256,
            durationMs: Date.now() - startedAt,
            fullBufferUsedByTest: false,
          };
          record(
            "actual 500,000,000-byte HTTP upload and hash-matching streamed download",
          );
        },
      );

      await t.test(
        "large metadata remains readable; inline contents stay bounded",
        async () => {
          assert.ok(largeId, "The boundary upload must have succeeded");
          const metadata = await domain.call(
            "crm_material",
            { materialId: largeId },
            reader,
          );
          assert.equal(
            Number(metadata.material.byteLength),
            MAX_MATERIAL_BYTES,
          );
          assert.equal(metadata.content, undefined);
          assert.equal(metadata.material.contentLoaded, false);
          await assert.rejects(
            domain.call(
              "crm_material",
              { materialId: largeId, includeContent: true },
              reader,
            ),
            (error) =>
              error.code === "CONTENT_TOO_LARGE" &&
              error.details?.downloadPath ===
                `/api/v1/materials/${largeId}/content`,
          );
          const before = await countMaterials();
          await assert.rejects(
            domain.call(
              "crm_ingest",
              { text: "x".repeat(MAX_INLINE_BYTES + 1) },
              writer,
            ),
            (error) => error.status === 413,
          );
          assert.equal(await countMaterials(), before);
          record(
            "metadata available while MCP/JSON inline upload and content remain 32 MiB bounded",
          );
        },
      );

      await t.test(
        "CLI streams the 500 MB original and deduplicates it",
        async () => {
          assert.ok(largeId, "The boundary upload must have succeeded");
          const stored = await domain.call(
            "crm_material",
            { materialId: largeId },
            reader,
          );
          const child = spawn(
            process.execPath,
            [
              "src/cli.mjs",
              "ingest",
              path.join(cfg.dataDir, stored.material.objectPath),
              "synthetic-cli-large-file",
            ],
            {
              cwd: projectRoot,
              env: {
                ...process.env,
                CRM_CONFIG: configFile,
                CRM_CLIENT_CONFIG: "",
                CRM_ROLE: "writer",
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (part) => {
            stdout += part;
          });
          child.stderr.on("data", (part) => {
            stderr += part;
          });
          const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
          try {
            const [code] = await once(child, "close");
            assert.equal(code, 0, stderr);
            const uploaded = JSON.parse(stdout);
            assert.equal(uploaded.materialId, largeId);
            assert.equal(uploaded.duplicate, true);
            assert.equal(
              Number(uploaded.material.byteLength),
              MAX_MATERIAL_BYTES,
            );
          } finally {
            clearTimeout(timer);
            if (child.exitCode === null) child.kill("SIGTERM");
          }
          const reread = await domain.call(
            "crm_material",
            { materialId: largeId },
            reader,
          );
          assert.equal(reread.receipts.length, 2);
          record(
            "actual 500 MB CLI import streams and reuses material while adding receipt",
          );
        },
      );

      await t.test(
        "stream and inline duplicate bytes reuse material and retain receipts",
        async () => {
          const text = "合成大文件回归：客户技术资料，未知时间保持未知。";
          const bytes = Buffer.from(text);
          const first = await domain.ingestStream(
            Readable.from([bytes]),
            {
              filename: "synthetic-document.txt",
              mimeType: "text/plain;charset=utf-8",
              source: "stream-test",
            },
            writer,
          );
          const second = await domain.call(
            "crm_ingest",
            {
              base64: bytes.toString("base64"),
              filename: "synthetic-document-copy.txt",
              mimeType: "text/plain;charset=utf-8",
              source: "inline-test",
            },
            writer,
          );
          assert.equal(first.materialId, second.materialId);
          assert.equal(first.duplicate, false);
          assert.equal(second.duplicate, true);
          const stored = await domain.call(
            "crm_material",
            { materialId: first.materialId, includeContent: true },
            reader,
          );
          assert.equal(stored.content.text, text);
          assert.equal(stored.receipts.length, 2);
          assert.equal(stored.material.occurredAt, null);
          assert.ok(
            stored.material.qualityFlags.includes("communication_time_unknown"),
          );
          record(
            "stream/inline deduplication, separate receipts and small UTF-8 compatibility",
          );
        },
      );

      await t.test(
        "reopening domain preserves large-file identity, metadata and original",
        async () => {
          assert.ok(largeId, "The boundary upload must have succeeded");
          await domain.close();
          domain = await createDomain(cfg);
          const persisted = await domain.call(
            "crm_material",
            { materialId: largeId },
            reader,
          );
          assert.equal(
            Number(persisted.material.byteLength),
            MAX_MATERIAL_BYTES,
          );
          assert.equal(persisted.material.sha256, result.boundary.sha256);
          assert.equal(persisted.receipts.length, 2);
          const opened = await domain.openOriginal(largeId, reader);
          try {
            assert.equal(opened.material.id, largeId);
            assert.equal((await opened.handle.stat()).size, MAX_MATERIAL_BYTES);
          } finally {
            await opened.handle.close();
          }
          record("domain reopen preserves identity and verifies original");
        },
      );

      await t.test(
        "undeclared 500 MB plus one byte rejects without material or leftover files",
        async () => {
          const before = await countMaterials();
          const existingFiles = await filesUnder(cfg.dataDir);
          await assert.rejects(
            domain.ingestStream(
              generatedStream(MAX_MATERIAL_BYTES + 1),
              {
                filename: "synthetic-oversized.bin",
                mimeType: "application/octet-stream",
              },
              writer,
            ),
            (error) => error.status === 413,
          );
          assert.equal(await countMaterials(), before);
          assert.deepEqual(await filesUnder(cfg.dataDir), existingFiles);
          record(
            "actual overflow rejected with no DB row, object or temporary file left behind",
          );
        },
      );

      await t.test(
        "chunked HTTP upload over 500 MB returns JSON 413 and cleans staged bytes",
        async () => {
          const before = await countMaterials();
          const existingFiles = await filesUnder(cfg.dataDir);
          const response = await fetch(
            base + "/api/v1/upload?filename=synthetic-chunked-oversized.bin",
            {
              method: "POST",
              headers: {
                ...auth(),
                "Content-Type": "application/octet-stream",
              },
              // No Content-Length: the stream itself must enforce the limit.
              body: generatedStream(MAX_MATERIAL_BYTES + 1),
              duplex: "half",
            },
          );
          assert.equal(response.status, 413);
          const body = await response.json();
          assert.equal(body.error.code, "MATERIAL_TOO_LARGE");
          assert.equal(await countMaterials(), before);
          assert.deepEqual(await filesUnder(cfg.dataDir), existingFiles);
          record(
            "actual chunked HTTP overflow returns JSON 413 without rows or leftover files",
          );
        },
      );

      await t.test(
        "interrupted stream cleans staged bytes without a record",
        async () => {
          const before = await countMaterials();
          const existingFiles = await filesUnder(cfg.dataDir);
          const interrupted = Readable.from(
            (async function* () {
              yield chunk;
              throw new Error("synthetic upload interrupted");
            })(),
          );
          await assert.rejects(
            domain.ingestStream(
              interrupted,
              {
                filename: "synthetic-interrupted.bin",
                mimeType: "application/octet-stream",
              },
              writer,
            ),
            /synthetic upload interrupted/,
          );
          assert.equal(await countMaterials(), before);
          assert.deepEqual(await filesUnder(cfg.dataDir), existingFiles);
          record("interrupted upload cleanup");
        },
      );

      await t.test(
        "HTTP client disconnect cleans partially received original",
        async () => {
          const before = await countMaterials();
          const existingFiles = await filesUnder(cfg.dataDir);
          const req = httpRequest(
            base + "/api/v1/upload?filename=synthetic-http-disconnected.bin",
            {
              method: "POST",
              headers: {
                ...auth(),
                "Content-Type": "application/octet-stream",
                "Content-Length": String(10 * 1024 * 1024),
              },
            },
          );
          // Aborting deliberately produces ECONNRESET; a normal response would
          // also be drained to avoid leaving a live client connection.
          req.on("error", () => {});
          req.on("response", (response) => response.resume());
          const closed = new Promise((resolve) => req.once("close", resolve));
          try {
            req.write(chunk);
            let sawStagedBytes = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const staged = (await filesUnder(cfg.dataDir)).filter(
                (filename) =>
                  !existingFiles.includes(filename) &&
                  path.basename(filename).startsWith(".upload-"),
              );
              for (const filename of staged) {
                try {
                  if ((await stat(path.join(cfg.dataDir, filename))).size > 0)
                    sawStagedBytes = true;
                } catch (error) {
                  if (error.code !== "ENOENT") throw error;
                }
              }
              if (sawStagedBytes) break;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert.ok(
              sawStagedBytes,
              "Expected upload to write temporary bytes before disconnect",
            );
          } finally {
            req.destroy();
            await closed;
          }
          let cleaned = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            cleaned =
              JSON.stringify(await filesUnder(cfg.dataDir)) ===
              JSON.stringify(existingFiles);
            if (cleaned) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.ok(cleaned, "Client disconnect left upload bytes behind");
          assert.equal(await countMaterials(), before);
          record(
            "actual HTTP client disconnect cleans partially received original without record",
          );
        },
      );

      await t.test(
        "reader cannot stream writes and oversized declared length rejects before body",
        async () => {
          const before = await countMaterials();
          await assert.rejects(
            domain.ingestStream(
              Readable.from([Buffer.from("reader must not upload")]),
              {},
              reader,
            ),
            (error) => error.code === "FORBIDDEN",
          );
          const denied = await fetch(
            base + "/api/v1/upload?filename=reader-denied.bin",
            {
              method: "POST",
              headers: auth("reader"),
              body: "reader must not upload",
            },
          );
          assert.equal(denied.status, 403);
          await denied.arrayBuffer();
          const early = await new Promise((resolve, reject) => {
            const req = httpRequest(
              base + "/api/v1/upload?filename=declared-too-large.bin",
              {
                method: "POST",
                headers: {
                  ...auth(),
                  "Content-Type": "application/octet-stream",
                  "Content-Length": String(MAX_MATERIAL_BYTES + 1),
                },
              },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (part) => {
                  body += part;
                });
                response.on("end", () => {
                  resolve({ status: response.statusCode, body });
                  req.destroy();
                });
              },
            );
            req.on("error", reject);
            req.setTimeout(5000, () =>
              req.destroy(
                new Error(
                  "Declared oversized request was not rejected before body",
                ),
              ),
            );
            // Deliberately only send headers: rejection must not wait for 500 MB.
            req.flushHeaders();
          });
          assert.equal(early.status, 413);
          assert.ok(JSON.parse(early.body).error.code);
          assert.equal(await countMaterials(), before);
          record(
            "reader denied and declared oversized Content-Length rejected without sending body",
          );
        },
      );

      await t.test(
        "streaming original access detects tampering before download",
        async () => {
          const original = Buffer.from("synthetic integrity fixture");
          const saved = await domain.ingestStream(
            Readable.from([original]),
            {
              filename: "integrity.bin",
              mimeType: "application/octet-stream",
            },
            writer,
          );
          await writeFile(
            path.join(cfg.dataDir, saved.material.objectPath),
            Buffer.from("tampered integrity fixture"),
          );
          await assert.rejects(
            domain.openOriginal(saved.materialId, reader),
            (error) => error.code === "STORAGE_CORRUPT",
          );
          const response = await fetch(
            base + `/api/v1/materials/${saved.materialId}/content`,
            { headers: auth("reader") },
          );
          assert.equal(response.status, 500);
          assert.equal((await response.json()).error.code, "STORAGE_CORRUPT");
          record("tampered originals fail verified streaming access");
        },
      );
      result.completed = result.checks.length === 11;
    } finally {
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        await once(server, "exit");
      }
      await domain.close();
      await pool.end();
      result.completed ??= false;
      await mkdir(path.join(projectRoot, "test/results"), { recursive: true });
      await writeFile(
        path.join(projectRoot, "test/results/large-file.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
    }
  },
);
