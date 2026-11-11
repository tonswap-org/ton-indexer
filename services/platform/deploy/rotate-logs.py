#!/usr/bin/env python3
"""Bounded, inode-preserving rotation of the four platform launchd logs.

Writers must use O_APPEND. A changed source is deferred, preserving appended
bytes. Copytruncate still has a tiny final stat-to-ftruncate race; this is not
a lossless logging transport. No daemon restart or signal is performed.
"""

import argparse
import fcntl
import gzip
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

DEFAULT_LOG_DIR = Path('/Users/administrator/apps/tonswap-platform/logs')
LOG_NAMES = ('api.log', 'api.error.log', 'worker.log', 'worker.error.log')
THRESHOLD = 4 * 1024 * 1024
MAX_SOURCE_BYTES = 64 * 1024 * 1024
KEEP = 8
NOFOLLOW = os.O_NOFOLLOW


def require_owned_regular(info):
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
        raise ValueError('Expected an owned regular file with one link')


def require_owned_directory(info):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError('Expected an owned directory without group/other write access')


def same_snapshot(left, right):
    return (left.st_dev, left.st_ino, left.st_size, left.st_mtime_ns) == (
        right.st_dev, right.st_ino, right.st_size, right.st_mtime_ns)


def source_unchanged(fd, directory, name, initial):
    current = os.fstat(fd)
    path = os.stat(name, dir_fd=directory, follow_symlinks=False)
    require_owned_regular(current)
    require_owned_regular(path)
    return same_snapshot(initial, current) and same_snapshot(current, path)


def archive_name(name):
    return f'{name}.{time.time_ns():020d}-{uuid.uuid4().hex[:8]}.gz'


def compress_snapshot(source, destination, size):
    # Read exactly the snapshot length, never chase an unbounded live writer.
    remaining = size
    with os.fdopen(os.dup(destination), 'wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
            while remaining:
                chunk = os.read(source, min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError('Source shrank while archiving')
                compressed.write(chunk)
                remaining -= len(chunk)
        raw.flush()
        os.fsync(raw.fileno())


def prune_archives(directory, name, keep):
    pattern = re.compile(re.escape(name) + r'\.[0-9]{20}-[0-9a-f]{8}\.gz\Z')
    names = sorted(item for item in os.listdir(directory) if pattern.fullmatch(item))
    # Validate the whole matching set before deleting any archive.
    entries = [(item, os.stat(item, dir_fd=directory, follow_symlinks=False)) for item in names]
    for _, info in entries:
        require_owned_regular(info)
    for item, before in entries[:-keep]:
        current = os.stat(item, dir_fd=directory, follow_symlinks=False)
        if not same_snapshot(before, current):
            raise ValueError('Archive changed during retention')
        os.unlink(item, dir_fd=directory)
    if len(entries) > keep:
        os.fsync(directory)


def rotate_log(directory, archives, name, threshold, keep):
    if name not in LOG_NAMES:
        raise ValueError('Log name is outside the fixed allowlist')
    try:
        source = os.open(name, os.O_RDWR | NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return {'log': name, 'status': 'missing'}
    pending = None
    try:
        initial = os.fstat(source)
        require_owned_regular(initial)
        if not source_unchanged(source, directory, name, initial):
            return {'log': name, 'status': 'deferred'}
        os.fchmod(source, 0o600)
        if initial.st_size < threshold:
            return {'log': name, 'status': 'below-threshold', 'bytes': initial.st_size}
        if initial.st_size > MAX_SOURCE_BYTES:
            raise ValueError('Log exceeds the bounded 64 MiB source limit')
        final = archive_name(name)
        pending = '.' + final + '.tmp'
        destination = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=archives)
        try:
            compress_snapshot(source, destination, initial.st_size)
        finally:
            os.close(destination)
        if not source_unchanged(source, directory, name, initial):
            return {'log': name, 'status': 'deferred', 'reason': 'source-changed'}
        os.rename(pending, final, src_dir_fd=archives, dst_dir_fd=archives)
        pending = final
        os.fsync(archives)
        # Check after archive durability, immediately before the destructive step.
        if not source_unchanged(source, directory, name, initial):
            return {'log': name, 'status': 'deferred', 'reason': 'source-changed'}
        os.ftruncate(source, 0)
        pending = None  # The durable archive must survive any subsequent error.
        os.fsync(source)
        prune_archives(archives, name, keep)
        return {'log': name, 'status': 'rotated', 'bytes': initial.st_size, 'archive': final}
    finally:
        os.close(source)
        if pending is not None:
            os.unlink(pending, dir_fd=archives)


def rotate_directory(log_dir, threshold=THRESHOLD, keep=KEEP):
    path = Path(log_dir)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError('Log directory must be an absolute path without symlinks')
    if not 0 < threshold <= MAX_SOURCE_BYTES or not 1 <= keep <= 32:
        raise ValueError('Rotation bounds are invalid')
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    lock = archives = None
    try:
        require_owned_directory(os.fstat(directory))
        lock = os.open('.rotate-logs.lock', os.O_RDWR | os.O_CREAT | NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        require_owned_regular(os.fstat(lock))
        os.fchmod(lock, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'busy', 'logs': []}
        try:
            os.mkdir('archives', 0o700, dir_fd=directory)
        except FileExistsError:
            pass
        archives = os.open('archives', os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=directory)
        require_owned_directory(os.fstat(archives))
        results = []
        for name in LOG_NAMES:
            try:
                results.append(rotate_log(directory, archives, name, threshold, keep))
            except (OSError, ValueError) as error:
                results.append({'log': name, 'status': 'error', 'error': str(error)})
        return {'status': 'error' if any(item['status'] == 'error' for item in results) else 'ok', 'logs': results}
    finally:
        if archives is not None:
            os.close(archives)
        if lock is not None:
            os.close(lock)
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--log-dir', type=Path, default=DEFAULT_LOG_DIR)
    args = parser.parse_args()
    try:
        result = rotate_directory(args.log_dir)
    except (OSError, ValueError) as error:
        result = {'status': 'error', 'error': str(error)}
    print(json.dumps(result, sort_keys=True))
    return 1 if result['status'] == 'error' else 0


if __name__ == '__main__':
    raise SystemExit(main())
