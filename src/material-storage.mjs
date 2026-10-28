import { constants } from "node:fs";
import { open, mkdir, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DomainError } from "./db.mjs";

// Decimal MB for original files; JSON tool calls remain deliberately bounded.
export const MAX_MATERIAL_BYTES = 500_000_000;
export const MAX_INLINE_BYTES = 32 * 1024 * 1024;
export const MAX_JSON_BYTES = 48 * 1024 * 1024;

export async function createMaterialStore(dataDir) {
  const objects = path.join(path.resolve(dataDir), "objects");
  await mkdir(objects, { recursive: true, mode: 0o700 });

  async function openVerified(objectPath, sha256, byteLength) {
    if (!/^[a-f0-9]{64}$/.test(sha256) || objectPath !== `objects/${sha256}`)
      throw new DomainError("STORAGE_CORRUPT", "原件路径与校验信息不一致", 500);
    let handle;
    try {
      handle = await open(
        path.join(objects, sha256),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== Number(byteLength))
        throw new Error("size mismatch");
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (position !== stat.size || digest.digest("hex") !== sha256)
        throw new Error("hash mismatch");
      return handle;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof DomainError) throw error;
      throw new DomainError("STORAGE_CORRUPT", "原件缺失或校验失败", 500, {
        sha256,
      });
    }
  }

  async function save(readable) {
    const temporary = path.join(objects, `.upload-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    let byteLength = 0;
    const digest = createHash("sha256");
    try {
      // Do not destroy an HTTP request on a limit error: its caller must still
      // be able to send a useful 413 response before closing the connection.
      const iterator = readable.iterator
        ? readable.iterator({ destroyOnReturn: false })
        : readable;
      for await (const value of iterator) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        byteLength += chunk.length;
        if (byteLength > MAX_MATERIAL_BYTES)
          throw new DomainError(
            "MATERIAL_TOO_LARGE",
            "单个原件上限 500 MB（500,000,000 字节）",
            413,
            { maxBytes: MAX_MATERIAL_BYTES },
          );
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          if (!bytesWritten) throw new Error("original write did not advance");
          offset += bytesWritten;
        }
      }
      if (!byteLength) throw new DomainError("VALIDATION", "材料为空");
      await handle.sync();
      await handle.close();
      const sha256 = digest.digest("hex");
      const objectPath = `objects/${sha256}`;
      try {
        // Hard-link publication is atomic and never replaces an existing original.
        await link(temporary, path.join(objects, sha256));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await openVerified(objectPath, sha256, byteLength);
        await existing.close();
      }
      return { sha256, objectPath, byteLength };
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  return { save, openVerified };
}
