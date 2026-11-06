"""Exercise the production message queue and Qt activity/result rendering."""
import os
import pathlib
import sys
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "python"))
import deskpet_bridge as bridge
from pet_windows import STATUS_DURATION, STATE_LABELS

responses = []
diagnostics = []
failures = []
observed = []
windows = []
original = bridge.PetWindow.set_agent_state
deadline = None


def inspect_state(window, state, result=None):
    global deadline
    original(window, state, result)
    step = len(observed) + 1
    observed.append((window._activity_state, window._state, window._bubble_text))
    windows[:] = [window]
    if step == 1:
        assert window._state == "thinking" and window._bubble_hide_at is None
    elif step == 2:
        assert window._state == "idle" and window._bubble_hide_at is not None
    elif step == 3:
        assert window._state == "thinking", "another agent may still be running"
        assert window._bubble_text_now() == "任务完成", "result must not acquire thinking dots"
        assert window._bubble_state == "done"
        deadline = window._result_until
        window._advance(1.0)
    elif step in (4, 5):
        assert window._activity_state == "idle"
        assert window._state == "done" and window._bubble_text == "任务完成"
        assert window._result_until == deadline, "idle/duplicates cannot extend the deadline"
    elif step == 6:
        assert window._agent_result is None and window._result_until is None
        window._advance(STATUS_DURATION + 0.1)
        assert window._state == "thinking", "old result expiry cannot overwrite a new run"
        assert window._bubble_text == STATE_LABELS["thinking"]
    elif step == 7:
        assert window._state == "error" and window._bubble_state == "error"
        window._advance(STATUS_DURATION + 0.1)
        assert window._activity_state == window._state == "idle"
        assert window._bubble_text == STATE_LABELS["idle"]
    elif step == 8:
        assert window._state == "idle" and window._agent_result is None, "expired result must not replay"
    elif step == 9:
        assert window._state == "aborted" and window._bubble_text == "任务已中止"
    elif step == 10:
        assert window._state == "ended" and window._bubble_state == "ended"
    elif step == 11:
        window._advance(STATUS_DURATION + 0.1)
        assert window._state == "thinking" and window._bubble_state == "thinking"
        assert window._bubble_hide_at is None, "busy bubble returns when a concurrent result expires"


def record(window, state, result=None):
    # Qt reports callback exceptions without propagating them out of app.exec().
    # Collect assertions explicitly so a failure always makes this script fail.
    try:
        inspect_state(window, state, result)
    except Exception as error:
        failures.append(f"transition {len(observed)}: {error!r}")


def feed(inbox, stop):
    for state, result in [
        ("thinking", None), ("idle", None),
        ("thinking", {"id": 1, "state": "done"}),
        ("idle", {"id": 1, "state": "done"}),
        ("idle", {"id": 1, "state": "done"}),
        ("thinking", None),
        ("idle", {"id": 2, "state": "error"}),
        ("idle", {"id": 2, "state": "error"}),
        ("idle", {"id": 3, "state": "aborted"}),
        ("idle", {"id": 4, "state": "ended"}),
        ("thinking", {"id": 5, "state": "done"}),
    ]:
        inbox.put({"type": "pet.state", "state": state, "result": result})
    for bad in [{"id": True, "state": "done"}, {"id": 6, "state": []}, "error"]:
        inbox.put({"type": "pet.state", "state": "idle", "result": bad})
    inbox.put({"type": "pet.state", "state": ["idle"]})
    inbox.put({"type": "pet.state", "state": "done"})  # legacy protocol
    inbox.put({"type": "ping", "id": 1})
    inbox.put({"type": "shutdown", "id": 2})


with patch.object(bridge, "read_messages", feed), \
     patch.object(bridge, "send", responses.append), \
     patch.object(bridge, "log", diagnostics.append), \
     patch.object(bridge.PetWindow, "set_agent_state", record):
    assert bridge.main() == 0

assert not failures, failures
assert len(observed) == 11
assert len(diagnostics) == 4, diagnostics
assert windows[0]._state == "done", "legacy pet.state must remain supported"
assert windows[0]._agent_result is None
assert any(message["type"] == "pong" and message["id"] == 1 for message in responses)
assert any(message["type"] == "bye" and message["id"] == 2 for message in responses)

# Optional contact sheet for visual inspection, without affecting assertions.
shot = os.environ.get("STATUS_SMOKE_SHOT")
if shot:
    from PySide6.QtGui import QImage, QPainter, QColor, QFontDatabase
    # Qt's offscreen backend may not discover Windows fallback fonts.
    font = pathlib.Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"
    if font.exists():
        assert QFontDatabase.addApplicationFont(str(font)) >= 0
    sheet = QImage(260 * 5, 336, QImage.Format.Format_ARGB32)
    sheet.fill(QColor("#eff2f5"))
    painter = QPainter(sheet)
    for index, (state, result) in enumerate([
        ("thinking", {"id": 6, "state": "done"}),
        ("idle", {"id": 7, "state": "done"}),
        ("idle", {"id": 8, "state": "error"}),
        ("idle", {"id": 9, "state": "aborted"}),
        ("idle", None),
    ]):
        window = windows[0]
        window.set_agent_state(state, result)
        window._advance(0.2)
        painter.drawPixmap(index * 260, 0, window.grab())
    painter.end()
    assert sheet.save(shot)
windows[0].close()
print("agent/status UI smoke: passed (11 transitions, deadlines, concurrency, legacy, malformed input, ping/shutdown)")
