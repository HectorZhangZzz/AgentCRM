#!/usr/bin/env python3
"""Build a source-only sharing ZIP without opening local CRM configuration/data."""

import argparse
import hashlib
import json
import os
import re
import stat
import zipfile
from pathlib import Path


FORMAT = "agent-crm-source-share-v1"
MANIFEST_NAME = "share-manifest.json"
README_NAME = "SHARE_README.md"
ROOT_FILES = {
    "README.md", "AGENTS.md", "package.json", "package-lock.json",
    ".gitignore", ".gitattributes", ".dockerignore", "Dockerfile",
    "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml",
}
ROOT_DIRS = {
    "docs", "skills", "src", "public", "migrations", "ops", "examples",
    "test", "integrations", "deploy", "docker",
}
EXCLUDED_FILES = {
    # Unreferenced upstream meeting/debug capture, not a synthetic fixture.
    "vendor/twenty/packages/twenty-companion/test.json",
}
EXCLUDED_DIRS = {
    ".local", ".git", ".hg", ".svn", "backups", "exports", "share",
    "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".cache", "dist", ".nx", "coverage",
    ".next", ".turbo", ".terraform", ".venv", "venv",
}
PRIVATE_NAMES = {
    "private-secrets.json", "writer-client.json", "reader-client.json",
    "twenty-access.json", "credentials.json", "secrets.json", "config.local.json",
    ".npmrc", ".pypirc", ".netrc", ".yarn-integrity", ".yarn-state.yml",
    ".pnp.cjs", ".pnp.loader.mjs", ".DS_Store",
}
PRIVATE_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"}
GENERATED_SUFFIXES = {".pyc", ".pyo", ".log", ".tsbuildinfo", ".zip", ".gz", ".tar", ".dump", ".backup", ".db", ".sqlite", ".sqlite3"}
# Environment templates are excluded too. If needed, add a reviewed, inert JSON
# template to integrations/ rather than distributing any .env file.
SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE" + rb" KEY-----"),
    re.compile(rb"sk-" + rb"(?:proj-|svcacct-)[A-Za-z0-9_-]{40,}"),
    re.compile(rb"gh[pousr]_" + rb"[A-Za-z0-9]{36,}"),
)
CHUNK = 1024 * 1024

SHARE_README = """# Agent CRM — 源码分享包

这是供朋友安装和 Agent 接管的源码包，不是个人资料迁移备份。

- 包含项目代码、Skill、文档、合成示例/测试和 Twenty 上游源码及其许可文件。
- 不包含客户数据库、原始附件、真实聊天、访问令牌、账号密码、已有备份、运行时二进制或安装依赖。
- 安装前先读 README.md、docs/INSTALL.md 和 docs/HANDOFF.md；按目标系统准备 Node.js、Python、PostgreSQL、Redis，再安装锁定依赖并构建所需组件。
- 首次安装应建立全新数据库和凭据。不要把别人的 .local/、私有备份或客户端令牌放进本包。
- Docker、Windows 和各宿主的可用程度以随包文档的实测记录为准；此源码包不证明这些环境已经验收，也不保证解压后直接运行。
- 需要迁移自己的历史数据时，另行使用完整私有备份恢复流程；只用本包无法恢复客户资料。
- vendor/twenty/LICENSE 及各依赖/目录的许可继续适用；本包没有重新授予第三方代码许可。

share-manifest.json 记录相对路径、字节数和 SHA256；ZIP 同目录的 .sha256 文件用于核验整个 ZIP。
本工具按源码允许目录及文件排除规则打包，并拒绝已识别的私钥/令牌模式；它不能识别任意写进源码、文档或示例里的个人资料。分享前仍应审阅自己修改的源码和文档。
"""


def _root_file_allowed(name):
    return name in ROOT_FILES or name.startswith(("LICENSE", "NOTICE", "COPYING", "Dockerfile."))


def _excluded(rel):
    parts = rel.parts
    if rel.as_posix() in EXCLUDED_FILES:
        return True
    if any(part.lower() in {x.lower() for x in EXCLUDED_DIRS} for part in parts):
        return True
    if len(parts) >= 2 and parts[0] == "test" and parts[1] == "results":
        return True
    if "results" in parts and "test" in parts:
        return True
    if ".yarn" in parts and any(x in parts for x in ("cache", "unplugged", "install-state.gz")):
        return True
    # `cache`, `build` and `runtime` can be real upstream source module names.
    # Root runtime/ is not allowlisted; dependency caches are excluded above.
    name = parts[-1]
    low = name.lower()
    if ".bak-" in low or ".before-" in low or low.endswith(("~", ".bak", ".orig", ".rej")):
        return True
    if low.startswith(".env") or low in {x.lower() for x in PRIVATE_NAMES}:
        return True
    if low.startswith(("id_rsa", "id_ed25519", "credentials.", "secrets.")):
        return True
    return Path(low).suffix in PRIVATE_SUFFIXES | GENERATED_SUFFIXES


def _source_files(root):
    """Walk only approved roots; reject links instead of following them."""
    found = []

    def visit(path):
        rel = path.relative_to(root)
        if _excluded(rel):
            return
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError(f"源码目录存在符号链接，分享已停止：{rel.as_posix()}")
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir(), key=lambda p: p.name):
                visit(child)
        elif stat.S_ISREG(info.st_mode):
            found.append(rel)
        else:
            raise RuntimeError(f"源码包含非常规文件，分享已停止：{rel.as_posix()}")

    for child in sorted(root.iterdir(), key=lambda p: p.name):
        if _root_file_allowed(child.name) or child.name in ROOT_DIRS:
            visit(child)
    upstream = root / "vendor" / "twenty"
    if upstream.exists() or upstream.is_symlink():
        if (root / "vendor").is_symlink():
            raise RuntimeError("源码目录存在符号链接，分享已停止：vendor")
        visit(upstream)
    return sorted(found, key=lambda p: p.as_posix())


def _zip_info(name, executable=False):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = ((0o100755 if executable else 0o100644) << 16)
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def _copy_source(zipped, root, rel):
    path = root / rel
    before = path.lstat()
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    digest = hashlib.sha256()
    count = 0
    tail = b""
    with os.fdopen(fd, "rb") as source:
        current = os.fstat(source.fileno())
        if not stat.S_ISREG(current.st_mode) or (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError(f"打包时源码发生变化：{rel.as_posix()}")
        with zipped.open(_zip_info(rel.as_posix(), bool(current.st_mode & 0o111)), "w", force_zip64=True) as target:
            while data := source.read(CHUNK):
                scan = tail + data
                if any(pattern.search(scan) for pattern in SECRET_PATTERNS):
                    raise RuntimeError(f"源码含疑似私钥或访问令牌，分享已停止：{rel.as_posix()}")
                tail = scan[-512:]
                digest.update(data)
                count += len(data)
                target.write(data)
        after = path.lstat()
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or count != before.st_size:
            raise RuntimeError(f"打包时源码发生变化：{rel.as_posix()}")
    return {"bytes": count, "sha256": digest.hexdigest()}


def _digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(CHUNK):
            result.update(data)
    return result.hexdigest()


def create_share(project_root, out):
    """Create a new ZIP and checksum; never open configuration or business data.

    `out` is the exact new .zip path. Existing ZIP/checksum paths are refused.
    Relative `out` is interpreted relative to the caller's working directory.
    """
    root = Path(project_root).resolve(strict=True)
    if not root.is_dir():
        raise RuntimeError("项目根路径必须是目录")
    out = Path(out).absolute()
    if out.suffix.lower() != ".zip" or any(c in out.name for c in '\r\n<>:"|?*\\'):
        raise RuntimeError("分享目标必须是普通文件名的 .zip 文件")
    checksum = out.with_name(out.name + ".sha256")
    if out.exists() or out.is_symlink() or checksum.exists() or checksum.is_symlink():
        raise RuntimeError("分享目标或校验文件已经存在，不能覆盖")
    resolved = out.resolve(strict=False)
    if resolved.is_relative_to(root):
        rel = resolved.relative_to(root)
        if rel.parts and (rel.parts[0] in ROOT_DIRS | {"vendor"} or _root_file_allowed(rel.parts[0])):
            raise RuntimeError("分享目标不能位于需要打包的源码目录内")
    for reserved in (MANIFEST_NAME, README_NAME):
        if (root / reserved).exists() or (root / reserved).is_symlink():
            raise RuntimeError(f"项目根目录含保留的分享文件名：{reserved}")
    sources = _source_files(root)
    if Path("package.json") not in sources:
        raise RuntimeError("项目缺少 package.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    created = []
    try:
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created.append(out)
        with os.fdopen(fd, "w+b") as stream:
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as zipped:
                files = {rel.as_posix(): _copy_source(zipped, root, rel) for rel in sources}
                readme = SHARE_README.encode("utf-8")
                zipped.writestr(_zip_info(README_NAME), readme)
                files[README_NAME] = {"bytes": len(readme), "sha256": hashlib.sha256(readme).hexdigest()}
                manifest = {"format": FORMAT, "project": "Agent CRM", "sourceOnly": True, "businessDataIncluded": False, "files": dict(sorted(files.items()))}
                zipped.writestr(_zip_info(MANIFEST_NAME), (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        sha256 = _digest(out)
        fd = os.open(checksum, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created.append(checksum)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(f"{sha256}  {out.name}\n")
            stream.flush()
            os.fsync(stream.fileno())
        return {"bundle": str(out), "sha256File": str(checksum), "sha256": sha256, "files": len(files), "bytes": out.stat().st_size, "sourceOnly": True}
    except BaseException:
        for path in reversed(created):
            path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description="Create an Agent CRM source-only sharing package")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    print(json.dumps(create_share(args.root, args.out), ensure_ascii=False))


if __name__ == "__main__":
    main()
