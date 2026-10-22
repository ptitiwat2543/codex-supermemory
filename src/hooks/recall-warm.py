#!/usr/bin/env python3
"""Linux, read-only HTTPS transport for recall. No credentials or content on disk."""
import argparse
import concurrent.futures
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import select
import socket
import ssl
import stat
import struct
import threading
import time
from urllib.parse import urlsplit

HOST = "api.supermemory.ai"
MAX_INPUT = 2 * 1024 * 1024
MAX_BODY = 8 * 1024 * 1024
MAX_ACTIVE = 32  # one limit for workers, listen backlog and accepted-but-unfinished requests
DEFAULT_BUDGET = 3.0  # seconds; the hook's hosted search deadline, used when a request names none
MAX_BUDGET = 10.0
MIN_ATTEMPT = 0.05  # not worth opening a connection with less time than this
HEARTBEAT = 0.1
READ_PATH = re.compile(r"/(?:v5/)?ns/[^/]+/(?:search|list/(?:memories|documents))/?\Z")


def same_uid(client):
    _, uid, _ = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return uid == os.getuid()


def private_directory(path):
    info = path.lstat()
    return (stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o077 and path.resolve() == path)


def validate(value):
    if not isinstance(value, dict) or value.get("v") != 1 or value.get("method") != "POST":
        raise ValueError("invalid request")
    url = urlsplit(value.get("url", ""))
    if (url.scheme != "https" or url.netloc != "api.supermemory.ai" or url.query or url.fragment
            or not READ_PATH.fullmatch(url.path)):
        raise ValueError("read route required")
    headers, body = value.get("headers"), value.get("body")
    if (not isinstance(headers, dict) or not isinstance(body, str) or
            any(not isinstance(k, str) or not isinstance(v, str) or "\n" in k + v or "\r" in k + v
                for k, v in headers.items())):
        raise ValueError("invalid payload")
    # Preserve application headers; http.client owns framing, authority and encoding.
    headers = {k: v for k, v in headers.items() if k.lower() not in {
        "host", "connection", "content-length", "transfer-encoding", "accept-encoding"}}
    headers["Accept-Encoding"] = "identity"
    return url.path, headers, body.encode("utf8"), budget_seconds(value.get("budget_ms"))


def budget_seconds(milliseconds):
    if milliseconds is None:
        return DEFAULT_BUDGET
    if isinstance(milliseconds, bool) or not isinstance(milliseconds, (int, float)) or not milliseconds > 0:
        raise ValueError("invalid budget")
    return min(milliseconds / 1000, MAX_BUDGET)


def cut(connection):
    """Wake any blocked read/write on this connection so the worker can finish at the deadline."""
    try:
        connection.sock.shutdown(socket.SHUT_RDWR)
    except (OSError, AttributeError):
        pass


class Transport:
    def __init__(self):
        context = ssl.create_default_context()
        self.pool = []
        self.lock = threading.Lock()
        self.connect = lambda timeout: http.client.HTTPSConnection(HOST, timeout=timeout, context=context)

    def request(self, path, headers, body, deadline=None):
        """One POST before `deadline` (time.monotonic). A pooled connection the server already dropped is replaced once."""
        deadline = deadline or time.monotonic() + DEFAULT_BUDGET
        with self.lock:
            connection = self.pool.pop() if self.pool else None
        reused = connection is not None
        while True:
            remaining = deadline - time.monotonic()
            if remaining < MIN_ATTEMPT:
                if connection is not None:
                    connection.close()
                raise TimeoutError("request budget spent")
            connection = connection or self.connect(remaining)
            try:
                return self.exchange(connection, path, headers, body, deadline)
            except (OSError, http.client.HTTPException):
                if not reused:
                    raise
                connection, reused = None, False

    def exchange(self, connection, path, headers, body, deadline):
        watchdog = threading.Timer(max(0.0, deadline - time.monotonic()), cut, (connection,))
        watchdog.start()
        keep = False
        try:
            if connection.sock is None:
                connection.connect()  # DNS, TCP and TLS happen here, apart from sending
            left = deadline - time.monotonic()
            if left <= 0:  # a slow connect must not turn into a late POST
                raise TimeoutError("request budget spent")
            if connection.sock is not None:  # re-arm to what is left, not the connect-time or old timeout
                connection.sock.settimeout(left)
            connection.request("POST", path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read(MAX_BODY + 1)
            if len(data) > MAX_BODY:
                raise ValueError("response too large")
            if response.length:  # read(n) returns a cut-off body quietly; never pass that on as a result
                raise http.client.IncompleteRead(data, response.length)
            keep = not response.will_close
            return {"v": 1, "status": response.status,
                    "headers": {"content-type": response.getheader("content-type", "application/json")},
                    "body": data.decode("utf8")}
        finally:
            watchdog.cancel()
            if keep:
                with self.lock:
                    self.pool.append(connection)
            else:
                connection.close()

    def close(self):
        for connection in self.pool:
            connection.close()


def handle(client, transport):
    worker = None
    try:
        # Inspect credentials before reading any prompt or key.
        if not same_uid(client):
            return
        client.settimeout(0.2)
        buffer = bytearray()
        while b"\n" not in buffer:
            part = client.recv(min(65536, MAX_INPUT + 1 - len(buffer)))
            if not part or len(buffer) + len(part) > MAX_INPUT:
                return
            buffer.extend(part)
        *request, budget = validate(json.loads(bytes(buffer).split(b"\n", 1)[0]))
        deadline = time.monotonic() + budget
        client.sendall(b'{"v":1,"ready":true}\n')
        completed, box = threading.Event(), {}
        def perform():
            try:
                box["result"] = transport.request(*request, deadline)
            except Exception:
                pass  # Never keep error text: it can echo the request.
            finally:
                completed.set()
        worker = threading.Thread(target=perform, daemon=True)
        worker.start()
        while not completed.wait(HEARTBEAT):
            if time.monotonic() >= deadline:
                break  # The worker is cut at the same deadline; stop heartbeating and let the hook fall back.
            client.sendall(b'{"v":1,"busy":true}\n')
        client.settimeout(1)
        result = box.get("result")
        if result is None:
            client.sendall(b'{"v":1,"error":true}\n')
        else:
            client.sendall(json.dumps(result, ensure_ascii=True).encode() + b"\n")
    except Exception:
        # Disconnect triggers the caller's original fetch. Never log request/error content.
        pass
    finally:
        client.close()
        if worker is not None:
            worker.join()  # Retain the request slot until HTTPS finishes, even on client disconnect.


def serve(path, idle_seconds=120, transport=None):
    path = Path(path)
    if not path.is_absolute() or len(os.fsencode(path)) >= 104 or not private_directory(path.parent):
        raise ValueError("private runtime directory required")
    lock = os.open(path.parent / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("private lock required")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError("unsafe socket")
            path.unlink()  # stale socket, only after owning the lifetime lock
        transport = transport or Transport()
        with socket.socket(socket.AF_UNIX) as server, concurrent.futures.ThreadPoolExecutor(max_workers=MAX_ACTIVE) as workers:
            previous = os.umask(0o177)  # the socket is created 0600; there is no wider window to chmod away
            try:
                server.bind(str(path))
            finally:
                os.umask(previous)
            server.listen(MAX_ACTIVE)
            inode = path.stat().st_ino
            pending = set()
            last = time.monotonic()
            try:
                while True:
                    done = {future for future in pending if future.done()}
                    if done:
                        pending -= done; last = time.monotonic()
                    if not pending and time.monotonic() - last >= idle_seconds:
                        break
                    if select.select([server], [], [], 0.05)[0]:
                        client, _ = server.accept()
                        if len(pending) >= MAX_ACTIVE:
                            client.close()
                        else:
                            pending.add(workers.submit(handle, client, transport))
            finally:
                if path.exists() and path.lstat().st_ino == inode:
                    path.unlink()
        transport.close()
    finally:
        os.close(lock)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--idle-seconds", type=float, default=120)
    args = parser.parse_args()
    if not 0 < args.idle_seconds <= 3600:
        parser.error("idle-seconds must be between 0 and 3600")
    try:
        serve(args.socket, args.idle_seconds)
    except Exception:
        # Optional acceleration: original hook stays available without this process.
        raise SystemExit(1)
