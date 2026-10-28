#!/usr/bin/env python3
"""Offline safety and incremental-history tests; never contact GitHub."""

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import github_backup as backup


class SourceBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "project"
        self.root.mkdir()
        (self.root / "package.json").write_text('{"name":"agent-crm","version":"0.1.2"}\n')
        (self.root / ".gitignore").write_text(".local/\n*.ignored\n")
        (self.root / "src").mkdir()
        (self.root / "src/main.py").write_text("print('synthetic')\n")
        (self.root / "vendor/twenty").mkdir(parents=True)
        (self.root / "vendor/twenty/LICENSE").write_text("Synthetic upstream license fixture\n")
        self.git(self.root, "init", "--initial-branch=main")
        self.git(self.root, "config", "user.name", "Synthetic Source Author")
        self.git(self.root, "config", "user.email", "fixture@example.invalid")
        (self.root / "legacy-debug.txt").write_text("upstream historical diagnostic, never publish\n")
        self.git(self.root, "add", "--all")
        self.git(self.root, "commit", "-m", "Historical upstream diagnostic")
        (self.root / "legacy-debug.txt").unlink()
        self.git(self.root, "add", "--all")
        self.git(self.root, "commit", "-m", "Current reviewed source")
        (self.root / ".local/data/objects").mkdir(parents=True)
        (self.root / ".local/data/objects/private").write_text("private synthetic attachment")
        (self.root / ".env").write_text("PRIVATE_SYNTHETIC=not-a-credential")
        (self.root / "test/results").mkdir(parents=True)
        (self.root / "test/results/result.json").write_text('{"local":"private evidence"}')

    def git(self, root, *args):
        result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True,
                                env=backup._environment())
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def prepare(self):
        result = backup.prepare(self.root)
        return result, Path(result["snapshot"])

    def private_metadata(self):
        return {"full_name": "fixture/agent-crm", "private": True, "fork": False,
                "archived": False, "disabled": False}

    def gh_response(self, value=None, status=0, stderr=""):
        return subprocess.CompletedProcess([], status, json.dumps(value), stderr)

    def test_independent_history_excludes_private_data_and_keeps_license(self):
        original_head = self.git(self.root, "rev-parse", "HEAD")
        result, snapshot = self.prepare()
        self.assertEqual(self.git(snapshot, "rev-list", "--count", "HEAD"), "1")
        self.assertNotEqual(result["head"], original_head)
        self.assertNotIn("Historical upstream", self.git(snapshot, "log", "--all", "--oneline"))
        names = set(self.git(snapshot, "ls-files").splitlines())
        self.assertIn("vendor/twenty/LICENSE", names)
        self.assertIn(backup.INFO, names)
        self.assertNotIn("legacy-debug.txt", names)
        self.assertFalse(any(name.startswith((".local/", "test/results/", ".env")) for name in names))
        info = json.loads((snapshot / backup.INFO).read_text())
        self.assertEqual(info["sourceCommit"], original_head)
        self.assertFalse(info["businessDataIncluded"])
        self.assertNotIn(str(self.root), json.dumps(info))
        self.assertEqual(self.git(self.root, "rev-parse", "HEAD"), original_head)
        self.assertEqual(self.git(self.root, "config", "user.name"), "Synthetic Source Author")
        self.assertEqual(self.git(snapshot, "log", "-1", "--format=%an"), "Synthetic Source Author")
        self.assertEqual(self.git(snapshot, "status", "--porcelain"), "")

    def test_repeat_is_noop_then_update_retains_incremental_history(self):
        first, snapshot = self.prepare()
        second, unused = self.prepare()
        self.assertFalse(second["committed"])
        self.assertEqual(first["head"], second["head"])
        (self.root / "src/main.py").unlink()
        (self.root / "src/new.py").write_text("updated synthetic source\n")
        third, unused = self.prepare()
        self.assertTrue(third["committed"])
        self.assertFalse((snapshot / "src/main.py").exists())
        self.assertEqual((snapshot / "src/new.py").read_text(), "updated synthetic source\n")
        self.assertEqual(self.git(snapshot, "rev-list", "--count", "HEAD"), "2")
        self.assertEqual(self.git(snapshot, "rev-parse", "HEAD^"), first["head"])

    def test_unknown_directory_is_not_overwritten(self):
        target = self.root / ".local/github-source"
        target.mkdir()
        (target / "personal.txt").write_text("leave me alone")
        with self.assertRaisesRegex(RuntimeError, "独立 Git 仓库"):
            backup.prepare(self.root)
        self.assertEqual((target / "personal.txt").read_text(), "leave me alone")

    def test_dirty_managed_file_refused(self):
        unused, snapshot = self.prepare()
        (snapshot / "src/main.py").write_text("uncommitted manual change")
        with self.assertRaisesRegex(RuntimeError, "未提交修改"):
            backup.prepare(self.root)
        self.assertEqual((snapshot / "src/main.py").read_text(), "uncommitted manual change")

    def test_ignored_unknown_file_and_empty_directory_are_preserved(self):
        unused, snapshot = self.prepare()
        personal = snapshot / "notes.ignored"
        personal.write_text("never silently remove")
        with self.assertRaisesRegex(RuntimeError, "未管理文件"):
            backup.prepare(self.root)
        self.assertTrue(personal.exists())
        personal.unlink()
        (snapshot / "unknown-empty-directory").mkdir()
        with self.assertRaisesRegex(RuntimeError, "未管理目录"):
            backup.prepare(self.root)

    def test_tampered_marker_and_symbolic_link_refused(self):
        unused, snapshot = self.prepare()
        marker = snapshot / ".git" / backup.MARKER
        original = marker.read_text()
        marker.write_text(json.dumps({"format": backup.FORMAT, "files": ["../outside"]}))
        with self.assertRaisesRegex(RuntimeError, "安全的相对路径"):
            backup.prepare(self.root)
        marker.write_text(original)
        target = snapshot / "src/main.py"
        target.unlink()
        target.symlink_to(self.root / "src/main.py")
        with self.assertRaises(RuntimeError):
            backup.prepare(self.root)
        self.assertTrue(target.is_symlink())

    def test_bundle_member_paths_and_hashes_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            for name, content, expected in [("../outside", b"bad", b"bad"), ("src/a.py", b"bad", b"expected")]:
                bundle = stage / "bad.zip"
                manifest = {"format": backup.SHARE_FORMAT, "sourceOnly": True, "businessDataIncluded": False,
                            "files": {name: {"bytes": len(expected), "sha256": hashlib.sha256(expected).hexdigest()}}}
                with zipfile.ZipFile(bundle, "w") as zipped:
                    zipped.writestr(name, content)
                    zipped.writestr(backup.MANIFEST_NAME, json.dumps(manifest))
                target = stage / "extract"
                target.mkdir(exist_ok=True)
                with self.assertRaises(RuntimeError):
                    backup._extract_bundle(bundle, target)
            self.assertFalse((stage / "outside").exists())

    def test_unauthenticated_publish_leaves_local_snapshot_without_remote(self):
        with patch.object(backup, "_find_gh", return_value=Path("/synthetic/gh")), \
                patch.object(backup, "_gh", return_value=self.gh_response(status=1, stderr="sensitive diagnostic")):
            with self.assertRaisesRegex(RuntimeError, "尚未认证") as error:
                backup.publish(self.root, "fixture/agent-crm")
        self.assertNotIn("sensitive", str(error.exception))
        snapshot = self.root / ".local/github-source"
        self.assertEqual(self.git(snapshot, "remote"), "")

    def test_publish_requires_authenticated_owner_and_private_nonfork(self):
        for change in ({"private": False}, {"fork": True}, {"full_name": "other/repo"}):
            with self.subTest(change=change):
                metadata = {**self.private_metadata(), **change}
                with patch.object(backup, "_find_gh", return_value=Path("/synthetic/gh")), \
                        patch.object(backup, "_gh", side_effect=[self.gh_response({"login": "fixture"}), self.gh_response(metadata)]):
                    with self.assertRaisesRegex(RuntimeError, "独立私有仓库"):
                        backup.publish(self.root, "fixture/agent-crm")
        with patch.object(backup, "_find_gh", return_value=Path("/synthetic/gh")), \
                patch.object(backup, "_gh", return_value=self.gh_response({"login": "different"})):
            with self.assertRaisesRegex(RuntimeError, "OWNER"):
                backup.publish(self.root, "fixture/agent-crm")

    def test_only_confirmed_404_can_create_repository(self):
        with patch.object(backup, "_gh", return_value=self.gh_response(status=1, stderr="HTTP 403 forbidden")) as call:
            with self.assertRaises(RuntimeError):
                backup._remote_metadata(Path("/synthetic/gh"), "fixture/agent-crm", allow_missing=True)
            self.assertEqual(call.call_count, 1)
        with patch.object(backup, "_gh", return_value=self.gh_response(status=1, stderr="gh: Not Found (HTTP 404)")):
            self.assertIsNone(backup._remote_metadata(Path("/synthetic/gh"), "fixture/agent-crm", allow_missing=True))

    def test_private_creation_push_is_fast_forward_only_and_remote_head_verified(self):
        result, snapshot = self.prepare()
        real_git = backup._git
        calls = []

        def git(directory, *args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == "push":
                return subprocess.CompletedProcess([], 0, "", "")
            if args[0] == "ls-remote":
                return subprocess.CompletedProcess([], 0, result["head"] + "\trefs/heads/main\n", "")
            return real_git(directory, *args, **kwargs)

        responses = [self.gh_response({"login": "fixture"}),
                     self.gh_response(status=1, stderr="gh: Not Found (HTTP 404)"),
                     self.gh_response(self.private_metadata()),
                     self.gh_response(self.private_metadata()),
                     self.gh_response(self.private_metadata()),
                     self.gh_response(self.private_metadata())]
        with patch.object(backup, "_find_gh", return_value=Path("/synthetic/gh")), \
                patch.object(backup, "_gh", side_effect=responses) as gh_call, \
                patch.object(backup, "_git", side_effect=git):
            published = backup.publish(self.root, "fixture/agent-crm")
        self.assertTrue(published["published"])
        self.assertTrue(published["remoteHeadVerified"])
        creation = next(call for call in gh_call.call_args_list if "user/repos" in call.args)
        self.assertIs(json.loads(creation.kwargs["input"])["private"], True)
        push = next(call for call in calls if call[0][0] == "push")
        self.assertNotIn("--force", push[0])
        self.assertNotIn("--mirror", push[0])
        self.assertEqual(push[0][-1], "main:main")
        self.assertEqual(push[1]["credentials"], Path("/synthetic/gh"))
        self.assertEqual(self.git(snapshot, "remote", "get-url", "origin"), "https://github.com/fixture/agent-crm.git")

    def test_mismatched_origin_is_not_overwritten(self):
        unused, snapshot = self.prepare()
        self.git(snapshot, "remote", "add", "origin", "https://github.com/fixture/other.git")
        with patch.object(backup, "_find_gh", return_value=Path("/synthetic/gh")), \
                patch.object(backup, "_gh", side_effect=[self.gh_response({"login": "fixture"}), self.gh_response(self.private_metadata())]):
            with self.assertRaisesRegex(RuntimeError, "origin"):
                backup.publish(self.root, "fixture/agent-crm")
        self.assertEqual(self.git(snapshot, "remote", "get-url", "origin"), "https://github.com/fixture/other.git")

    def test_push_failure_and_remote_head_mismatch_cannot_report_success(self):
        unused, snapshot = self.prepare()
        real_git = backup._git
        for failing_operation in ("push", "ls-remote"):
            def git(directory, *args, **kwargs):
                if args[0] == "push":
                    if failing_operation == "push":
                        raise RuntimeError("synthetic non-fast-forward refusal")
                    return subprocess.CompletedProcess([], 0, "", "")
                if args[0] == "ls-remote":
                    return subprocess.CompletedProcess([], 0, "0" * 40 + "\trefs/heads/main\n", "")
                return real_git(directory, *args, **kwargs)

            with self.subTest(operation=failing_operation), \
                    patch.object(backup, "_find_gh", return_value=Path("/synthetic/gh")), \
                    patch.object(backup, "_gh", side_effect=lambda gh, *args, **kwargs: self.gh_response(
                        {"login": "fixture"} if args == ("api", "user") else self.private_metadata())), \
                    patch.object(backup, "_git", side_effect=git):
                with self.assertRaises(RuntimeError):
                    backup.publish(self.root, "fixture/agent-crm")
            self.assertEqual(self.git(snapshot, "rev-list", "--count", "HEAD"), "1")

    def test_credential_helper_is_per_command_and_raw_diagnostics_are_suppressed(self):
        with patch.object(backup.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "private diagnostic")) as run:
            with self.assertRaises(RuntimeError) as error:
                backup._git(self.root, "push", "origin", "main:main", credentials=Path("/tools with spaces/gh"))
        argv = run.call_args.args[0]
        self.assertIn("credential.helper=", argv)
        self.assertIn("credential.helper=!'/tools with spaces/gh' auth git-credential", argv)
        self.assertFalse(any(arg in {"--global", "--force", "--mirror"} for arg in argv))
        self.assertEqual(run.call_args.kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertNotIn("private diagnostic", str(error.exception))

    def test_repository_argument_cannot_be_url_or_options(self):
        for repository in ["https://github.com/a/b", "a/b --force", "../other", "fixture/-danger", "fixture/repo\n"]:
            with self.subTest(repository=repository), self.assertRaisesRegex(RuntimeError, "OWNER/NAME"):
                backup.publish(self.root, repository)


if __name__ == "__main__":
    unittest.main()
