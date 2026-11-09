#!/usr/bin/env python3
"""Minimal Python peer for the DSH deskpet bridge.

Protocol: one JSON object per line on stdin/stdout.

Host → Python:
- {"type":"ping","id":1,...}        → {"type":"pong","id":1,...}
- {"type":"shutdown","id":2}        → {"type":"bye","id":2}
- {"type":"pet.state","state":"thinking"}   切换桌宠气泡/表情
- {"type":"pet.state","state":"idle","result":{"id":1,"state":"done"}}  活动与结果独立
- {"type":"chat/history","entries":[...]}    跨重启恢复的对话历史
- {"type":"chat/memory","count":12}          长期记忆条数（标题栏提示）
- {"type":"chat/memory/details","id":1,"revision":0,"items":[{"id":"...","kind":"preference","text":"..."}]}  记忆管理
- {"type":"chat/accepted","id":7}           DSH 已接收桌宠输入
- {"type":"chat/reply","id":7,"text":"...","reason":"completed"}  回复收尾
- {"type":"chat/error","id":7,"message":"..."}                    发送失败

Python → Host:
- {"type":"ready"}
- {"type":"pong",...} / {"type":"bye",...}
- {"type":"chat","id":7,"text":"..."}       用户在对话框里发送

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

from pet_windows import PetWindow, RESULT_STATES, STATE_LABELS
VERSION = "0.2.0-rc.1"


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

    # 桌宠对话：用户输入 → Host 会话；Host 回复 → 对话框。
    # chat id 与 ping id 分开编号，避免两条协议互相干扰。
    next_chat = {"id": 1}
    pending_chats: set[int] = set()

    def send_chat(text: str) -> None:
        """对话框提交回调：把文本交给 JS 插件。"""
        chat_text = text.strip()
        if chat_text == "":
            return
        chat_id = next_chat["id"]
        next_chat["id"] += 1
        pending_chats.add(chat_id)
        send({"type": "chat", "id": chat_id, "text": chat_text})
        log(f"chat #{chat_id} → host ({len(chat_text)} chars)")

    window.on_chat_submit = send_chat
    window.on_memory_list = lambda request_id: send({"type": "memory/list", "id": request_id})
    window.on_memory_delete = lambda fact_id, revision, request_id: send({
        "type": "memory/delete", "id": request_id, "factId": fact_id, "revision": revision,
    })

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
            message_id = message.get("id")

            if message_type == "ping":
                send({
                    "type": "pong",
                    "id": message.get("id"),
                    "pid": os.getpid(),
                    "echo": message.get("sentAt"),
                })

            elif message_type == "pet.state":
                state = message.get("state")
                result = message.get("result")
                if result is not None and not (
                    isinstance(result, dict)
                    and type(result.get("id")) is int
                    and result["id"] > 0
                    and isinstance(result.get("state"), str)
                    and result["state"] in RESULT_STATES
                ):
                    log("收到无效的任务结果")
                    continue
                if state in ("thinking", "idle"):
                    window.set_agent_state(state, result)
                elif isinstance(state, str) and state in STATE_LABELS:
                    window.set_status(STATE_LABELS[state], state)
                else:
                    log("收到未知的桌宠状态")

            elif message_type == "chat/history":
                entries = message.get("entries")
                window.set_chat_history(entries)
                count = len(entries) if isinstance(entries, list) else 0
                log(f"chat history restored: {count} messages")

            elif message_type == "chat/memory":
                count = message.get("count")
                window.set_memory_count(count)
                log(f"long-term memory: {count} facts")

            elif message_type == "chat/memory/details":
                window.set_memory_facts(message.get("items"), message.get("revision"), message.get("id"), message.get("enabled", True))

            elif message_type == "chat/memory/error":
                window.memory_error(message.get("message") or "记忆操作失败", message.get("id"))
                log(f"long-term memory error: {message.get('message')}")

            elif message_type == "chat/accepted":
                pending_chats.discard(message_id)
                window.chat_status("DSH 正在思考")
                log(f"chat #{message_id} accepted")

            elif message_type == "chat/reply":
                reason = message.get("reason")
                text = message.get("text")
                detail = message.get("detail")
                pending_chats.discard(message_id)
                if not isinstance(text, str):
                    text = ""
                if reason == "error":
                    window.chat_reply(
                        text or (f"DSH 返回错误：{detail}" if detail else "DSH 返回错误"),
                        ok=False,
                    )
                elif reason == "aborted":
                    window.chat_reply(text or "已中止，没有生成回复", ok=True)
                else:
                    window.chat_reply(text or "（本轮没有文本回复）", ok=True)
                log(f"chat #{message_id} reply ({reason})")

            elif message_type == "chat/error":
                detail = message.get("message") or message.get("code") or "发送失败"
                pending_chats.discard(message_id)
                window.chat_error(detail)
                log(f"chat #{message_id} error: {detail}")

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
