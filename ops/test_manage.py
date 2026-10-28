#!/usr/bin/env python3
"""Boundary tests for restore safety; no real database is touched."""
import argparse, io, json, tarfile, tempfile, unittest
from pathlib import Path
import manage

class RestoreBoundaries(unittest.TestCase):
    def test_nested_project_restore_rejected_before_creation(self):
        target=manage.ROOT/'nested-restore-must-not-exist'
        with self.assertRaisesRegex(RuntimeError,'当前项目目录之外'):
            manage.restore(argparse.Namespace(bundle='does-not-exist',target=str(target)))
        self.assertFalse(target.exists())

    def test_tar_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            td=Path(td);bundle=td/'unsafe.tar.gz'
            with tarfile.open(bundle,'w:gz') as tar:
                entry=tarfile.TarInfo('../escape');entry.size=1
                tar.addfile(entry,io.BytesIO(b'x'))
            with self.assertRaisesRegex(RuntimeError,'不安全备份成员'):
                manage.extract_verified(bundle,td/'extract')
            self.assertFalse((td/'escape').exists())

    def test_tar_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            td=Path(td);bundle=td/'unsafe.tar.gz'
            with tarfile.open(bundle,'w:gz') as tar:
                entry=tarfile.TarInfo('link');entry.type=tarfile.SYMTYPE;entry.linkname='/etc/passwd';tar.addfile(entry)
            with self.assertRaisesRegex(RuntimeError,'不安全备份成员'):
                manage.extract_verified(bundle,td/'extract')

    def test_changed_file_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            td=Path(td);stage=td/'stage';stage.mkdir();f=stage/'record';f.write_bytes(b'a')
            manifest={'format':'portable-crm-backup-v1','files':{'record':{'sha256':'0'*64,'bytes':1}}}
            (stage/'manifest.json').write_text(json.dumps(manifest));bundle=td/'bad.tar.gz'
            with tarfile.open(bundle,'w:gz') as tar:
                for p in stage.iterdir():tar.add(p,arcname=p.name)
            with self.assertRaisesRegex(RuntimeError,'备份文件损坏'):
                manage.extract_verified(bundle,td/'extract')

if __name__=='__main__':unittest.main()
