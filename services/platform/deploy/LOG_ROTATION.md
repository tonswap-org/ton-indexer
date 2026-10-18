# Native platform log rotation

`rotate-logs.py` uses Python's standard library and rotates only `api.log`,
`api.error.log`, `worker.log`, and `worker.error.log` in the explicit log
directory. Its default is `/Users/administrator/apps/tonswap-platform/logs`.
It runs as that directory's owner, with a nonblocking lock. Sources and archives
must be owned regular files with a single link; symlinks are rejected. Live
files, new gzip archives and the lock are mode 0600; new archive directories are
mode 0700. The script never restarts the API or worker.

At 4 MiB it compresses the exact source snapshot, flushes the archive to disk,
then verifies the live file's path, inode, size and modification time again.
Changed files are left intact and retried at the next interval. An unchanged
file is truncated through its existing descriptor so launchd's existing
`O_APPEND` stdout/stderr descriptors continue writing to the same inode. Keep
the latest 8 timestamped gzip archives per log in `logs/archives`. Other files
are untouched. Files above 64 MiB are rejected for explicit operator handling.

**Copytruncate has a tiny unavoidable final check-to-truncate race:** a writer
that appends in that interval can lose those bytes. Appends during compression
or archive sync are detected and defer rotation. This utility therefore does
not promise lossless logging. A continually changing log may defer repeatedly;
investigate repeated deferrals or excessive logging instead of raising the
API's file-size limit. At the current 16 MiB launchd limit, the 4 MiB threshold and
60-second interval provide headroom for normal request volume, not an
unbounded logging burst.

Deployment template: `org.tonswap.platform-log-rotation.plist`, administrator,
`/usr/bin/python3`, every 60 seconds plus RunAtLoad. Install the script at
`/Users/administrator/apps/tonswap-platform/deploy/rotate-logs.py`. Review the
actual paths and confirm launchd's API/worker log descriptors use `O_APPEND`
before installing. The template deliberately omits output paths to avoid an
unbounded second log. A manual run prints a JSON result and exits 1 on errors;
`busy` and `deferred` results are retryable. Launchd exposes the job's exit
status. Archive and live-source retention must fit the host's disk budget.

Local verification:

```sh
python3 -m unittest discover -s deploy -p 'test_rotate_logs.py' -v
```

These files do not perform deployment. A controlled initial truncation of an
already hung API and installation of the timer are separate operator actions.
