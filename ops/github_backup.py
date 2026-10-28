#!/usr/bin/env python3
"""Prepare an independent, source-only Git history; optionally publish privately.

No CRM credentials or business storage are opened.  The original repository's
history is never copied or pushed.  Authentication is supplied by an already
authenticated GitHub CLI; this program does not log in or change global config.
"""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import tempfile
import zipfile

from share_package import create_share, FORMAT as SHARE_FORMAT, MANIFEST_NAME


FORMAT = "agent-crm-github-source-v1"
INFO = "BACKUP_INFO.json"
MARKER = "agent-crm-source-backup.json"
MAX_FILE_BYTES = 100 * 1024 * 1024
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\Z")


def _environment():
    # Do not inherit another checkout's GIT_DIR/worktree, credential helpers or
    # user hooks. GitHub CLI itself retains its normal authenticated environment.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_TERMINAL_PROMPT="0", GH_PROMPT_DISABLED="1", GH_HOST="github.com")
    return env


def _git(directory, *args, check=True, input=None, credentials=None):
    command = ["git", "-c", "core.hooksPath=" + os.devnull,
               "-c", "commit.gpgSign=false"]
    if credentials:
        command += ["-c", "credential.helper=", "-c",
                    "credential.helper=!" + shlex.quote(str(credentials)) + " auth git-credential",
                    "-c", "core.askPass=", "-c", "credential.interactive=false"]
    result = subprocess.run(command + list(args), cwd=directory, env=_environment(),
                            input=input, capture_output=True, text=True)
    if check and result.returncode:
        # Remote failures can contain credential-bearing URLs. Never echo raw
        # subprocess diagnostics, command lines, environment or stdin.
        raise RuntimeError("Git 操作失败（" + str(args[0]) + "）；未强制推送或改写原项目历史。")
    return result


def _paths(root):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise RuntimeError("项目根路径必须是目录")
    local = root / ".local"
    if local.is_symlink() or (local.exists() and not local.is_dir()):
        raise RuntimeError(".local 必须是项目内的普通目录")
    local.mkdir(mode=0o700, exist_ok=True)
    return root, local, local / "github-source"


@contextmanager
def _lock(local):
    path = local / "github-backup.lock"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise RuntimeError("GitHub 备份正在进行，或上次中断留下锁；确认没有备份进程后再移除 .local/github-backup.lock。") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(str(os.getpid()) + "\n")
        yield
    finally:
        path.unlink(missing_ok=True)


def _safe_relative(name):
    path = PurePosixPath(name)
    if (not isinstance(name, str) or not name or path.is_absolute() or
            "\\" in name or any(char in name for char in "\r\n\x00") or
            any(part in {"", ".", "..", ".git"} for part in name.split("/"))):
        raise RuntimeError("源码清单包含不安全的相对路径")
    return path


def _extract_bundle(bundle, destination):
    """Verify every member before it becomes a candidate tracked file."""
    with zipfile.ZipFile(bundle) as zipped:
        names = zipped.namelist()
        if len(names) != len(set(names)):
            raise RuntimeError("源码包包含重复成员")
        manifest = json.loads(zipped.read(MANIFEST_NAME))
        if (manifest.get("format") != SHARE_FORMAT or manifest.get("sourceOnly") is not True or
                manifest.get("businessDataIncluded") is not False or not isinstance(manifest.get("files"), dict)):
            raise RuntimeError("源码包不是已知的纯源码格式")
        if set(names) != set(manifest["files"]) | {MANIFEST_NAME} or INFO in names:
            raise RuntimeError("源码包成员与清单不一致，或占用了备份说明文件名")
        files = {}
        for name in names:
            relative = _safe_relative(name)
            member = zipped.getinfo(name)
            if member.is_dir() or (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError("源码包不能包含目录项或符号链接")
            if member.file_size > MAX_FILE_BYTES:
                raise RuntimeError("源码包含超过 GitHub 单文件限制的文件：" + name)
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            size = 0
            with zipped.open(member) as source, target.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            if name != MANIFEST_NAME:
                expected = manifest["files"][name]
                if expected != {"bytes": size, "sha256": digest.hexdigest()}:
                    raise RuntimeError("源码包校验失败：" + name)
            os.chmod(target, 0o755 if (member.external_attr >> 16) & 0o111 else 0o644)
            files[name] = {"bytes": size, "sha256": digest.hexdigest()}
        return files


def _author(root):
    result = _git(root, "log", "-1", "--format=%an%x00%ae").stdout.strip()
    parts = result.split("\x00")
    if len(parts) != 2 or any(not part or any(c in part for c in "\r\n") for part in parts):
        raise RuntimeError("原项目必须有可用的上一条提交作者身份")
    return parts


def _marker(snapshot):
    if snapshot.is_symlink() or not snapshot.is_dir() or (snapshot / ".git").is_symlink() or not (snapshot / ".git").is_dir():
        raise RuntimeError("源码快照目录不是本工具创建的独立 Git 仓库，已停止以保护现有文件")
    path = snapshot / ".git" / MARKER
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("源码快照缺少管理标记，不能覆盖现有目录")
    try:
        marker = json.loads(path.read_text(encoding="utf-8"))
        names = marker["files"]
        if marker.get("format") != FORMAT or not isinstance(names, list) or len(names) != len(set(names)):
            raise ValueError()
        for name in names:
            _safe_relative(name)
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("源码快照管理标记无效") from None
    tracked = set(filter(None, _git(snapshot, "ls-files", "-z").stdout.split("\x00")))
    if tracked != set(names):
        raise RuntimeError("源码快照的已跟踪文件与管理标记不符")
    if _git(snapshot, "branch", "--show-current").stdout.strip() != "main":
        raise RuntimeError("源码快照必须处于 main 分支")
    if _git(snapshot, "status", "--porcelain", "--untracked-files=all").stdout:
        raise RuntimeError("源码快照存在未提交修改，请先检查；不会覆盖这些修改")
    actual = set()
    allowed_dirs = {str(parent) for name in names for parent in PurePosixPath(name).parents if str(parent) != "."}
    for base, dirs, files in os.walk(snapshot, followlinks=False):
        relative_base = Path(base).relative_to(snapshot)
        if relative_base == Path(".") and ".git" in dirs:
            dirs.remove(".git")
        for name in dirs:
            path = Path(base) / name
            rel = path.relative_to(snapshot).as_posix()
            if path.is_symlink() or rel not in allowed_dirs:
                raise RuntimeError("源码快照含未管理目录或链接，不能覆盖：" + rel)
        for name in files:
            path = Path(base) / name
            rel = path.relative_to(snapshot).as_posix()
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("源码快照含链接或非常规文件：" + rel)
            actual.add(rel)
    if actual != set(names):
        raise RuntimeError("源码快照含未管理文件（包括被 Git 忽略的文件），不能覆盖")
    return marker


def _write_marker(snapshot, names):
    path = snapshot / ".git" / MARKER
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"format": FORMAT, "files": sorted(names)}, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def _prepare(root, local, snapshot):
    existing = snapshot.exists() or snapshot.is_symlink()
    previous = _marker(snapshot) if existing else None
    author_name, author_email = _author(root)
    source_commit = _git(root, "rev-parse", "HEAD").stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40,64}", source_commit):
        raise RuntimeError("无法识别原项目提交")
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    with tempfile.TemporaryDirectory(prefix="github-stage-", dir=local) as temporary:
        stage = Path(temporary)
        bundle = stage / "source.zip"
        create_share(root, bundle)
        tree = stage / "tree"
        tree.mkdir()
        files = _extract_bundle(bundle, tree)
        info = {"format": FORMAT, "project": "Agent CRM", "sourceOnly": True,
                "businessDataIncluded": False, "sourceCommit": source_commit, "version": version,
                "sourceManifestSha256": files[MANIFEST_NAME]["sha256"],
                "history": "Independent source-only history; original repository history is excluded.",
                "restore": "This repository cannot restore customer databases, attachments or credentials."}
        (tree / INFO).write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        names = set(files) | {INFO}
        if not existing:
            _git(tree, "init", "--initial-branch=main")
            working = tree
        else:
            # Revalidate after potentially lengthy packaging, before changing any
            # previously managed file. Unknown or edited files are never erased.
            _marker(snapshot)
            for name in previous["files"]:
                (snapshot / name).unlink()
            for base, dirs, unused in os.walk(snapshot, topdown=False):
                path = Path(base)
                if path == snapshot or path.is_relative_to(snapshot / ".git"):
                    continue
                try:
                    path.rmdir()
                except OSError:
                    pass
            for name in names:
                target = snapshot / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(tree / name, target)
            working = snapshot
        _git(working, "add", "--force", "--all", "--", ".")
        changed = _git(working, "diff", "--cached", "--quiet", check=False).returncode
        if changed not in (0, 1):
            raise RuntimeError("无法比较源码快照")
        if changed:
            _git(working, "-c", "user.name=" + author_name, "-c", "user.email=" + author_email,
                 "commit", "-m", "Back up Agent CRM " + str(version) + " source")
        _write_marker(working, names)
        if not existing:
            if snapshot.exists() or snapshot.is_symlink():
                raise RuntimeError("源码快照目标在准备过程中出现，未覆盖")
            tree.rename(snapshot)
        _marker(snapshot)
        return {"sourceOnly": True, "snapshot": str(snapshot), "version": version,
                "head": _git(snapshot, "rev-parse", "HEAD").stdout.strip(),
                "files": len(names), "committed": bool(changed), "published": False}


def prepare(root):
    root, local, snapshot = _paths(root)
    with _lock(local):
        return _prepare(root, local, snapshot)


def _find_gh(root, override=None):
    candidate = override or shutil.which("gh") or root / ".local/tools/github-cli/usr/bin/gh"
    path = Path(candidate).expanduser().resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise RuntimeError("未找到 GitHub CLI；先安装 gh 并由用户完成 gh auth login，再重试发布。")
    return path


def _gh(executable, *args, input=None):
    return subprocess.run([str(executable), *args], input=input, capture_output=True,
                          text=True, env={**os.environ, "GH_PROMPT_DISABLED": "1", "GH_HOST": "github.com"})


def _remote_metadata(gh, repository, allow_missing=False):
    result = _gh(gh, "api", "repos/" + repository)
    if result.returncode:
        if allow_missing and re.search(r"\bHTTP 404\b", result.stderr):
            return None
        raise RuntimeError("无法确认 GitHub 仓库；请检查认证和私有仓库权限，原始错误内容不会输出。")
    try:
        metadata = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError("GitHub 返回了无法识别的仓库信息") from None
    if (metadata.get("full_name", "").lower() != repository.lower() or
            metadata.get("private") is not True or metadata.get("fork") is not False):
        raise RuntimeError("目标必须是当前用户拥有的独立私有仓库；拒绝公开仓库、fork 或不匹配的仓库。")
    if metadata.get("archived") or metadata.get("disabled"):
        raise RuntimeError("目标仓库已归档或停用")
    return metadata


def publish(root, repository, gh_override=None):
    if not REPOSITORY.fullmatch(repository):
        raise RuntimeError("仓库名必须是 OWNER/NAME，不能包含 URL、参数或凭据")
    root, local, snapshot = _paths(root)
    with _lock(local):
        result = _prepare(root, local, snapshot)
        gh = _find_gh(root, gh_override)
        identity = _gh(gh, "api", "user")
        if identity.returncode:
            raise RuntimeError("GitHub 尚未认证；需要用户先运行 gh auth login。本次仅保留了本地纯源码快照。")
        try:
            login = json.loads(identity.stdout)["login"]
        except (ValueError, KeyError, TypeError):
            raise RuntimeError("无法确认 GitHub 登录身份") from None
        if repository.split("/", 1)[0].lower() != str(login).lower():
            raise RuntimeError("目标 OWNER 必须是当前 GitHub 登录用户；不会代建组织或其他账户仓库。")
        metadata = _remote_metadata(gh, repository, allow_missing=True)
        if metadata is None:
            created = _gh(gh, "api", "user/repos", "--method", "POST", "--input", "-",
                          input=json.dumps({"name": repository.split("/", 1)[1], "private": True,
                                            "description": "Agent CRM source-only private backup", "auto_init": False}))
            if created.returncode:
                raise RuntimeError("创建私有仓库失败；未推送源码，也未改为公开仓库。")
            metadata = _remote_metadata(gh, repository)
        remote = "https://github.com/" + repository + ".git"
        remotes = _git(snapshot, "remote").stdout.split()
        if any(name != "origin" for name in remotes):
            raise RuntimeError("源码快照含其他远程仓库，请先人工检查")
        if "origin" in remotes:
            urls = _git(snapshot, "remote", "get-url", "--all", "origin").stdout.splitlines()
            push_urls = _git(snapshot, "remote", "get-url", "--push", "--all", "origin").stdout.splitlines()
            if urls != [remote] or push_urls != [remote]:
                raise RuntimeError("现有 origin 与目标仓库不同；不会自动覆盖远程地址")
        else:
            _git(snapshot, "remote", "add", "origin", remote)
        _marker(snapshot)
        _remote_metadata(gh, repository)  # Recheck visibility immediately before publishing.
        _git(snapshot, "push", "--set-upstream", "origin", "main:main", credentials=gh)
        verified = _git(snapshot, "ls-remote", "--exit-code", "origin", "refs/heads/main", credentials=gh).stdout.split()
        if len(verified) != 2 or verified[0] != result["head"] or verified[1] != "refs/heads/main":
            raise RuntimeError("推送后远程 main 提交校验失败，不能声称备份成功")
        _remote_metadata(gh, repository)
        return {**result, "published": True, "repository": repository,
                "url": "https://github.com/" + repository, "private": True, "remoteHeadVerified": True}


def main():
    parser = argparse.ArgumentParser(description="Independent Agent CRM source-only private GitHub backup")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("prepare", help="Create/update the clean local source snapshot; no authentication or upload")
    publish_parser = commands.add_parser("publish", help="Update snapshot and publish to an authenticated owner's private GitHub repo")
    publish_parser.add_argument("--repository", required=True, metavar="OWNER/NAME")
    publish_parser.add_argument("--gh", help="Explicit path to an already installed GitHub CLI")
    args = parser.parse_args()
    try:
        result = prepare(args.root) if args.command == "prepare" else publish(args.root, args.repository, args.gh)
    except (RuntimeError, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, "Agent CRM GitHub backup: " + str(error) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
