#!/usr/bin/env python3
"""桌宠对话窗口冒烟测试：离屏渲染，不需要真实桌面或 DSH。

覆盖：打开对话框、提交回调、等待状态、回复显示、连续对话、
失败回显、长文本换行，以及原有 set_status 状态入口未被破坏。

用法（需要带 PySide6 的解释器）：
    python tests/chat-ui-smoke.py

可选环境变量：
    CHAT_SMOKE_SHOT       对话框截图保存路径
    CHAT_SMOKE_SHOT_PET   桌宠窗口截图保存路径
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from PySide6.QtCore import QCoreApplication, QEvent, Qt  # noqa: E402
from PySide6.QtTest import QTest  # noqa: E402
from PySide6.QtWidgets import QApplication, QMessageBox  # noqa: E402

from pet_windows import PetWindow  # noqa: E402


def flush_deferred_deletes(app: QApplication) -> None:
    """让 deleteLater 的旧气泡真正销毁，避免计数到已移除的控件。"""
    QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    app.processEvents()


def main() -> int:
    checks: list[tuple[str, bool]] = []
    app = QApplication([])
    if os.environ.get("MEMORY_SMOKE_SHOT"):
        from PySide6.QtGui import QFontDatabase
        font = pathlib.Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"
        if font.exists():
            QFontDatabase.addApplicationFont(str(font))

    window = PetWindow()
    sent: list[str] = []
    window.on_chat_submit = sent.append
    window.set_status("任务完成", "done")
    checks.append(("原有 set_status 状态入口正常", window._state == "done"))

    dialog = window.open_chat()
    checks.append(("open_chat 打开对话窗口", dialog.isVisible()))
    checks.append(
        ("初始欢迎气泡", bool(dialog.messages) and dialog.messages[0][0] == "pet")
    )

    # 第一轮：提交 → 等待 → 回复
    dialog._input.setText("你好，桌宠")
    dialog.submit()
    checks.append(("提交后回调收到原文", sent == ["你好，桌宠"]))
    checks.append(("提交后显示用户气泡", dialog.messages[-1] == ("user", "你好，桌宠")))
    checks.append(
        ("等待期间禁用输入", dialog.pending and not dialog._input.isEnabled())
    )

    window.chat_status("DSH 正在思考")
    checks.append(
        ("accepted 后状态提示可见", dialog._status.isVisible() and "思考" in dialog._status.text())
    )

    window.chat_reply("收到，我在呢。")
    checks.append(("回复追加为宠物气泡", dialog.messages[-1] == ("pet", "收到，我在呢。")))
    checks.append(("回复后恢复输入", not dialog.pending and dialog._input.isEnabled()))

    # 第二轮：连续对话
    dialog._input.setText("第二条消息")
    dialog.submit()
    window.chat_reply("第二条回复")
    checks.append(("连续对话第二轮正常", dialog.messages[-1] == ("pet", "第二条回复")))

    # 失败反馈
    dialog._input.setText("这条会失败")
    dialog.submit()
    window.chat_error("DSH 会话发送失败：session not found")
    checks.append(
        (
            "失败以错误气泡回显",
            dialog.messages[-1][0] == "error" and "失败" in dialog.messages[-1][1],
        )
    )
    checks.append(("失败后恢复输入", not dialog.pending and dialog._input.isEnabled()))

    # 长文本不撑破气泡
    dialog._input.setText("长" * 120)
    dialog.submit()
    window.chat_reply("长回复" * 60)
    checks.append(("长文本/长回复可显示", dialog.messages[-1][0] == "pet"))
    bubble_labels = [
        label
        for label in dialog.findChildren(type(dialog._status))
        if label.maximumWidth() == 256
    ]
    checks.append(
        (
            "气泡宽度受限于对话框",
            len(bubble_labels) >= 6
            and all(label.width() <= 256 for label in bubble_labels),
        )
    )
    checks.append(("气泡可被选中复制", all(label.textInteractionFlags() for label in bubble_labels)))

    # 回归：按 Enter 只发送，不能同时触发默认按钮把对话框关掉。
    dialog._input.setText("回车发送")
    QTest.keyClick(dialog._input, Qt.Key.Key_Return)
    checks.append(("Enter 发送后对话框保持打开", dialog.isVisible()))
    checks.append(("Enter 发送进入等待状态", dialog.pending))
    window.chat_reply("收到回车消息")
    checks.append(("Enter 发送的回复可显示", dialog.messages[-1] == ("pet", "收到回车消息")))

    # 持久化历史恢复：气泡重建、按天分隔、空历史回到欢迎语。
    window.set_chat_history(
        [
            {"role": "user", "text": "昨天说到哪了？", "time": "2026-11-04T10:00:00+08:00"},
            {"role": "assistant", "text": "在聊桌宠的记忆功能。", "time": "2026-11-04T10:00:05+08:00"},
            {"role": "user", "text": "今天继续。", "time": "2026-11-05T09:00:00+08:00"},
        ]
    )
    app.processEvents()
    flush_deferred_deletes(app)
    checks.append(
        (
            "历史恢复到对话框",
            len(dialog.messages) == 3 and dialog.messages[-1] == ("user", "今天继续。"),
        )
    )
    date_labels = [
        label
        for label in dialog.findChildren(type(dialog._status))
        if "年" in label.text() and "月" in label.text()
    ]
    checks.append(("历史按日期分隔", len(date_labels) == 2))
    window.set_chat_history([])
    app.processEvents()
    checks.append(
        (
            "空历史回到欢迎语",
            len(dialog.messages) == 1 and dialog.messages[0][0] == "pet",
        )
    )

    # 长期记忆提示：标题栏显示“已记住 N 件事”。
    window.set_memory_count(3)
    checks.append(("记忆数量显示在标题栏", "已记住 3 件事" in dialog._hint.text()))
    window.set_memory_count(0)
    checks.append(("记忆清零回到模型提示", "DSH 配置的模型" in dialog._hint.text()))

    # 记忆管理：列表可加载，删除入口携带稳定 index；不改变聊天气泡。
    memory_requests: list[object] = []
    delete_requests: list[object] = []
    window.on_memory_list = lambda request_id: memory_requests.append(("list", request_id))
    window.on_memory_delete = lambda fact_id, revision, request_id: delete_requests.append((fact_id, revision, request_id))
    before_memory = dialog.messages[:]
    dialog.open_memory()
    facts = [
        {"id": "blue", "kind": "preference", "text": "喜欢青色"},
        {"id": "timer", "kind": "goal", "text": "想做计时功能"},
    ]
    dialog.set_memory_facts(facts, 7, 1)
    app.processEvents()
    checks.append(("记忆入口请求列表", memory_requests == [("list", 1)]))
    checks.append(("记忆列表显示事实", dialog._memory_dialog._list.count() == 2))
    dialog._memory_dialog._list.setCurrentRow(1)
    checks.append(("记忆列表保留稳定 id", dialog._memory_dialog._list.currentItem().data(Qt.ItemDataRole.UserRole) == "timer"))
    checks.append(("打开记忆不改变聊天历史", dialog.messages == before_memory))
    memory = dialog._memory_dialog
    with patch.object(QMessageBox, "question", return_value=QMessageBox.StandardButton.No):
        memory._delete.click()
    checks.append(("取消删除不发送请求", delete_requests == [] and memory._list.count() == 2))
    with patch.object(QMessageBox, "question", return_value=QMessageBox.StandardButton.Yes):
        memory._delete.click()
    checks.append(("确认删除发送稳定标识和版本", delete_requests == [("timer", 7, 2)]))
    checks.append(("等待保存时保留原条目", memory._list.count() == 2 and memory._timeout.isActive() and not memory._delete.isEnabled()))
    window.memory_error("保存失败，请刷新重试", 2)
    checks.append(("保存失败恢复刷新入口", memory._pending_request is None and memory._refresh.isEnabled() and memory._list.count() == 2))
    memory.refresh()
    window.set_memory_facts(facts, 7, 3)
    memory._list.setCurrentRow(1)
    with patch.object(QMessageBox, "question", return_value=QMessageBox.StandardButton.Yes):
        memory._delete.click()
    window.set_memory_facts([facts[0]], 8, 4)
    checks.append(("成功响应后才移除条目", memory._list.count() == 1 and memory._pending_request is None and dialog.messages == before_memory))
    memory.refresh()  # request 5
    memory._timeout.timeout.emit()
    checks.append(("超时后可以重新刷新", memory._refresh.isEnabled() and memory._pending_request is None))
    memory.refresh()  # request 6
    window.set_memory_facts(facts, 7, 5)
    checks.append(("迟到响应不覆盖新请求", memory._pending_request == 6 and memory._list.count() == 1))
    window.set_memory_facts([], 9, 6)
    checks.append(("记忆按钮不抢聊天回车", not dialog._memory_btn.autoDefault() and not dialog._memory_btn.isDefault()))
    dialog._memory_dialog.set_facts([])
    checks.append(("空记忆显示空状态", dialog._memory_dialog._empty.isVisible()))

    # 截图用：放一段带日期的示例历史
    window.set_chat_history(
        [
            {"role": "user", "text": "记住：我喜欢青色的桌宠。", "time": "2026-11-04T20:10:00+08:00"},
            {"role": "assistant", "text": "好呀，我记住了～", "time": "2026-11-04T20:10:04+08:00"},
            {"role": "user", "text": "我们昨天聊了什么？", "time": "2026-11-05T09:02:00+08:00"},
            {"role": "assistant", "text": "你让我记住你喜欢青色的桌宠呀。", "time": "2026-11-05T09:02:05+08:00"},
        ]
    )
    app.processEvents()

    shot = os.environ.get("CHAT_SMOKE_SHOT")
    if shot:
        dialog.grab().save(shot)
    pet_shot = os.environ.get("CHAT_SMOKE_SHOT_PET")
    if pet_shot:
        window.set_status("正在思考……", "thinking")
        window.repaint()
        window.grab().save(pet_shot)
    if os.environ.get("MEMORY_SMOKE_SHOT"):
        memory.set_facts([
            facts[0],
            {"id": "long", "kind": "goal", "text": "希望桌宠可以提醒休息、记录每日目标，并在重启后继续保留这些重要安排。"},
            {"id": "habit", "kind": "habit", "text": "喜欢在晚上整理当天的学习记录"},
        ], 10)
        memory._list.setCurrentRow(1)
        app.processEvents()
        assert memory.grab().save(os.environ["MEMORY_SMOKE_SHOT"])
        assert dialog.grab().save(os.environ["MEMORY_SMOKE_SHOT"] + ".chat.png")

    ok = all(passed for _, passed in checks)
    print(
        json.dumps(
            {
                "ok": ok,
                "checks": [{"name": name, "ok": passed} for name, passed in checks],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
