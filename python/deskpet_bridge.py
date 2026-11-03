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
import threading
from queue import Queue, Empty

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from pet_windows import PetWindow
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

def read_messages(inbox, stop_event):
    pending = b""
    stdin_fd = sys.stdin.fileno()

    try:
        while not stop_event.is_set():
            chunk = os.read(stdin_fd, 4096)

            if not chunk:
                break  # JS 关闭了输入通道

            pending += chunk

            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)

                if not line.strip():
                    continue

                try:
                    message = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    inbox.put({
                        "type": "_input_error",
                        "message": "收到的消息不是有效的 UTF-8 JSON",
                    })
                    continue

                if isinstance(message, dict):
                    inbox.put(message)

    except OSError:
        inbox.put({
            "type": "_input_error",
            "message": "输入通道读取失败",
        })
    finally:
        inbox.put(None)  # 告诉主线程：读取已结束

def main() -> int:
    configure_streams()

    app = QApplication(sys.argv)
    window = PetWindow()

    inbox = Queue()
    stop_event = threading.Event()

    reader = threading.Thread(
        target=read_messages,
        args=(inbox, stop_event),
        daemon=True,
    )

    def process_messages():
        # 每次最多处理 100 条，给窗口事件留出处理时间
        for _ in range(100):
            try:
                message = inbox.get_nowait()
            except Empty:
                return

            if message is None:
                app.quit()
                return

            message_type = message.get("type")

            if message_type == "ping":
                send({
                    "type": "pong",
                    "id": message.get("id"),
                    "pid": os.getpid(),
                    "echo": message.get("sentAt"),
                })

            elif message_type == "pet.state":
                labels = {
                    "idle": "等待响应中",
                    "thinking": "正在思考……",
                    "done": "任务完成",
                    "error":"任务失败",
                    "aborted":"任务中断",
                    "ended":"任务结束（其他原因）",
                }

                state = message.get("state")

                if isinstance(state, str) and state in labels:
                    window.set_status(labels[state], state)
                else:
                    log("收到未知的桌宠状态")

            elif message_type == "shutdown":
                send({
                    "type": "bye",
                    "id": message.get("id"),
                    "pid": os.getpid(),
                })
                app.quit()
                return

            elif message_type == "_input_error":
                log(message["message"])

            else:
                log(f"未知消息类型：{message_type!r}")

    timer = QTimer()
    timer.timeout.connect(process_messages)
    timer.start(50)

    window.show()
    reader.start()

    # 进入 Qt 事件循环后发送 ready
    QTimer.singleShot(0, lambda: send({"type": "ready"}))

    try:
        return app.exec()
    finally:
        stop_event.set()
        timer.stop()

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        log("stdout pipe closed before exit")
        raise SystemExit(1)
    except KeyboardInterrupt:
        log("interrupted")
        raise SystemExit(130)
