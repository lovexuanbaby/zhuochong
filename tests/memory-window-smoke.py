"""Real Qt event loop and production bridge: deletion must not exit the pet."""
import json
import os
import pathlib
import sys
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "python"))
from PySide6.QtCore import QTimer, Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QDialog
import deskpet_bridge as bridge

facts = [{"id": "one", "kind": "fact", "text": "用于测试的记忆，不读取用户数据"}]
queues, messages, failures, checks, quitting = [], [], [], [], []
windows = []
keeper = []

def guard(fn):
    def run():
        try:
            fn()
        except Exception as error:
            failures.append(repr(error))
            QApplication.instance().quit()
    return run

def send(message):
    messages.append(message)
    if message["type"] == "memory/list":
        queues[0].put({"type": "chat/memory/details", "id": message["id"], "revision": 0, "items": facts})
    elif message["type"] == "memory/delete":
        queues[0].put({"type": "chat/memory/details", "id": message["id"], "revision": 1, "items": []})

def feed(inbox, stop):
    queues.append(inbox)

class ProbePet(bridge.PetWindow):
    def __init__(self):
        super().__init__()
        windows.append(self)
        QApplication.instance().aboutToQuit.connect(lambda: quitting.append(True))
        QTimer.singleShot(0, guard(begin))
        QTimer.singleShot(3000, guard(watchdog))

def watchdog():
    failures.append("Qt loop timed out or was blocked by confirmation")
    modal = QApplication.activeModalWidget()
    if modal is not None:
        modal.reject()
    QApplication.instance().quit()

def begin():
    if not queues:
        QTimer.singleShot(5, guard(begin))
        return
    assert not QApplication.instance().quitOnLastWindowClosed(), "production bridge must own process exit"
    if os.environ.get("MEMORY_CONFIRM_SHOT"):
        from PySide6.QtGui import QFontDatabase
        font = pathlib.Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"
        if font.exists():
            QFontDatabase.addApplicationFont(str(font))
    chat = windows[0].open_chat()
    chat.open_memory()
    QTimer.singleShot(100, guard(confirm_panel))

def confirm_panel():
    window = windows[0]
    memory = window.chat_dialog._memory_dialog
    assert memory._list.count() == 1
    memory._list.setCurrentRow(0)
    visible = {id(w) for w in QApplication.topLevelWidgets() if w.isVisible()}
    memory._delete.click()
    assert memory._confirmation.isVisible() and not memory._confirmation.isWindow()
    assert QApplication.activeModalWidget() is None
    assert {id(w) for w in QApplication.topLevelWidgets() if w.isVisible()} == visible
    assert window.isVisible() and window.chat_dialog.isVisible()
    checks.append("Delete confirmation stays inside the existing memory panel")
    if os.environ.get("MEMORY_CONFIRM_SHOT"):
        assert memory.grab().save(os.environ["MEMORY_CONFIRM_SHOT"])
    keeper.append(window._t)
    queues[0].put({"type": "ping", "id": 71})
    QTimer.singleShot(120, guard(cancel_and_delete))

def cancel_and_delete():
    window = windows[0]
    memory = window.chat_dialog._memory_dialog
    assert window._t > keeper[0]
    assert any(m["type"] == "pong" and m["id"] == 71 for m in messages)
    assert not quitting
    checks.append("Animation and production ping/pong continue during confirmation")
    QTest.keyClick(memory, Qt.Key.Key_Escape)
    assert not memory._confirmation.isVisible() and memory.isVisible()
    assert not any(m["type"] == "memory/delete" for m in messages)
    checks.append("Escape cancels without deleting or hiding the parent windows")
    memory._delete.click()
    memory._confirm_delete.click()
    memory.confirm_selected()  # a repeated activation must not delete twice
    QTimer.singleShot(100, guard(after_delete))

def after_delete():
    window = windows[0]
    memory = window.chat_dialog._memory_dialog
    deletes = [m for m in messages if m["type"] == "memory/delete"]
    assert len(deletes) == 1 and deletes[0]["factId"] == "one" and deletes[0]["revision"] == 0
    assert memory._list.count() == 0 and memory.isVisible()
    assert window.isVisible() and window.chat_dialog.isVisible() and not quitting
    checks.append("Confirmed deletion reaches Host once and leaves all pet windows alive")
    # A new list invalidates an earlier confirmation target.
    memory.set_facts(facts, 2)
    memory._list.setCurrentRow(0)
    memory._delete.click()
    memory.set_facts([], 3)
    memory.confirm_selected()
    assert len([m for m in messages if m["type"] == "memory/delete"]) == 1
    checks.append("A refreshed list invalidates the old confirmation target")
    memory.hide()
    assert memory._delete_target is None and window.isVisible()
    window.chat_dialog.hide()
    transient = QDialog()
    keeper.append(transient)
    transient.show()
    transient.close()
    queues[0].put({"type": "ping", "id": 72})
    QTimer.singleShot(120, guard(finish))

def finish():
    assert not quitting and windows[0].isVisible()
    assert any(m["type"] == "pong" and m["id"] == 72 for m in messages)
    checks.append("Closing child/primary helper windows cannot end the pet event loop")
    queues[0].put({"type": "shutdown", "id": 73})

with patch.object(bridge, "PetWindow", ProbePet), patch.object(bridge, "read_messages", feed), patch.object(bridge, "send", send):
    code = bridge.main()
assert code == 0 and not failures, failures
assert len(checks) == 6, "event loop exited before the regression steps finished"
assert any(m["type"] == "bye" and m["id"] == 73 for m in messages)
assert len(quitting) == 1
checks.append("Explicit Host shutdown still exits normally")
print(json.dumps({"ok": True, "checks": checks}))
