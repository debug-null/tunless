#!/usr/bin/env python3
"""Drive the installed tunless TUI through a real PTY. Not a render() unit test."""
import os
import pty
import select
import signal
import sys
import time

bin_path = sys.argv[1]
home = sys.argv[2]
log_path = sys.argv[3]

def read_for(fd, seconds):
    end = time.time() + seconds
    data = b""
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        data += chunk
    return data

def set_size(fd, rows, cols):
    import fcntl
    import struct
    import termios
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pid, fd = pty.fork()
if pid == 0:
    os.environ["HOME"] = home
    os.environ["TERM"] = "xterm-256color"
    os.environ["TUNLESS_THEME"] = "dark"
    os.environ["COLUMNS"] = "80"
    os.environ["LINES"] = "24"
    os.execv(bin_path, [bin_path])

set_size(fd, 24, 80)
chunks = [read_for(fd, 3)]
# help, back, upstream, back, down, narrow resize, quit
for keys, wait in (
    (b"h", 0.6),
    (b"\x1b", 0.6),
    (b"u", 0.6),
    (b"\x1b", 0.6),
    (b"\x1b[B", 0.4),
):
    os.write(fd, keys)
    chunks.append(read_for(fd, wait))

os.write(fd, b"\r")
chunks.append(read_for(fd, 0.5))
set_size(fd, 20, 50)
os.kill(pid, signal.SIGWINCH)
chunks.append(read_for(fd, 0.5))
set_size(fd, 12, 32)
os.kill(pid, signal.SIGWINCH)
chunks.append(read_for(fd, 0.5))
os.write(fd, b"q")
chunks.append(read_for(fd, 1.2))

text = b"".join(chunks)
try:
    os.close(fd)
except OSError:
    pass
_, status = os.waitpid(pid, 0)
open(log_path, "wb").write(text)
plain = text.decode("utf-8", "replace")
needles = ["tunless", "转发服务", "上游代理", "模型", "没有已安装", "太小", "q 退出"]
missing = [n for n in needles if n not in plain]
print(f"exit_status={status}")
print(f"bytes={len(text)} missing={missing or 'none'}")
print("--- frame excerpt ---")
# strip most ANSI for the log humans read
import re
shown = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", plain)
shown = re.sub(r"\x1b\][^\x07]*\x07", "", shown)
print("\n".join(shown.splitlines()[:40]))
if missing or os.WIFSIGNALED(status):
    sys.exit(1)

# second process: SIGINT must not leave the child
pid2, fd2 = pty.fork()
if pid2 == 0:
    os.environ["HOME"] = home
    os.environ["TERM"] = "xterm-256color"
    os.environ["TUNLESS_THEME"] = "dark"
    os.execv(bin_path, [bin_path])
read_for(fd2, 1.5)
os.kill(pid2, signal.SIGINT)
time.sleep(1.0)
wpid, status = os.waitpid(pid2, os.WNOHANG)
if wpid == 0:
    os.kill(pid2, signal.SIGKILL)
    os.waitpid(pid2, 0)
    print("sigint_left_process=yes")
    sys.exit(1)
print(f"sigint_left_process=no status={status}")
os.close(fd2)

def launch(extra_env):
    child, child_fd = pty.fork()
    if child == 0:
        os.environ["HOME"] = home
        os.environ["TERM"] = "xterm-256color"
        os.environ["TUNLESS_THEME"] = "dark"
        os.environ.pop("FORCE_COLOR", None)
        os.environ.update(extra_env)
        os.execv(bin_path, [bin_path])
    return child, child_fd

pid3, fd3 = launch({"NO_COLOR": "1"})
set_size(fd3, 24, 80)
color_text = read_for(fd3, 2.0)
os.write(fd3, b"q")
read_for(fd3, 0.8)
os.close(fd3)
os.waitpid(pid3, 0)
import re
color_sgr = re.findall(r"\x1b\[[0-9;]*m", color_text.decode("utf-8", "replace"))
open(log_path + ".nocolor", "wb").write(color_text)
print(f"nocolor_sgr={len(color_sgr)}")
if color_sgr:
    print("nocolor_sample=" + ",".join(color_sgr[:8]))
    sys.exit(1)

pid4, fd4 = launch({})
set_size(fd4, 24, 80)
read_for(fd4, 1.2)
os.write(fd4, b"\x04")
time.sleep(0.8)
wpid, ctrl_status = os.waitpid(pid4, os.WNOHANG)
if wpid == 0:
    os.kill(pid4, signal.SIGKILL)
    os.waitpid(pid4, 0)
    print("ctrld_left_process=yes")
    sys.exit(1)
print(f"ctrld_left_process=no status={ctrl_status}")
os.close(fd4)
