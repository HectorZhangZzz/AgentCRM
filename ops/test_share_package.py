#!/usr/bin/env python3
"""Source package boundaries; synthetic fixtures only, no database access."""

import hashlib
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

from share_package import FORMAT, MANIFEST_NAME, create_share


class ShareBoundaries(unittest.TestCase):
    def fixture(self, root):
        (root / "package.json").write_text('{"name":"agent-crm","version":"0.1.2"}\n')
        for rel in (
            "README.md", "public/products.html", "public/products.js", "public/product-workflow.mjs", "ops/product-preview.mjs", "src/server.mjs", "src/products.mjs", "migrations/optional/002_product_entities.sql", "ops/crm", "docs/HANDOFF.md",
            "skills/agent-crm/SKILL.md", "examples/synthetic.txt", "test/example.test.mjs",
            "integrations/mcp.json", "deploy/docker/README.md", "vendor/twenty/LICENSE",
            "vendor/twenty/yarn.lock", "vendor/twenty/packages/twenty-server/src/main.ts",
            "vendor/twenty/packages/twenty-server/src/cache/service.ts",
            "vendor/twenty/packages/twenty-sdk/src/build/helper.ts",
            "vendor/twenty/packages/twenty-client-sdk/src/metadata/generated/runtime/index.ts",
        ):
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic source\n")
        (root / "ops/crm").chmod(0o755)

    def test_private_generated_and_unapproved_files_excluded_and_manifest_verified(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "project"
            root.mkdir()
            self.fixture(root)
            planted = (
                ".local/config.json", ".local/data/objects/original", ".git/config",
                "backups/private.tar.gz", "exports/records.jsonl", "node_modules/x/code.js",
                "runtime/bin/postgres", "test/results/real-customer.json", "ops/__pycache__/crm.pyc",
                "docs/.env", "docs/.env.example", "docs/private-secrets.json", "docs/logs/access.log",
                "docs/secrets.json", "docs/customer.key", "unknown-customer-folder/notes.txt",
                "vendor/twenty/node_modules/x/index.js", "vendor/twenty/.yarn/cache/package.zip",
                "vendor/twenty/packages/twenty-server/dist/main.js", "vendor/twenty/.env.backup",
                "vendor/unknown/private.txt",
            )
            for rel in planted:
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("PLANTED_PRIVATE_VALUE\n")
            out = root / "share" / "agent-crm-source.zip"
            result = create_share(root, out)
            self.assertEqual(result["sha256"], hashlib.sha256(out.read_bytes()).hexdigest())
            self.assertEqual(out.stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(result["sha256File"]).stat().st_mode & 0o777, 0o600)
            with zipfile.ZipFile(out) as archive:
                names = set(archive.namelist())
                self.assertTrue(set(planted).isdisjoint(names))
                self.assertFalse(any(name.startswith("vendor/") for name in names))
                self.assertIn("integrations/mcp.json", names)
                self.assertIn("src/products.mjs", names)
                self.assertIn("public/products.html", names)
                self.assertIn("public/product-workflow.mjs", names)
                self.assertIn("ops/product-preview.mjs", names)
                self.assertIn("migrations/optional/002_product_entities.sql", names)
                manifest = json.loads(archive.read(MANIFEST_NAME))
                self.assertEqual(manifest["format"], FORMAT)
                self.assertFalse(manifest["businessDataIncluded"])
                self.assertEqual(set(manifest["files"]), names - {MANIFEST_NAME})
                for rel, info in manifest["files"].items():
                    self.assertFalse(Path(rel).is_absolute())
                    self.assertNotIn("..", Path(rel).parts)
                    data = archive.read(rel)
                    self.assertNotIn(b"PLANTED_PRIVATE_VALUE", data)
                    self.assertEqual(info, {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
                self.assertTrue((archive.getinfo("ops/crm").external_attr >> 16) & 0o111)

    def test_existing_output_checksum_and_source_target_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            out = root / "share.zip"
            out.write_bytes(b"keep")
            with self.assertRaisesRegex(RuntimeError, "不能覆盖"):
                create_share(root, out)
            self.assertEqual(out.read_bytes(), b"keep")
            out.unlink()
            checksum = root / "share.zip.sha256"
            checksum.write_text("keep checksum")
            with self.assertRaisesRegex(RuntimeError, "不能覆盖"):
                create_share(root, out)
            self.assertFalse(out.exists())
            self.assertEqual(checksum.read_text(), "keep checksum")
            with self.assertRaisesRegex(RuntimeError, "源码目录内"):
                create_share(root, root / "src" / "source.zip")

    def test_reserved_manifest_or_readme_cannot_shadow_generated_files(self):
        for name in (MANIFEST_NAME, "SHARE_README.md"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                self.fixture(root)
                (root / name).write_text("private shadow")
                with self.assertRaisesRegex(RuntimeError, "保留的分享文件名"):
                    create_share(root, root / "share" / "source.zip")
                self.assertFalse((root / "share").exists())

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlink_to_private_file_or_directory_rejected(self):
        for directory in (False, True):
            with self.subTest(directory=directory), tempfile.TemporaryDirectory() as td:
                base = Path(td)
                root = base / "project"
                root.mkdir()
                self.fixture(root)
                private = base / "private"
                if directory:
                    private.mkdir()
                    (private / "secret").write_text("private")
                else:
                    private.write_text("private")
                (root / "docs" / "linked").symlink_to(private, target_is_directory=directory)
                with self.assertRaisesRegex(RuntimeError, "符号链接"):
                    create_share(root, root / "share" / "source.zip")
                self.assertFalse((root / "share").exists())

    def test_known_secret_in_source_aborts_and_removes_partial_package(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            (root / "docs" / "bad.md").write_text("sk-" + "proj-" + "x" * 50)
            out = root / "share" / "source.zip"
            with self.assertRaisesRegex(RuntimeError, "访问令牌"):
                create_share(root, out)
            self.assertFalse(out.exists())
            self.assertFalse(out.with_name(out.name + ".sha256").exists())

    def test_same_source_produces_identical_zip_and_repackage_does_not_include_prior_output(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            a = create_share(root, root / "share" / "a.zip")
            b = create_share(root, root / "share" / "b.zip")
            self.assertEqual(a["sha256"], b["sha256"])

    def test_upstream_private_debug_capture_and_legacy_backups_are_excluded(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            private = (
                "vendor/twenty/packages/twenty-companion/test.json",
                "vendor/twenty/packages/twenty-docker/docker-compose.yml.bak-ai-providers-123",
                "vendor/twenty/packages/twenty-docker/docker-compose.yml.before-config-persistence-123",
                "docs/notes.md.bak", "docs/notes.md~",
            )
            for rel in private:
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("SYNTHETIC_PRIVATE_DEBUG_CAPTURE")
            allowed = root / "vendor/twenty/packages/twenty-server/test.json"
            allowed.write_text('{"synthetic":true}')
            out = root / "share/source.zip"
            create_share(root, out)
            with zipfile.ZipFile(out) as archive:
                names = set(archive.namelist())
                self.assertTrue(set(private).isdisjoint(names))
                self.assertNotIn(allowed.relative_to(root).as_posix(), names)


if __name__ == "__main__":
    unittest.main()
