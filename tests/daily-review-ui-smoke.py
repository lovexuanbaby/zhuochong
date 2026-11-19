"""Daily recap UI: no real model calls or user-data reads."""
import json
import os
import pathlib
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "python"))
from PySide6.QtWidgets import QApplication
from pet_windows import PetWindow

app = QApplication([])
shot = os.environ.get("DAILY_REVIEW_SHOT")
if shot:
    from PySide6.QtGui import QFontDatabase
    font = pathlib.Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"
    if font.exists():
        QFontDatabase.addApplicationFont(str(font))

checks = []
window = PetWindow()
sent = []
window.on_daily_review = sent.append
chat = window.open_chat()
before = chat.messages
chat.open_daily_review()
review = chat._review_dialog
assert sent[-1] == {"type": "review/open", "id": 1}
checks.append("Opens through the chat toolbar callback")

def response(request_id, day="2026-11-19", revision=0, **extra):
    return {"id": request_id, "day": day, "dates": ["2026-11-19", "2026-11-18"],
            "mode": "local", "taskCount": 2, "text": f"{day} 工作回顾\n记录 2 项任务。\n• 实现日报 — 已结束\n• 更新安装说明 — 进行中",
            "style": {"revision": revision, "brevity": 0, "formality": 0, "feedback": []}, **extra}

window.daily_review_result(response(1))
assert review._generate.isEnabled() and review._pending_id is None
assert review._date.currentText() == "2026-11-19"
checks.append("Local result renders and enables optional model polishing")
review._generate.click()
assert sent[-1] == {"type": "review/generate", "id": 2, "day": "2026-11-19", "styleRevision": 0}
window.daily_review_progress(2, "记录员 → 总结员：生成中")
assert "生成中" in review._status.text()
window.daily_review_result(response(2, mode="model", text="今日完成日报功能，安装说明仍在跟进。"))
checks.append("Polishing sends date/version and displays orchestration progress")
review._feedback_buttons[0].click()
assert sent[-1]["feedback"] == "shorter" and sent[-1]["revision"] == 0
learned = response(3, revision=1)
learned["style"].update(brevity=1, feedback=[{"choice": "shorter", "revision": 1}])
window.daily_review_result(learned)
assert "已采纳 1 次" in review._status.text() and "简洁" in review._status.text()
checks.append("Explicit feedback displays persisted learning revision")
review._generate.click()
assert sent[-1]["styleRevision"] == 1
review.hide()
assert sent[-1] == {"type": "review/cancel", "id": 4}
assert review._pending_id is None and not review._timeout.isActive()
checks.append("Closing cancels the matching request")
chat.open_daily_review()
window.daily_review_result(response(4, text="过期响应"))
assert review._pending_id == 5 and review._report.toPlainText() != "过期响应"
window.daily_review_error(5, "暂时无法生成，请刷新")
assert review._refresh.isEnabled()
checks.append("Late responses are ignored and errors allow refresh")
review._refresh.click()
review._timeout.timeout.emit()
assert sent[-1] == {"type": "review/cancel", "id": 6}
assert review._refresh.isEnabled() and "超时" in review._status.text()
checks.append("Timeout stops waiting and preserves retry controls")
review._refresh.click()
window.daily_review_result(response(7))
review._date.setCurrentIndex(1)
assert sent[-1] == {"type": "review/open", "id": 8, "day": "2026-11-18"}
window.daily_review_result(response(8, day="2026-11-18"))
review._refresh.click()
assert sent[-1]["day"] == "2026-11-18"
window.daily_review_result(response(9, day="2026-11-18"))
checks.append("Date selection and refresh retain the selected day")
assert chat.messages == before
assert all(not button.autoDefault() and not button.isDefault() for button in [review._generate, review._refresh, review._close, *review._feedback_buttons])
checks.append("Review operations preserve chat history and do not hijack Enter")
review._refresh.click()
window.daily_review_result({"id": 10, "style": None})
assert review._pending_id is None and review._refresh.isEnabled()
checks.append("Malformed responses recover instead of freezing the UI")

if shot:
    review._refresh.click()
    preview = response(11, revision=3)
    preview.update(mode="model", text="今天主要推进了两项工作：\n\n• 每日回顾：接通任务记录、模型总结和风格反馈，定向测试通过。\n• 安装说明：补充配置说明，仍待最后检查。\n\n编排记录：2 个会话，其中 1 个子 agent 轮次，共调用工具 6 次。\n\n待跟进：在 DSH 中体验日报入口与表达偏好。")
    preview["style"].update(brevity=1, formality=-1, feedback=[{"choice": "shorter"}])
    window.daily_review_result(preview)
    app.processEvents()
    assert review.grab().save(shot)
    assert chat.grab().save(shot + ".chat.png")
review.close()
chat.close()
window.close()
print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False))
