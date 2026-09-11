#!/usr/bin/env python3
"""Run bundled websockify with NewHome same-origin debug telemetry."""

from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
if (HERE / "websockify" / "websockify").is_dir():
    sys.path.insert(0, str(HERE / "websockify"))

from websockify import websocketproxy  # noqa: E402
from websockify.websockifyserver import WebSockifyRequestHandler  # noqa: E402

DEBUG_PATH = "/newhome-debug"
LOG_PATH = Path(os.environ.get(
    "NOVNC_BROWSER_DEBUG_LOG", "/tmp/novnc-browser-debug.jsonl"
))
MAX_BODY = 2 * 1024 * 1024
MAX_LOG = 4 * 1024 * 1024
DROP_KEYS = {"text", "value", "data", "password", "credentials", "clipboardtext"}
write_lock = threading.Lock()
original_do_post = WebSockifyRequestHandler.do_POST


def sanitize(value, depth=0):
    if depth > 4:
        return "[depth-limit]"
    if isinstance(value, dict):
        return {
            str(key)[:80]: sanitize(item, depth + 1)
            for key, item in value.items()
            if str(key).lower() not in DROP_KEYS
        }
    if isinstance(value, list):
        return [sanitize(item, depth + 1) for item in value[:100]]
    if isinstance(value, str):
        return value[:1000]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:1000]


def append_events(client, payload):
    session = str(payload.get("session", "unknown"))[:100]
    events = payload.get("events", [])
    if not isinstance(events, list):
        raise ValueError("events must be a list")

    lines = []
    for event in events[:100]:
        if not isinstance(event, dict):
            continue
        record = {
            "receivedAt": datetime.now(timezone.utc).isoformat(),
            "client": client,
            "session": session,
            **sanitize(event),
        }
        lines.append(json.dumps(record, ensure_ascii=False, separators=(",", ":")))

    if not lines:
        return
    with write_lock:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > MAX_LOG:
            rotated = LOG_PATH.with_suffix(LOG_PATH.suffix + ".1")
            os.replace(LOG_PATH, rotated)
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")
        os.chmod(LOG_PATH, 0o600)


def request_origin(handler):
    origin = handler.headers.get("Origin")
    if origin:
        return origin
    referer = handler.headers.get("Referer")
    if referer:
        parsed = urlparse(referer)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    return None


def same_origin(handler):
    origin = request_origin(handler)
    host = handler.headers.get("Host")
    if not origin or not host:
        return False
    parsed = urlparse(origin)
    return parsed.scheme in ("http", "https") and parsed.netloc == host


def newhome_do_post(self):
    path = urlparse(self.path).path
    if path != DEBUG_PATH:
        return original_do_post(self)
    if self.headers.get("X-NewHome-Debug") != "1" or not same_origin(self):
        self.send_error(403)
        return
    try:
        length = int(self.headers.get("Content-Length", "0"))
    except ValueError:
        self.send_error(400)
        return
    if length <= 0 or length > MAX_BODY:
        self.send_error(413)
        return
    try:
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        append_events(self.client_address[0], payload)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError):
        self.send_error(400)
        return
    self.send_response(204)
    self.send_header("Content-Length", "0")
    self.send_header("Cache-Control", "no-store")
    self.end_headers()


WebSockifyRequestHandler.do_POST = newhome_do_post

if __name__ == "__main__":
    websocketproxy.websockify_init()
