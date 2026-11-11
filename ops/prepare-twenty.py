#!/usr/bin/env python3
"""Obtain a pinned official Twenty source in a NEW Linux/WSL project only.

No CRM configuration, data, credentials, original archive or existing vendor
source is opened. No dependency scripts, build or application process is run.
Twenty's upstream licenses remain applicable; obtaining source is not a grant
of rights to Enterprise features or a claim that a clean build was validated.
"""

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import tempfile
import urllib.request


FORMAT = "agent-crm-upstream-source-v1"
REPOSITORY = "https://github.com/twentyhq/twenty"
MAX_ARCHIVE_BYTES = 300 * 1024 * 1024
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_MEMBERS = 40000
CHUNK = 1024 * 1024


def _relative(name):
    if (not isinstance(name, str) or not name or "\\" in name or
            any(c in name for c in "\x00\r\n") or
            any(p in {"", ".", ".."} for p in name.split("/"))):
        raise RuntimeError("源码包含不安全的相对路径")
    path = PurePosixPath(name)
    if path.is_absolute() or ":" in path.parts[0]:
        raise RuntimeError("源码包含绝对路径或盘符")
    return path


def load_spec(path):
    spec = json.loads(Path(path).read_text(encoding="utf-8"))
    commit = spec.get("commit", "")
    archive = spec.get("archive", {})
    if (spec.get("format") != FORMAT or spec.get("repository") != REPOSITORY or
            not re.fullmatch(r"[a-f0-9]{40}", commit) or
            archive.get("url") != "https://codeload.github.com/twentyhq/twenty/tar.gz/" + commit or
            archive.get("prefix") != "twenty-" + commit or
            not re.fullmatch(r"[a-f0-9]{64}", archive.get("sha256", "")) or
            type(archive.get("bytes")) is not int or not 0 < archive["bytes"] <= MAX_ARCHIVE_BYTES):
        raise RuntimeError("上游来源清单无效；只接受固定官方提交及完整 SHA256")
    fingerprints = spec.get("fingerprints", {})
    if not isinstance(fingerprints, dict) or not {"LICENSE", "package.json", "yarn.lock"} <= set(fingerprints):
        raise RuntimeError("上游来源清单缺少许可或依赖指纹")
    for name, digest in fingerprints.items():
        _relative(name)
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise RuntimeError("上游源码指纹无效")
    return spec


def _no_links(path):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if part.is_symlink():
            raise RuntimeError("目标路径不能包含符号链接")
    return path


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError("固定官方下载地址发生重定向，已停止")


def _copy_archive(spec, target, cached=None):
    """Copy/download into private staging, enforcing size and SHA before use."""
    archive = spec["archive"]
    if cached is not None:
        path = _no_links(cached)
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise RuntimeError("缓存归档必须是普通文件")
        source = os.fdopen(fd, "rb")
    else:
        request = urllib.request.Request(archive["url"], headers={"User-Agent": "Agent-CRM-pinned-source"})
        source = urllib.request.build_opener(_NoRedirect()).open(request, timeout=45)
    digest = hashlib.sha256()
    size = 0
    with source, target.open("xb") as output:
        while chunk := source.read(CHUNK):
            size += len(chunk)
            if size > archive["bytes"]:
                raise RuntimeError("下载归档大小超出固定清单")
            digest.update(chunk)
            output.write(chunk)
    if size != archive["bytes"] or digest.hexdigest() != archive["sha256"]:
        raise RuntimeError("上游归档大小或 SHA256 校验失败；未安装任何源码")


def _extract(archive, destination, spec):
    prefix = spec["archive"]["prefix"]
    destination.mkdir()
    with tarfile.open(archive, "r:gz") as source:
        members = []
        paths = set()
        total = 0
        # Validate the entire member list before writing extracted source.
        for member in source:
            if len(members) >= MAX_MEMBERS:
                raise RuntimeError("上游归档文件数量超限")
            name = member.name.rstrip("/")
            path = _relative(name)
            if path.parts[0] != prefix:
                raise RuntimeError("上游归档顶层路径与固定提交不符")
            if name in paths:
                raise RuntimeError("上游归档包含重复路径")
            paths.add(name)
            if not member.isdir() and not member.isfile():
                raise RuntimeError("上游归档包含链接或非常规文件")
            total += member.size
            if member.size < 0 or total > MAX_EXPANDED_BYTES:
                raise RuntimeError("上游归档解压大小超限")
            members.append((member, path.parts[1:]))
        for member, parts in members:
            if not parts:
                if not member.isdir():
                    raise RuntimeError("上游归档根必须是目录")
                continue
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as data, target.open("xb") as output:
                size = 0
                while chunk := data.read(CHUNK):
                    size += len(chunk)
                    output.write(chunk)
                if size != member.size:
                    raise RuntimeError("上游归档成员不完整")
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    for name, expected in spec["fingerprints"].items():
        path = destination.joinpath(*_relative(name).parts)
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError("上游许可或依赖文件指纹校验失败")
    return sum(member.isfile() for member, unused in members)


def _publish(source, target):
    """Linux atomic rename with NOREPLACE: never overwrite even an empty dir."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise RuntimeError("系统缺少安全的不覆盖目录操作；请使用受支持的 Linux/WSL2")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1):
        code = ctypes.get_errno()
        if code in (errno.EEXIST, errno.ENOTEMPTY):
            raise RuntimeError("vendor/twenty 已存在，拒绝覆盖")
        raise RuntimeError("无法安全安装上游源码（errno " + str(code) + "）")


def prepare(root, spec, cached=None):
    if not sys.platform.startswith("linux"):
        raise RuntimeError("此准备器支持 Linux/WSL2；Windows 原生运行尚未适配")
    root = _no_links(root)
    if not root.is_dir():
        raise RuntimeError("项目根目录不存在")
    vendor = _no_links(root / "vendor")
    target = vendor / "twenty"
    if target.exists() or target.is_symlink():
        raise RuntimeError("vendor/twenty 已存在，拒绝覆盖；本机正式环境不需要执行此命令")
    if vendor.exists() and not vendor.is_dir():
        raise RuntimeError("vendor 必须是普通目录")
    vendor.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".twenty-source-", dir=vendor) as temporary:
        stage = Path(temporary)
        archive = stage / "source.tar.gz"
        _copy_archive(spec, archive, cached)
        tree = stage / "tree"
        count = _extract(archive, tree, spec)
        _no_links(vendor)
        _publish(tree, target)
    return {"project": "Twenty", "commit": spec["commit"], "source": str(target),
            "archiveSha256": spec["archive"]["sha256"], "files": count,
            "dependenciesInstalled": False, "buildVerified": False,
            "note": "已取得官方固定源码并保留其许可；未安装依赖、构建或运行，也未复制旧AI/Docker定制。"}


def main():
    root = Path(__file__).absolute().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(root), help="New project root; never an initialized vendor directory")
    parser.add_argument("--archive", help="Optional existing official archive; same fixed SHA256 is mandatory")
    args = parser.parse_args()
    try:
        spec = load_spec(root / "deploy/twenty/source.json")
        result = prepare(args.root, spec, args.archive)
    except (RuntimeError, OSError, ValueError, tarfile.TarError) as error:
        parser.exit(1, "Agent CRM upstream source: " + str(error) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
