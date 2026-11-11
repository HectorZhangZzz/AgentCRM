#!/usr/bin/env python3
"""Synthetic offline source acquisition boundaries; no CRM or network access."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


MODULE = importlib.util.spec_from_file_location("prepare_twenty", Path(__file__).with_name("prepare-twenty.py"))
source = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(source)


class UpstreamSourceTests(unittest.TestCase):
    def fixture(self, base, extra=None):
        archive = base / "fixture.tar.gz"
        commit = "a" * 40
        prefix = "twenty-" + commit
        files = {"LICENSE": b"Synthetic upstream license\n", "package.json": b"{}\n", "yarn.lock": b"synthetic lock\n", "ops/build.sh": b"#!/bin/sh\nexit 0\n"}
        with tarfile.open(archive, "w:gz") as zipped:
            for name, data in files.items():
                member = tarfile.TarInfo(prefix + "/" + name)
                member.size = len(data)
                member.mode = 0o755 if name.endswith(".sh") else 0o644
                zipped.addfile(member, io.BytesIO(data))
            if extra:
                member = tarfile.TarInfo(extra[0].replace("PREFIX", prefix))
                member.type = extra[1]
                member.linkname = "../../outside"
                zipped.addfile(member, io.BytesIO(b""))
        spec = {"format": source.FORMAT, "repository": source.REPOSITORY, "commit": commit,
                "archive": {"url": "https://codeload.github.com/twentyhq/twenty/tar.gz/" + commit,
                            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                            "bytes": archive.stat().st_size, "prefix": prefix},
                "fingerprints": {name: hashlib.sha256(data).hexdigest() for name, data in files.items() if not name.startswith("ops/")}}
        root = base / "project"
        root.mkdir()
        return root, archive, spec

    def test_cached_archive_verified_license_retained_and_no_code_executed(self):
        with tempfile.TemporaryDirectory() as td:
            root, archive, spec = self.fixture(Path(td))
            with patch.object(source.urllib.request, "build_opener", side_effect=AssertionError("no network")):
                result = source.prepare(root, spec, archive)
            self.assertEqual(result["files"], 4)
            self.assertFalse(result["buildVerified"])
            self.assertEqual((root / "vendor/twenty/LICENSE").read_bytes(), b"Synthetic upstream license\n")
            self.assertTrue((root / "vendor/twenty/ops/build.sh").stat().st_mode & 0o111)
            self.assertFalse(list((root / "vendor").glob(".twenty-source-*")))

    def test_existing_nonempty_or_empty_vendor_not_overwritten(self):
        for nonempty in (False, True):
            with self.subTest(nonempty=nonempty), tempfile.TemporaryDirectory() as td:
                root, archive, spec = self.fixture(Path(td))
                target = root / "vendor/twenty"
                target.mkdir(parents=True)
                if nonempty:
                    (target / "keep").write_text("keep")
                with self.assertRaisesRegex(RuntimeError, "拒绝覆盖"):
                    source.prepare(root, spec, archive)
                self.assertTrue(target.is_dir())
                if nonempty:
                    self.assertEqual((target / "keep").read_text(), "keep")

    def test_hash_or_length_mismatch_leaves_no_partial_install(self):
        for change in ({"sha256": "0" * 64}, {"bytes": 1}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as td:
                root, archive, spec = self.fixture(Path(td))
                spec["archive"].update(change)
                with self.assertRaisesRegex(RuntimeError, "校验失败|大小超出"):
                    source.prepare(root, spec, archive)
                self.assertFalse((root / "vendor/twenty").exists())
                self.assertFalse(list((root / "vendor").iterdir()))

    def test_unsafe_members_links_and_duplicates_rejected(self):
        for name, kind in [("PREFIX/../../outside", tarfile.REGTYPE), ("other/package.json", tarfile.REGTYPE),
                           ("PREFIX/link", tarfile.SYMTYPE), ("PREFIX/link", tarfile.LNKTYPE),
                           ("PREFIX/socket", tarfile.FIFOTYPE), ("PREFIX/LICENSE", tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as td:
                root, archive, spec = self.fixture(Path(td), (name, kind))
                with self.assertRaises(RuntimeError):
                    source.prepare(root, spec, archive)
                self.assertFalse((root / "vendor/twenty").exists())
                self.assertFalse((Path(td) / "outside").exists())

    def test_target_and_cached_archive_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root, archive, spec = self.fixture(Path(td))
            outside = Path(td) / "outside"
            outside.mkdir()
            (root / "vendor").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "符号链接"):
                source.prepare(root, spec, archive)
            self.assertFalse(list(outside.iterdir()))
            (root / "vendor").unlink()
            link = Path(td) / "archive-link"
            link.symlink_to(archive)
            with self.assertRaisesRegex(RuntimeError, "符号链接"):
                source.prepare(root, spec, link)

    def test_fingerprint_limit_and_atomic_race_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root, archive, spec = self.fixture(Path(td))
            spec["fingerprints"]["LICENSE"] = "0" * 64
            with self.assertRaisesRegex(RuntimeError, "指纹"):
                source.prepare(root, spec, archive)
            self.assertFalse((root / "vendor/twenty").exists())
            with patch.object(source, "MAX_MEMBERS", 1), self.assertRaisesRegex(RuntimeError, "数量超限"):
                source.prepare(root, spec, archive)
            a, b = Path(td) / "source", Path(td) / "target"
            a.mkdir()
            b.mkdir()
            with self.assertRaisesRegex(RuntimeError, "拒绝覆盖"):
                source._publish(a, b)
            self.assertTrue(a.is_dir())

    def test_manifest_rejects_moving_refs_third_party_urls_and_bad_paths(self):
        for change in ({"commit": "main"}, {"repository": "https://example.invalid/twenty"},
                       {"archive": {"url": "https://example.invalid/source.tar.gz"}}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as td:
                root, archive, spec = self.fixture(Path(td))
                spec.update(change)
                path = Path(td) / "source.json"
                path.write_text(json.dumps(spec))
                with self.assertRaises(RuntimeError):
                    source.load_spec(path)


if __name__ == "__main__":
    unittest.main()
