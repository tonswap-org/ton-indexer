import fcntl
import gzip
import importlib.util
import os
from pathlib import Path
import plistlib
import stat
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('rotate_logs', Path(__file__).with_name('rotate-logs.py'))
rotation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rotation)


class LogRotationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def log(self, name='api.log', content=b'0123456789'):
        path = self.root / name
        path.write_bytes(content)
        return path

    def run_rotation(self, **kwargs):
        return rotation.rotate_directory(self.root, threshold=8, **kwargs)

    def archives(self, name='api.log'):
        return sorted((self.root / 'archives').glob(name + '.*.gz'))

    def test_rotation_keeps_inode_and_existing_append_descriptor(self):
        path = self.log(content=b'original complete log\n')
        inode = path.stat().st_ino
        writer = os.open(path, os.O_WRONLY | os.O_APPEND)
        self.addCleanup(os.close, writer)
        result = self.run_rotation()
        self.assertEqual(result['logs'][0]['status'], 'rotated')
        self.assertEqual(path.stat().st_ino, inode)
        self.assertEqual(path.read_bytes(), b'')
        self.assertEqual(gzip.decompress(self.archives()[0].read_bytes()), b'original complete log\n')
        os.write(writer, b'next message\n')
        self.assertEqual(path.read_bytes(), b'next message\n')
        for private in [path, self.archives()[0], self.root / '.rotate-logs.lock']:
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)

    def test_small_and_missing_logs_are_not_rotated(self):
        path = self.log(content=b'small')
        result = self.run_rotation()
        self.assertEqual([item['status'] for item in result['logs']], ['below-threshold', 'missing', 'missing', 'missing'])
        self.assertEqual(path.read_bytes(), b'small')
        self.assertEqual(self.archives(), [])

    def test_exact_threshold_rotates(self):
        self.log(content=b'12345678')
        self.assertEqual(self.run_rotation()['logs'][0]['status'], 'rotated')

    def test_append_during_compression_defers_without_losing_bytes(self):
        path = self.log()
        compress = rotation.compress_snapshot
        def append_after_copy(*args):
            compress(*args)
            with path.open('ab') as writer:
                writer.write(b'newly appended')
        with mock.patch.object(rotation, 'compress_snapshot', append_after_copy):
            result = self.run_rotation()
        self.assertEqual(result['logs'][0]['status'], 'deferred')
        self.assertEqual(path.read_bytes(), b'0123456789newly appended')
        self.assertEqual(list((self.root / 'archives').iterdir()), [])
        self.assertEqual(self.run_rotation()['logs'][0]['status'], 'rotated')
        self.assertEqual(gzip.decompress(self.archives()[0].read_bytes()), b'0123456789newly appended')

    def test_same_size_rewrite_during_compression_defers(self):
        path = self.log()
        compress = rotation.compress_snapshot
        def rewrite_after_copy(*args):
            compress(*args)
            previous = path.stat().st_mtime_ns
            path.write_bytes(b'abcdefghij')
            os.utime(path, ns=(previous + 1_000_000, previous + 1_000_000))
        with mock.patch.object(rotation, 'compress_snapshot', rewrite_after_copy):
            result = self.run_rotation()
        self.assertEqual(result['logs'][0]['status'], 'deferred')
        self.assertEqual(path.read_bytes(), b'abcdefghij')
        self.assertEqual(self.archives(), [])

    def test_replaced_source_path_is_not_truncated(self):
        path = self.log()
        compress = rotation.compress_snapshot
        def replace_after_copy(*args):
            compress(*args)
            path.rename(self.root / 'old-source')
            path.write_bytes(b'replacement')
        with mock.patch.object(rotation, 'compress_snapshot', replace_after_copy):
            result = self.run_rotation()
        self.assertEqual(result['logs'][0]['status'], 'deferred')
        self.assertEqual(path.read_bytes(), b'replacement')
        self.assertEqual((self.root / 'old-source').read_bytes(), b'0123456789')
        self.assertEqual(self.archives(), [])

    def test_nonblocking_lock_does_not_touch_logs(self):
        path = self.log()
        with (self.root / '.rotate-logs.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_rotation(), {'status': 'busy', 'logs': []})
        self.assertEqual(path.read_bytes(), b'0123456789')

    def test_retention_is_per_log_and_preserves_unrelated_files(self):
        other = self.log('private-unrelated.log', b'never touch')
        for index in range(10):
            self.log(content=str(index).encode() * 10)
            self.assertEqual(self.run_rotation()['status'], 'ok')
        self.log('worker.error.log', b'worker archive')
        self.run_rotation()
        self.assertEqual(len(self.archives()), 8)
        self.assertEqual([gzip.decompress(item.read_bytes()) for item in self.archives()], [str(i).encode() * 10 for i in range(2, 10)])
        self.assertEqual(len(self.archives('worker.error.log')), 1)
        self.assertEqual(other.read_bytes(), b'never touch')

    def test_symlink_and_hardlink_sources_are_rejected(self):
        target = self.log('unrelated', b'preserve original')
        (self.root / 'api.log').symlink_to(target)
        self.assertEqual(self.run_rotation()['status'], 'error')
        (self.root / 'api.log').unlink()
        os.link(target, self.root / 'api.log')
        self.assertEqual(self.run_rotation()['status'], 'error')
        self.assertEqual(target.read_bytes(), b'preserve original')

    def test_symlink_directory_and_archive_directory_are_rejected(self):
        linked = self.root / 'linked'
        linked.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            rotation.rotate_directory(linked)
        actual = self.root / 'actual'
        actual.mkdir()
        (self.root / 'archives').symlink_to(actual, target_is_directory=True)
        with self.assertRaises(OSError):
            self.run_rotation()

    def test_symlink_lock_is_rejected(self):
        target = self.log('unrelated', b'preserve original')
        (self.root / '.rotate-logs.lock').symlink_to(target)
        with self.assertRaises(OSError):
            self.run_rotation()
        self.assertEqual(target.read_bytes(), b'preserve original')

    def test_compression_failure_preserves_source_and_removes_partial_archive(self):
        path = self.log()
        with mock.patch.object(rotation, 'compress_snapshot', side_effect=OSError('simulated disk full')):
            self.assertEqual(self.run_rotation()['status'], 'error')
        self.assertEqual(path.read_bytes(), b'0123456789')
        self.assertEqual(list((self.root / 'archives').iterdir()), [])

    def test_source_size_is_bounded(self):
        path = self.log()
        with path.open('r+b') as source:
            source.truncate(rotation.MAX_SOURCE_BYTES + 1)
        self.assertEqual(self.run_rotation()['status'], 'error')
        self.assertEqual(path.stat().st_size, rotation.MAX_SOURCE_BYTES + 1)
        self.assertEqual(self.archives(), [])

    def test_launchd_template_has_scoped_paths_user_and_interval(self):
        plist = plistlib.loads(Path(__file__).with_name('org.tonswap.platform-log-rotation.plist').read_bytes())
        self.assertEqual(plist['UserName'], 'administrator')
        self.assertEqual(plist['StartInterval'], 60)
        self.assertTrue(plist['RunAtLoad'])
        self.assertEqual(plist['ProgramArguments'][-2:], ['--log-dir', str(rotation.DEFAULT_LOG_DIR)])
        self.assertNotIn('KeepAlive', plist)
        self.assertNotIn('StandardOutPath', plist)  # Avoid an unbounded rotator log.


if __name__ == '__main__':
    unittest.main()
