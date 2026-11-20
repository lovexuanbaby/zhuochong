"""Two-mode session controls, using mock Host packets and real Qt widgets."""
import json
import os
import pathlib
import sys
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "python"))
from PySide6.QtWidgets import QApplication
from pet_windows import PetWindow

app = QApplication([])
app.setQuitOnLastWindowClosed(False)
if os.environ.get("CONVERSATIONS_SHOT"):
    from PySide6.QtGui import QFontDatabase
    font = pathlib.Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"
    if font.exists(): QFontDatabase.addApplicationFont(str(font))
window = PetWindow()
window.show()
sent, pet_sent, dsh_sent, checks = [], [], [], []
window.on_conversations = sent.append
window.on_chat_submit = pet_sent.append
def send_dsh(session_id, text):
    dsh_sent.append((session_id, text))
    return 901
window.on_dsh_submit = send_dsh
chat = window.open_chat()
chat.toggle_sessions()
panel = chat._session_panel
assert sent[-1]["action"] == "list" and sent[-1]["mode"] == "pet"

def pet_packet(request_id, current="pet-one", revision=0, entries=None, replace=False):
    return {"type": "chat/sessions", "id": request_id, "revision": revision, "currentId": current,
            "sessions": [{"id": current, "title": "当前桌宠对话", "active": True}, {"id": "older", "title": "以前的聊天"}],
            "entries": entries or [], "replaceHistory": replace}

window.conversation_message(pet_packet(1))
panel._new.click()
assert sent[-1]["action"] == "new" and not chat._input.isEnabled()
chat._input.setText("切换期间不能误发")
chat.submit()
assert not pet_sent and not dsh_sent
window.conversation_message(pet_packet(2, current="pet-two", revision=1, replace=True))
assert chat._conversation_mode == "pet" and chat._input.isEnabled()
checks.append("New pet conversation switches only after Host confirmation")
panel._sessions.setCurrentIndex(1)
panel._clear.click()
assert panel._confirmation.isVisible() and QApplication.activeModalWidget() is None
assert "长期记忆" in panel._confirm_text.text()
panel._no.click()
assert not any(m.get("action") == "clear" for m in sent)
panel._delete.click(); panel._yes.click()
assert sent[-1]["action"] == "delete" and sent[-1]["sessionId"] == "older"
window.conversation_message(pet_packet(3, current="pet-two", revision=2))
checks.append("Local clear/delete uses scoped inline confirmation and cancellation")

panel._mode.setCurrentIndex(1)
assert sent[-1]["mode"] == "dsh" and sent[-1]["action"] == "list"
window.conversation_message({"type": "dsh/sessions", "id": 4, "sessions": [{"id": "dsh-existing", "title": "DSH历史任务"}], "workspaces": [{"id": "work", "title": "工作区", "path": "C:/work"}], "selectedId": None, "replaceHistory": False})
assert chat._conversation_mode == "pet", "browsing the manager must not silently change message routing"
assert panel._clear.isHidden() and panel._all.isHidden() and panel._delete.text() == "归档选中"
checks.append("DSH archive is distinguished from local permanent deletion")
panel._new.click()
assert sent[-1]["workspaceId"] == "work"
window.conversation_message({"type": "dsh/sessions", "id": 5, "sessions": [{"id": "dsh-new", "title": "新任务"}], "workspaces": [{"id": "work", "title": "工作区"}], "selectedId": "dsh-new", "replaceHistory": True,
                             "view": {"sessionId": "dsh-new", "entries": [], "running": False}})
assert chat._conversation_mode == "dsh" and chat._dsh_session_id == "dsh-new"
assert chat._input.isEnabled() and chat._dsh_stop.isVisible()
checks.append("Creates and activates a DSH conversation in the selected workspace")
chat._input.setText("执行测试任务"); chat.submit()
assert dsh_sent == [("dsh-new", "执行测试任务")] and not pet_sent
window.conversation_message({"type": "dsh/view", "sessionId": "dsh-new", "entries": [], "running": True})
assert chat.pending and not chat._input.isEnabled()
window.conversation_message({"type": "dsh/accepted", "id": 901, "sessionId": "dsh-new"})
assert not chat.pending and chat._input.isEnabled()
checks.append("DSH input uses its own route and waits for admission acknowledgement")
window.conversation_message({"type": "dsh/progress", "sessionId": "dsh-new", "text": "等待权限确认，请在 DSH 主窗口处理"})
assert "权限" in chat._status.text()
chat._dsh_stop.click()
assert sent[-1]["action"] == "cancel" and sent[-1]["sessionId"] == "dsh-new"
checks.append("Stop targets the selected DSH turn; permissions stay in DSH")
window.conversation_message({"type": "dsh/view", "sessionId": "dsh-new", "entries": [{"role": "assistant", "text": "DSH 真实任务回复", "time": "2026-11-19T10:00:00Z"}], "running": False})
assert chat.messages[-1] == ("pet", "DSH 真实任务回复")
window.chat_reply("迟到的桌宠回复")
assert chat.messages[-1] == ("pet", "DSH 真实任务回复")
checks.append("DSH history renders public replies without mixing pet responses")

if os.environ.get("CONVERSATIONS_SHOT"):
    app.processEvents()
    assert chat.grab().save(os.environ["CONVERSATIONS_SHOT"])

panel._mode.setCurrentIndex(0)
window.conversation_message(pet_packet(6, current="pet-two", revision=3))
panel._select.click()
window.conversation_message(pet_packet(7, current="pet-two", revision=3, entries=[{"role": "user", "text": "本地聊天", "time": "2026-11-19T10:00:00Z"}], replace=True))
assert chat._conversation_mode == "pet"
assert chat.messages[-1] == ("user", "本地聊天")
assert sent[-1]["action"] == "detach"
window.conversation_message({"type": "dsh/view", "sessionId": "dsh-new", "entries": [{"role": "assistant", "text": "迟到的 DSH 回复"}]})
assert chat.messages[-1] == ("user", "本地聊天")
checks.append("Returning to pet mode detaches the view and ignores late DSH packets")
panel._all.click(); panel._yes.click()
assert sent[-1]["action"] == "clear-all"
window.conversation_message({"type": "chat/sessions/error", "id": 8, "message": "保存失败，原记录已保留"})
assert chat.messages[-1] == ("user", "本地聊天") and chat._input.isEnabled()
checks.append("A failed clear operation leaves visible history and controls intact")
assert all(not b.autoDefault() for b in [panel._new, panel._select, panel._delete, panel._clear, panel._all, panel._yes, panel._no])
checks.append("Session actions do not hijack the chat Enter key or create modal dialogs")
chat.close(); window.close()
print(json.dumps({"ok": True, "checks": checks}))
