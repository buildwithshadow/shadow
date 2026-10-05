"""Hold a kernel lock across exec; process death releases it without cleanup."""
import fcntl
import os
import stat
import sys


def main():
    path, executable, *args = sys.argv[1:]
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError("unsafe notification lock")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 75
    # Never unlink this inode: waiters and future runs must lock the same file.
    os.set_inheritable(fd, True)
    os.execv(executable, [executable, *args, "--notification-lock-fd", str(fd)])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Notification kernel lock unavailable", file=sys.stderr)
        sys.exit(1)
