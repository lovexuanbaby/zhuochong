#!/usr/bin/env python3
"""Minimal Python peer for the DSH deskpet bridge.

Protocol: one JSON object per line on stdin/stdout.
- stdin:  {"type":"ping","id":1,...} or {"type":"shutdown","id":2}
- stdout: {"type":"pong","id":1,...} or {"type":"bye","id":2}

All diagnostics go to stderr and never to stdout.
"""

from __future__ import annotations

import json
import os
import sys

VERSION = "0.1.0"


def log(message: str) -> None:
    """Write a diagnostic line to stderr, flushed immediately."""
    print(f"[deskpet] {message}", file=sys.stderr, flush=True)


def send(message: dict) -> None:
    """Write exactly one protocol message to stdout."""
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def configure_streams() -> None:
    """Use UTF-8 and unbuffered line delivery regardless of Windows code page."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    try:
        sys.stdout.reconfigure(newline="\n")
    except (AttributeError, ValueError):
        pass


def main() -> int:
    configure_streams()
    log(f"starting pid={os.getpid()} ppid={os.getppid()} version={VERSION}")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            log(f"ignoring invalid JSON: {error}")
            continue

        if not isinstance(message, dict):
            log(f"ignoring non-object message: {type(message).__name__}")
            continue

        message_type = message.get("type")
        if message_type == "ping":
            log(f"ping id={message.get('id')} reason={message.get('reason')}")
            send(
                {
                    "type": "pong",
                    "id": message.get("id"),
                    "pid": os.getpid(),
                    "echo": message.get("sentAt"),
                }
            )
        elif message_type == "shutdown":
            log(f"shutdown requested id={message.get('id')}")
            send({"type": "bye", "id": message.get("id"), "pid": os.getpid()})
            break
        else:
            log(f"ignoring unknown message type={message_type!r}")

    log("stdin closed; exiting")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        log("stdout pipe closed before exit")
        raise SystemExit(1)
    except KeyboardInterrupt:
        log("interrupted")
        raise SystemExit(130)
