"""桌宠窗口：一个无边框、半透明、置顶、可拖动的小机器人。

外观取自仓库的 icon.svg：青绿色机体 + 深色屏幕脸 + 天线小灯泡 + 数据线尾巴。
屏幕上的表情和动作由状态驱动：

    idle     轻微呼吸、随机眨眼、眼睛跟随鼠标
    thinking 抬头看上面、天线闪、气泡里跑动的省略号
    done     眯眼笑、原地蹦一下、四周冒小星星
    error    眼睛变 X、身体抖动、气泡变红
    aborted  眼睛半闭、身体下沉、气泡变灰
    ended    平静表情、气泡变浅蓝

对外接口保持稳定：``PetWindow.set_status(text, state=None)``，
``deskpet_bridge.py`` 直接调用即可，不需要知道任何绘制细节。
"""

from __future__ import annotations

import math
import random
import sys
from datetime import datetime

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontMetrics,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QRadialGradient,
)
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

# 画布尺寸：上方留给气泡，下方是机器人和它的线缆
CANVAS_W = 260
CANVAS_H = 336
BUBBLE_BOTTOM = 98.0

# 取色自 icon.svg
TEAL_HI = "#8ff0dd"
TEAL_MID = "#4fd3c0"
TEAL_LOW = "#2fb8a6"
TEAL_EDGE = "#1b8f82"
SCREEN_TOP = "#16282f"
SCREEN_LOW = "#0a1418"
EYE_GLOW = "#7cf5df"
BULB_FILL = "#ffcf5c"
BULB_EDGE = "#c89a20"

# 每种状态的气泡配色：边框、文字
BUBBLE_STYLES = {
    "idle": ("#7fb6c9", "#2b5566"),
    "thinking": ("#4fa8dd", "#1d4a68"),
    "done": ("#3fbf95", "#1d5c47"),
    "error": ("#e8726f", "#7a2a28"),
    "aborted": ("#a79fb8", "#4a4257"),
    "ended": ("#9aa7b4", "#3f4a55"),
}

# 这些状态的动画帧率高一些，其余状态降帧省电
ACTIVE_STATES = {"thinking", "done", "error", "aborted"}


def _lerp(a: float, b: float, k: float) -> float:
    return a + (b - a) * k


# ---------------------------------------------------------------- 对话框配色
CHAT_BG_TOP = "#132630"
CHAT_BG_BOTTOM = "#0b151a"
CHAT_BORDER = "#2fb8a6"
CHAT_TITLE = "#dff7f2"
CHAT_MUTED = "#7fa9b5"
CHAT_INPUT_BG = "#0b1b21"

UI_FONT = "Microsoft YaHei UI"

WELCOME_TEXT = (
    "嗨，我是你的桌宠，会记住我们聊过的话～"
    "直接跟我聊就行，用的是 DSH 里配置的模型，聊天记录只留在这个窗口。"
)


def _force_topmost(widget: QWidget) -> None:
    """Re-assert the native topmost flag once a window handle exists.

    Qt's ``WindowStaysOnTopHint`` does not always survive the layered-window
    creation on Windows, so set ``HWND_TOPMOST`` explicitly.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes

        hwnd_value = int(widget.winId())
        if hwnd_value == 0:  # offscreen/minimal 平台没有原生窗口
            return
        user32 = ctypes.windll.user32
        user32.SetWindowPos.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint,
        ]
        user32.SetWindowPos.restype = ctypes.c_int
        hwnd = ctypes.c_void_p(hwnd_value)
        hwnd_topmost = ctypes.c_void_p(0xFFFFFFFFFFFFFFFF)
        user32.SetWindowPos(
            hwnd,
            hwnd_topmost,
            0,
            0,
            0,
            0,
            0x0001 | 0x0002 | 0x0010,  # NOSIZE | NOMOVE | NOACTIVATE
        )
    except Exception:
        pass


class _DragBar(QWidget):
    """Title strip that moves a frameless window through the window manager."""

    def mousePressEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        if event.button() == Qt.MouseButton.LeftButton:
            handle = self.window().windowHandle()
            if handle is not None and handle.startSystemMove():
                event.accept()
                return
        super().mousePressEvent(event)


class ChatDialog(QDialog):
    """和桌宠的对话窗口：消息列表 + 输入行，收发都走 JSON 行协议。

    对外接口（由 ``deskpet_bridge`` 调用）：
    - ``submit()``：把输入框内容交给 ``PetWindow.on_chat_submit``；
    - ``accepted()``：DSH 已接收，切换到“思考中”；
    - ``finish(text, ok=True)``：显示回复或错误并恢复输入；
    - ``messages``：只读的历史记录，方便冒烟测试。
    """

    def __init__(self, owner: "PetWindow") -> None:
        super().__init__(None)
        self._owner = owner
        self._pending = False
        self._messages: list[tuple[str, str]] = []
        self._last_date: str | None = None
        self._memory_count = 0
        self._status_base = ""
        self._status_dots = 0
        self._status_timer = QTimer(self)
        self._status_timer.timeout.connect(self._tick_status)

        self.setWindowTitle("桌宠对话")
        self.setWindowFlags(
            Qt.WindowType.Tool
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setFixedSize(382, 470)
        self._build_ui()

    # ---------------------------------------------------------------- 构建界面
    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 12, 14, 14)
        outer.setSpacing(8)

        title_bar = _DragBar(self)
        title_layout = QHBoxLayout(title_bar)
        title_layout.setContentsMargins(2, 0, 0, 0)
        title_layout.setSpacing(8)
        dot = QLabel("●", title_bar)
        dot.setStyleSheet(f"color: {TEAL_MID}; font-size: 9pt;")
        title = QLabel("桌宠对话", title_bar)
        title.setStyleSheet(
            f"color: {CHAT_TITLE}; font: 600 12pt '{UI_FONT}';"
        )
        hint = QLabel("直接用 DSH 配置的模型回复", title_bar)
        hint.setStyleSheet(
            f"color: {CHAT_MUTED}; font: 9pt '{UI_FONT}';"
        )
        self._hint = hint
        close_btn = QPushButton("✕", title_bar)
        close_btn.setFixedSize(24, 24)
        close_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        # 标题栏的关闭键不能抢 Enter：否则在输入框按 Enter 会同时发送并关窗。
        close_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        close_btn.setAutoDefault(False)
        close_btn.setDefault(False)
        close_btn.setStyleSheet(
            "QPushButton { border: none; background: transparent;"
            f" color: {CHAT_MUTED}; font: 12pt '{UI_FONT}'; }}"
            f"QPushButton:hover {{ color: #ff9b96; }}"
        )
        close_btn.clicked.connect(self.hide)
        title_layout.addWidget(dot)
        title_layout.addWidget(title)
        title_layout.addStretch(1)
        title_layout.addWidget(hint)
        title_layout.addWidget(close_btn)
        outer.addWidget(title_bar)

        self._scroll = QScrollArea(self)
        self._scroll.setWidgetResizable(True)
        self._scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._scroll.setStyleSheet(
            "QScrollArea { background: transparent; border: none; }"
            "QScrollBar:vertical { width: 6px; background: transparent; }"
            "QScrollBar::handle:vertical { background: rgba(127,182,201,0.35);"
            " border-radius: 3px; min-height: 24px; }"
            "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }"
        )
        self._messages_host = QWidget()
        self._messages_host.setStyleSheet("background: transparent;")
        self._messages_layout = QVBoxLayout(self._messages_host)
        self._messages_layout.setContentsMargins(2, 4, 2, 4)
        self._messages_layout.setSpacing(8)
        self._messages_layout.addStretch(1)
        self._scroll.setWidget(self._messages_host)
        self._scroll.verticalScrollBar().rangeChanged.connect(self._follow_bottom)
        outer.addWidget(self._scroll, 1)

        self._status = QLabel("")
        self._status.setStyleSheet(
            f"color: {CHAT_MUTED}; font: 9pt '{UI_FONT}'; padding-left: 4px;"
        )
        self._status.hide()
        outer.addWidget(self._status)

        input_row = QHBoxLayout()
        input_row.setSpacing(8)
        self._input = QLineEdit(self)
        self._input.setPlaceholderText("说点什么…（Enter 发送，Esc 收起）")
        self._input.setFixedHeight(34)
        self._input.setStyleSheet(
            "QLineEdit {"
            f" background: {CHAT_INPUT_BG}; color: #e8fbf7;"
            " border: 1px solid rgba(79, 211, 192, 0.35); border-radius: 10px;"
            f" padding: 0 10px; font: 10pt '{UI_FONT}'; }}"
            "QLineEdit:focus { border: 1px solid rgba(79, 211, 192, 0.85); }"
            "QLineEdit:disabled { color: rgba(232, 251, 247, 0.45); }"
        )
        self._input.returnPressed.connect(self.submit)
        self._send_btn = QPushButton("发送", self)
        self._send_btn.setFixedSize(64, 34)
        self._send_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._send_btn.setStyleSheet(
            "QPushButton {"
            " background: rgba(79, 211, 192, 0.92); color: #06251f;"
            " border: none; border-radius: 10px;"
            f" font: 600 10pt '{UI_FONT}'; }}"
            "QPushButton:hover { background: #6fe6d4; }"
            "QPushButton:disabled { background: rgba(79, 211, 192, 0.30);"
            " color: rgba(6, 37, 31, 0.55); }"
        )
        self._send_btn.clicked.connect(self.submit)
        # Enter 由输入框自己处理，按钮不做 dialog 的默认按钮。
        self._send_btn.setAutoDefault(False)
        self._send_btn.setDefault(False)
        input_row.addWidget(self._input, 1)
        input_row.addWidget(self._send_btn)
        outer.addLayout(input_row)

        self._append_bubble(WELCOME_TEXT, "pet")

    # ---------------------------------------------------------------- 绘制
    def paintEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        painter = QPainter(self)
        painter.setRenderHints(QPainter.RenderHint.Antialiasing)
        body = QPainterPath()
        body.addRoundedRect(
            QRectF(self.rect()).adjusted(1.0, 1.0, -1.0, -1.0), 18.0, 18.0
        )
        gradient = QLinearGradient(0.0, 0.0, 0.0, float(self.height()))
        gradient.setColorAt(0.0, QColor(CHAT_BG_TOP))
        gradient.setColorAt(1.0, QColor(CHAT_BG_BOTTOM))
        painter.setPen(QPen(QColor(CHAT_BORDER), 2.0))
        painter.setBrush(gradient)
        painter.drawPath(body)
    # ---------------------------------------------------------------- 对外接口
    @property
    def messages(self) -> list[tuple[str, str]]:
        """已显示的消息 (kind, text)，供测试断言。"""
        return list(self._messages)

    @property
    def pending(self) -> bool:
        """是否正在等待 DSH 回复。"""
        return self._pending

    def focus_input(self) -> None:
        self._input.setFocus(Qt.FocusReason.OtherFocusReason)

    def accepted(self, base: str = "DSH 正在思考") -> None:
        """主机侧已接收消息。"""
        if self._pending:
            self._show_status(base or "DSH 正在思考")

    def finish(self, text: str, ok: bool = True) -> None:
        """显示最终回复或错误，并恢复输入。"""
        self._pending = False
        self._hide_status()
        self._append_bubble(
            text,
            "pet" if ok else "error",
            datetime.now().isoformat(),
        )
        self._input.setEnabled(True)
        self._send_btn.setEnabled(True)
        self._input.setFocus(Qt.FocusReason.OtherFocusReason)

    def append_notice(self, text: str, kind: str = "pet") -> None:
        """不改变等待状态地追加一条消息（例如主机事件提示）。"""
        self._append_bubble(text, kind)

    def set_history(self, entries: object) -> None:
        """用落盘历史重建消息列表（插件启动时由宿主调用一次）。"""
        self._clear_messages()
        valid: list[tuple[str, str, str | None]] = []
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                role = entry.get("role")
                text = entry.get("text")
                when = entry.get("time")
                if role not in ("user", "assistant"):
                    continue
                if not isinstance(text, str) or text.strip() == "":
                    continue
                valid.append(
                    (role, text, when if isinstance(when, str) and when else None)
                )
        if not valid:
            self._append_bubble(WELCOME_TEXT, "pet")
            QTimer.singleShot(0, self._scroll_to_bottom)
            return
        for role, text, when in valid:
            self._append_bubble(text, "user" if role == "user" else "pet", when)
        QTimer.singleShot(0, self._scroll_to_bottom)

    def set_memory_count(self, count: int) -> None:
        """更新标题栏提示：桌宠已经记住了多少件事。"""
        self._memory_count = max(0, count)
        if count > 0:
            self._hint.setText(f"模型回复 · 已记住 {count} 件事")
        else:
            self._hint.setText("直接用 DSH 配置的模型回复")

    def _clear_messages(self) -> None:
        while self._messages_layout.count() > 1:  # 保留末尾弹簧
            item = self._messages_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        self._messages.clear()
        self._last_date = None
        self._pending = False
        self._hide_status()
        self._input.setEnabled(True)
        self._send_btn.setEnabled(True)

    def submit(self) -> None:
        text = self._input.text().strip()
        if not text or self._pending:
            return
        self._pending = True
        self._input.clear()
        self._input.setEnabled(False)
        self._send_btn.setEnabled(False)
        self._append_bubble(text, "user", datetime.now().isoformat())
        self._show_status("等待 DSH 回复")

        submit = getattr(self._owner, "on_chat_submit", None)
        if submit is None:
            self.finish("还没有连接到 DSH（主机插件未接线）", ok=False)
            return
        try:
            submit(text)
        except Exception as error:  # noqa: BLE001 - 桥接失败必须回显给用户
            self.finish(f"发送失败：{error}", ok=False)

    # ---------------------------------------------------------------- 内部实现
    def _append_bubble(self, text: str, kind: str, when: str | None = None) -> None:
        text = (text or "").strip() or "（空消息）"
        date_label = self._date_divider_label(when)
        if date_label is not None:
            self._append_date_divider(date_label)
        bubble = QLabel(text)
        bubble.setWordWrap(True)
        bubble.setMaximumWidth(256)
        bubble.setSizePolicy(
            QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Minimum
        )
        bubble.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        colors = {
            "user": ("rgba(18, 63, 58, 0.96)", "#d9fff8", "rgba(79, 211, 192, 0.65)"),
            "pet": ("rgba(22, 48, 58, 0.96)", "#dbeef6", "rgba(127, 182, 201, 0.45)"),
            "error": ("rgba(58, 29, 32, 0.96)", "#ffd2cf", "rgba(232, 114, 111, 0.75)"),
        }
        background, foreground, border = colors.get(kind, colors["pet"])
        bubble.setStyleSheet(
            "QLabel {"
            f" background: {background}; color: {foreground};"
            f" border: 1px solid {border}; border-radius: 12px;"
            f" padding: 8px 11px; font: 10pt '{UI_FONT}'; }}"
        )
        row = QWidget(self._messages_host)
        row.setStyleSheet("background: transparent;")
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(0)
        if kind == "user":
            row_layout.addStretch(1)
            row_layout.addWidget(bubble)
        else:
            row_layout.addWidget(bubble)
            row_layout.addStretch(1)
        # 插到末尾弹簧之前
        self._messages_layout.insertWidget(self._messages_layout.count() - 1, row)
        self._messages.append((kind, text))
        QTimer.singleShot(0, self._scroll_to_bottom)

    def _date_divider_label(self, when: str | None) -> str | None:
        """跨天时返回日期分隔文案；同一天返回 None。"""
        if not isinstance(when, str) or when == "":
            return None
        try:
            stamp = datetime.fromisoformat(when.replace("Z", "+00:00"))
        except ValueError:
            return None
        local = stamp.astimezone()
        key = local.strftime("%Y-%m-%d")
        if key == self._last_date:
            return None
        self._last_date = key
        return local.strftime("%Y年%m月%d日")

    def _append_date_divider(self, label: str) -> None:
        divider = QLabel(label)
        divider.setAlignment(Qt.AlignmentFlag.AlignCenter)
        divider.setStyleSheet(
            f"color: {CHAT_MUTED}; font: 8.5pt '{UI_FONT}'; padding: 3px 0;"
        )
        wrapper = QWidget(self._messages_host)
        wrapper.setStyleSheet("background: transparent;")
        layout = QHBoxLayout(wrapper)
        layout.setContentsMargins(0, 4, 0, 2)
        layout.addWidget(divider, 1)
        self._messages_layout.insertWidget(self._messages_layout.count() - 1, wrapper)

    def _scroll_to_bottom(self) -> None:
        bar = self._scroll.verticalScrollBar()
        bar.setValue(bar.maximum())

    def _follow_bottom(self, _minimum: int, maximum: int) -> None:
        """内容长高后自动跟到底部，聊天窗口不需要手动滚。"""
        self._scroll.verticalScrollBar().setValue(maximum)

    def _show_status(self, base: str) -> None:
        self._status_base = base
        self._status_dots = 0
        self._status.setText(base + "…")
        self._status.show()
        self._status_timer.start(420)
        QTimer.singleShot(0, self._scroll_to_bottom)

    def _hide_status(self) -> None:
        self._status_timer.stop()
        self._status.hide()
        QTimer.singleShot(0, self._scroll_to_bottom)

    def _tick_status(self) -> None:
        self._status_dots = (self._status_dots + 1) % 3
        self._status.setText(self._status_base + "." * (self._status_dots + 1))

    def showEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        super().showEvent(event)
        _force_topmost(self)

    def keyPressEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        if event.key() == Qt.Key.Key_Escape:
            self.hide()
            event.accept()
            return
        super().keyPressEvent(event)

    def show_near(self, anchor: QWidget) -> None:
        """打开在桌宠旁边，并夹在可用屏幕范围内。"""
        screen = anchor.screen() or QApplication.primaryScreen()
        if screen is None:  # offscreen/minimal 平台没有屏幕信息
            self.move(0, 0)
            return
        area = screen.availableGeometry()
        x = anchor.x() - self.width() - 14
        if x < area.left() + 8:
            x = anchor.x() + anchor.width() + 14
        y = anchor.y() + anchor.height() - self.height()
        x = max(area.left() + 8, min(x, area.right() - self.width() - 8))
        y = max(area.top() + 8, min(y, area.bottom() - self.height() - 8))
        self.move(x, y)


class PetWindow(QWidget):
    def __init__(self) -> None:
        super().__init__()

        self.setWindowTitle("我的桌宠")
        self.setFixedSize(CANVAS_W, CANVAS_H)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool,  # 不在任务栏占一个位置
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setMouseTracking(True)

        # 动画时钟
        self._t = 0.0
        self._state = "idle"
        self._state_t = 0.0
        self._blink_until = -1.0
        self._next_blink = 2.4
        self._look = QPointF(0.0, 0.0)
        self._target_look = QPointF(0.0, 0.0)

        # 气泡
        self._bubble_text = ""
        self._bubble_alpha = 0.0
        self._bubble_target = 0.0
        self._bubble_hide_at = None

        # 拖动
        self._drag_offset = None
        self._placed = False
        # 单击判定（区分拖动和点脸打开对话框）
        self._press_global = None
        self._press_face = False

        # 对话窗口（惰性创建）与桥接层回调
        self._chat: ChatDialog | None = None
        self.on_chat_submit = None

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._on_tick)
        self._timer.setInterval(33)
        self._timer.start()

        self._build_menu()
        self.set_status("桌宠已启动 ✨", "idle")

    # ------------------------------------------------------------------ 对外接口
    def set_status(self, text: str, state: str | None = None) -> None:
        """由桥接层调用：更新气泡文字并切换表情动画。"""
        self._state = state if state in BUBBLE_STYLES else "idle"
        self._state_t = 0.0
        self._bubble_text = text or ""
        self._bubble_target = 1.0
        # 思考中的气泡一直挂着，其他状态几秒后自动收起来
        self._bubble_hide_at = None if self._state == "thinking" else self._t + 3.8
        self._apply_state_flags()
        self.update()

    def _apply_state_flags(self) -> None:
        self._timer.setInterval(33 if self._state in ACTIVE_STATES else 66)

    # ------------------------------------------------------------------ 对话窗口
    @property
    def chat_dialog(self) -> "ChatDialog | None":
        """当前对话窗口；尚未打开过时为 None。"""
        return self._chat

    def _ensure_chat(self) -> "ChatDialog":
        if self._chat is None:
            self._chat = ChatDialog(self)
        return self._chat

    def open_chat(self) -> "ChatDialog":
        """打开（或重新聚焦）对话窗口，放在桌宠旁边。"""
        dialog = self._ensure_chat()
        dialog.show_near(self)
        dialog.show()
        dialog.raise_()
        dialog.activateWindow()
        dialog.focus_input()
        return dialog

    def chat_status(self, text: str) -> None:
        """主机侧已接收消息，切换为等待/思考提示。"""
        if self._chat is not None:
            self._chat.accepted(text)

    def set_chat_history(self, entries: object) -> None:
        """用落盘历史重建对话框内容（插件启动时调用）。"""
        self._ensure_chat().set_history(entries)

    def set_memory_count(self, count: object) -> None:
        """更新“已记住 N 件事”提示，让用户看到桌宠在变懂自己。"""
        try:
            value = int(count)
        except (TypeError, ValueError):
            value = 0
        self._ensure_chat().set_memory_count(value)

    def chat_reply(self, text: str, ok: bool = True) -> None:
        """显示模型回复（或错误）。"""
        self._ensure_chat().finish(text, ok=ok)

    def chat_error(self, text: str) -> None:
        """显示发送/会话失败的原因。"""
        self._ensure_chat().finish(text, ok=False)

    def _face_rect(self) -> QRectF:
        """屏幕脸在画布内的命中区域（用于点击打开对话框）。"""
        return QRectF(CANVAS_W / 2.0 - 52.0, 156.0 + 26.0, 104.0, 72.0)

    # ------------------------------------------------------------------ 动画主循环
    def _on_tick(self) -> None:
        self._advance(0.033 if self._timer.interval() == 33 else 0.066)

    def _advance(self, dt: float) -> None:
        self._t += dt
        self._state_t += dt

        # 气泡淡入淡出
        if self._bubble_hide_at is not None and self._t >= self._bubble_hide_at:
            self._bubble_target = 0.0
            self._bubble_hide_at = None
        self._bubble_alpha = _lerp(
            self._bubble_alpha,
            self._bubble_target,
            min(1.0, dt * 8.0),
        )

        # 随机眨眼（思考/出错时不眨，专心一点）
        if self._state not in {"thinking", "error"} and self._t >= self._next_blink:
            self._blink_until = self._t + 0.13
            self._next_blink = self._t + random.uniform(2.4, 5.6)

        # 眼睛缓动跟随
        self._look = QPointF(
            _lerp(self._look.x(), self._target_look.x(), min(1.0, dt * 10.0)),
            _lerp(self._look.y(), self._target_look.y(), min(1.0, dt * 10.0)),
        )

        self.update()

    # ------------------------------------------------------------------ 绘制
    def paintEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        painter = QPainter(self)
        painter.setRenderHints(
            QPainter.RenderHint.Antialiasing | QPainter.RenderHint.TextAntialiasing
        )
        self._draw_bubble(painter)
        self._draw_robot(painter)

    # ---------------------------------------------------------------- 机位与动作
    def _motion(self) -> tuple[float, float, float, float]:
        """返回 (横向偏移, 纵向偏移, 整体倾斜角度, 机体缩放)。"""
        t, st, state = self._t, self._state_t, self._state
        dx = dy = 0.0
        angle = 0.0
        scale = 1.0

        # 日常呼吸
        dy += math.sin(t * 1.7) * 2.2

        if state == "thinking":
            dy += math.sin(t * 4.4) * 2.6
            angle = math.sin(t * 2.2) * 2.0
        elif state == "done":
            # 蹦一下：先缩后跳，落地再压一下
            if st < 1.5:
                hop = math.sin(min(st / 1.5, 1.0) * math.pi)
                dy -= hop * 15.0
                scale = 1.0 + hop * 0.03
                angle = math.sin(st * 12.0) * 3.0 * (1.0 - st / 1.5)
        elif state == "error":
            if st < 0.9:
                dx += math.sin(st * 52.0) * 5.0 * (1.0 - st / 0.9)
        elif state == "aborted":
            dy += 4.0 + math.sin(t * 1.2) * 1.2
        elif state == "ended":
            dy += 2.0

        return dx, dy, angle, scale

    # ---------------------------------------------------------------- 机器人
    def _draw_robot(self, painter: QPainter) -> None:
        dx, dy, angle, scale = self._motion()
        cx = CANVAS_W / 2.0
        base_y = 156.0  # 机体顶部基准线

        # 柔和光晕：让机体从任意壁纸上浮起来
        halo = QRadialGradient(QPointF(cx, base_y + 66.0), 132.0)
        halo.setColorAt(0.0, QColor(120, 240, 224, 46))
        halo.setColorAt(0.72, QColor(120, 240, 224, 16))
        halo.setColorAt(1.0, QColor(120, 240, 224, 0))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(halo)
        painter.drawEllipse(QPointF(cx, base_y + 66.0), 132.0, 120.0)

        # 地面阴影：跳得越高越淡越小
        lift = max(0.0, -dy - 1.0)
        shadow_w = 118.0 - lift * 1.4
        shadow_alpha = int(max(18, 58 - lift * 1.6))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(16, 52, 60, shadow_alpha))
        painter.drawEllipse(
            QRectF(cx - shadow_w / 2.0, base_y + 132.0, shadow_w, 16.0)
        )

        painter.save()
        painter.translate(dx, dy)
        if angle:
            painter.translate(cx, base_y + 70.0)
            painter.rotate(angle)
            painter.translate(-cx, -(base_y + 70.0))

        self._draw_cable(painter, base_y)
        self._draw_body(painter, base_y, scale)
        self._draw_feet(painter, base_y)
        self._draw_antenna(painter, base_y)
        painter.restore()

        if self._state == "done":
            self._draw_sparkles(painter, cx, base_y + dy)
        if self._state == "error" and self._state_t < 1.6:
            self._draw_sweat(painter, cx, base_y + dy)

    def _draw_body(self, painter: QPainter, base_y: float, scale: float) -> None:
        cx = CANVAS_W / 2.0
        body_w, body_h = 152.0, 126.0
        body = QRectF(cx - body_w / 2.0, base_y, body_w, body_h)

        if scale != 1.0:
            painter.save()
            painter.translate(cx, base_y + body_h)
            painter.scale(scale, scale)
            painter.translate(-cx, -(base_y + body_h))

        # 机体
        grad = QLinearGradient(body.topLeft(), body.bottomLeft())
        grad.setColorAt(0.0, QColor(TEAL_HI))
        grad.setColorAt(0.55, QColor(TEAL_MID))
        grad.setColorAt(1.0, QColor(TEAL_LOW))
        path = QPainterPath()
        path.addRoundedRect(body, 38.0, 38.0)
        painter.setPen(QPen(QColor(TEAL_EDGE), 7.0))
        painter.setBrush(grad)
        painter.drawPath(path)

        # 顶部高光
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(255, 255, 255, 46))
        painter.drawEllipse(QRectF(body.left() + 26.0, body.top() + 14.0, 54.0, 20.0))

        # 底部内阴影，给机体一点厚度
        bottom_shade = QLinearGradient(
            QPointF(cx, body.bottom() - 46.0), QPointF(cx, body.bottom())
        )
        bottom_shade.setColorAt(0.0, QColor(12, 96, 88, 0))
        bottom_shade.setColorAt(1.0, QColor(12, 76, 70, 62))
        shade_path = QPainterPath()
        shade_path.addRoundedRect(body.adjusted(5.0, 5.0, -5.0, -5.0), 33.0, 33.0)
        painter.setBrush(bottom_shade)
        painter.drawPath(shade_path)

        # 屏幕
        screen = QRectF(cx - 52.0, base_y + 26.0, 104.0, 72.0)
        sgrad = QLinearGradient(screen.topLeft(), screen.bottomLeft())
        sgrad.setColorAt(0.0, QColor(SCREEN_TOP))
        sgrad.setColorAt(1.0, QColor(SCREEN_LOW))
        spath = QPainterPath()
        spath.addRoundedRect(screen, 22.0, 22.0)
        painter.setPen(QPen(QColor("#0a2a2f"), 4.0))
        painter.setBrush(sgrad)
        painter.drawPath(spath)

        self._draw_face(painter, screen)
        if scale != 1.0:
            painter.restore()

    def _draw_face(self, painter: QPainter, screen: QRectF) -> None:
        state, st = self._state, self._state_t
        cx = screen.center().x()
        eye_y = screen.top() + 34.0
        eye_dx = 19.0
        r = 9.0

        # 眼睛朝向：思考时看斜上方，出错时看下方，否则跟随鼠标
        if state == "thinking":
            look = QPointF(-1.5, -3.5)
        elif state in {"error", "aborted"}:
            look = QPointF(0.0, 2.5)
        elif state == "ended":
            look = QPointF(0.0, 1.5)
        else:
            look = self._look

        blinking = self._t < self._blink_until

        def eye(at_x: float) -> None:
            center = QPointF(at_x + look.x() * 1.6, eye_y + look.y() * 1.2)
            if blinking:
                # 眨眼：一条圆头短线
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QColor(EYE_GLOW))
                painter.drawRoundedRect(
                    QRectF(center.x() - r, center.y() - 1.9, r * 2.0, 3.8), 1.9, 1.9
                )
                return
            if state == "aborted":
                # 垂下的眼皮：向下的小弧
                painter.setPen(
                    QPen(QColor(EYE_GLOW).darker(112), 3.6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap)
                )
                painter.setBrush(Qt.BrushStyle.NoBrush)
                path = QPainterPath()
                path.moveTo(center.x() - r, center.y() - 2.0)
                path.quadTo(center.x(), center.y() + 6.0, center.x() + r, center.y() - 2.0)
                painter.drawPath(path)
                return
            if state == "ended":
                # 半闭眼：眼皮压住半个瞳孔
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QColor(EYE_GLOW))
                painter.drawEllipse(center, r, r)
                painter.setBrush(QColor(SCREEN_TOP))
                painter.drawRect(
                    QRectF(center.x() - r - 1.0, center.y() - r - 3.0, r * 2.0 + 2.0, r + 1.0)
                )
                return

            glow = QRadialGradient(center, r * 2.6)
            glow.setColorAt(0.0, QColor(124, 245, 223, 120))
            glow.setColorAt(1.0, QColor(124, 245, 223, 0))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(glow)
            painter.drawEllipse(center, r * 2.6, r * 2.6)
            painter.setBrush(QColor(EYE_GLOW))
            painter.drawEllipse(center, r, r)
            painter.setBrush(QColor(255, 255, 255, 210))
            painter.drawEllipse(
                QPointF(center.x() - r * 0.32, center.y() - r * 0.34), r * 0.30, r * 0.30
            )

        if state == "done":
            # 眯眼笑：两段小圆弧
            painter.setPen(QPen(QColor(EYE_GLOW), 4.0, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            for at_x in (cx - eye_dx, cx + eye_dx):
                path = QPainterPath()
                path.moveTo(at_x - 8.0, eye_y + 2.0)
                path.quadTo(at_x, eye_y - 8.0, at_x + 8.0, eye_y + 2.0)
                painter.drawPath(path)
        elif state == "error":
            painter.setPen(QPen(QColor("#ff8b86"), 4.2, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            for at_x in (cx - eye_dx, cx + eye_dx):
                painter.drawLine(QPointF(at_x - 7.0, eye_y - 7.0), QPointF(at_x + 7.0, eye_y + 7.0))
                painter.drawLine(QPointF(at_x + 7.0, eye_y - 7.0), QPointF(at_x - 7.0, eye_y + 7.0))
        else:
            eye(cx - eye_dx)
            eye(cx + eye_dx)

        # 嘴巴
        mouth_y = screen.top() + 60.0
        painter.setBrush(Qt.BrushStyle.NoBrush)
        if state == "done":
            painter.setPen(QPen(QColor(EYE_GLOW), 3.6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            path = QPainterPath()
            path.moveTo(cx - 12.0, mouth_y - 3.0)
            path.quadTo(cx, mouth_y + 9.0, cx + 12.0, mouth_y - 3.0)
            painter.drawPath(path)
        elif state == "thinking":
            painter.setPen(QPen(QColor(EYE_GLOW), 3.4, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            painter.drawEllipse(QPointF(cx, mouth_y + 1.0), 3.6, 4.2)
        elif state == "error":
            painter.setPen(QPen(QColor("#ff8b86"), 3.6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            path = QPainterPath()
            path.moveTo(cx - 11.0, mouth_y + 5.0)
            path.quadTo(cx, mouth_y - 6.0, cx + 11.0, mouth_y + 5.0)
            painter.drawPath(path)
        elif state in {"aborted", "ended"}:
            painter.setPen(QPen(QColor(EYE_GLOW).darker(115), 3.2, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            painter.drawLine(QPointF(cx - 9.0, mouth_y + 2.0), QPointF(cx + 9.0, mouth_y + 2.0))
        else:
            painter.setPen(QPen(QColor(EYE_GLOW), 3.4, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            path = QPainterPath()
            path.moveTo(cx - 10.0, mouth_y - 1.0)
            path.quadTo(cx, mouth_y + 7.0, cx + 10.0, mouth_y - 1.0)
            painter.drawPath(path)

        # 思考时屏幕右下角跑一个小光标，像在打字
        if state == "thinking":
            cursor_color = QColor(EYE_GLOW)
            cursor_color.setAlpha(190 if int(st * 3.4) % 2 == 0 else 60)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(cursor_color)
            painter.drawRoundedRect(
                QRectF(screen.right() - 20.0, screen.bottom() - 15.0, 8.0, 4.0), 2.0, 2.0
            )

    def _draw_antenna(self, painter: QPainter, base_y: float) -> None:
        cx = CANVAS_W / 2.0
        sway = math.sin(self._t * 1.9) * 2.6
        top = QPointF(cx - 26.0 + sway, base_y - 32.0)

        # 底座小圆环
        painter.setPen(QPen(QColor(TEAL_EDGE), 3.0))
        painter.setBrush(QColor("#2aa899"))
        painter.drawEllipse(QPointF(cx - 26.0, base_y + 4.0), 6.0, 4.0)

        painter.setPen(QPen(QColor(TEAL_EDGE), 6.0, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        painter.drawLine(QPointF(cx - 26.0, base_y + 2.0), top)

        # 思考时灯泡高频闪烁，其余时候慢呼吸
        if self._state == "thinking":
            pulse = 0.55 + 0.45 * abs(math.sin(self._state_t * 6.0))
        else:
            pulse = 0.45 + 0.25 * math.sin(self._t * 2.4 + 1.0)
        glow = QRadialGradient(top, 30.0)
        glow.setColorAt(0.0, QColor(255, 214, 110, int(140 * pulse)))
        glow.setColorAt(1.0, QColor(255, 214, 110, 0))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(glow)
        painter.drawEllipse(top, 30.0, 30.0)

        painter.setPen(QPen(QColor(BULB_EDGE), 3.0))
        painter.setBrush(QColor(BULB_FILL))
        painter.drawEllipse(top, 10.5, 10.5)
        painter.setBrush(QColor(255, 255, 255, int(160 * pulse)))
        painter.drawEllipse(QPointF(top.x() - 3.2, top.y() - 3.6), 3.4, 3.4)

    def _draw_feet(self, painter: QPainter, base_y: float) -> None:
        cx = CANVAS_W / 2.0
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor("#12232a"))
        for offset in (-34.0, 34.0):
            painter.drawRoundedRect(
                QRectF(cx + offset - 18.0, base_y + 112.0, 36.0, 16.0), 8.0, 8.0
            )
            painter.setBrush(QColor(255, 255, 255, 26))
            painter.drawRoundedRect(
                QRectF(cx + offset - 14.0, base_y + 115.0, 20.0, 5.0), 2.5, 2.5
            )
            painter.setBrush(QColor("#12232a"))

    def _draw_cable(self, painter: QPainter, base_y: float) -> None:
        cx = CANVAS_W / 2.0
        sway = math.sin(self._t * 2.1) * 4.0
        path = QPainterPath()
        start = QPointF(cx + 74.0, base_y + 84.0)
        path.moveTo(start)
        path.cubicTo(
            QPointF(cx + 104.0, base_y + 104.0 + sway),
            QPointF(cx + 96.0, base_y + 140.0 - sway),
            QPointF(cx + 112.0, base_y + 158.0),
        )
        painter.setPen(
            QPen(QColor(TEAL_EDGE), 6.0, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap)
        )
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawPath(path)

        plug = QRectF(cx + 104.0, base_y + 152.0, 22.0, 14.0)
        painter.setPen(QPen(QColor(TEAL_EDGE), 3.0))
        painter.setBrush(QColor("#14252d"))
        painter.drawRoundedRect(plug, 5.0, 5.0)

    # ---------------------------------------------------------------- 小特效
    def _draw_sparkles(self, painter: QPainter, cx: float, top: float) -> None:
        life = min(1.0, self._state_t / 1.2)
        alpha = int(230 * (1.0 - life))
        if alpha <= 0:
            return
        painter.setPen(Qt.PenStyle.NoPen)
        for i, (dx, dy, size) in enumerate(
            [(-110.0, 4.0, 10.0), (108.0, 24.0, 8.0), (-96.0, 66.0, 7.0), (100.0, 88.0, 6.0)]
        ):
            wobble = math.sin(self._state_t * 9.0 + i) * 5.0
            center = QPointF(cx + dx + wobble, top + dy)
            color = QColor(255, 226, 128, alpha) if i % 2 == 0 else QColor(146, 245, 226, alpha)
            painter.setBrush(color)
            # 四角星：四个尖 + 四个内凹点
            path = QPainterPath()
            path.moveTo(center.x(), center.y() - size)
            path.lineTo(center.x() + size * 0.26, center.y() - size * 0.26)
            path.lineTo(center.x() + size, center.y())
            path.lineTo(center.x() + size * 0.26, center.y() + size * 0.26)
            path.lineTo(center.x(), center.y() + size)
            path.lineTo(center.x() - size * 0.26, center.y() + size * 0.26)
            path.lineTo(center.x() - size, center.y())
            path.lineTo(center.x() - size * 0.26, center.y() - size * 0.26)
            path.closeSubpath()
            painter.drawPath(path)

    def _draw_sweat(self, painter: QPainter, cx: float, top: float) -> None:
        alpha = int(190 * max(0.0, 1.0 - self._state_t / 1.6))
        if alpha <= 0:
            return
        center = QPointF(cx + 96.0, top + 12.0 + self._state_t * 10.0)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(140, 210, 245, alpha))
        path = QPainterPath()
        path.moveTo(center.x(), center.y() - 12.0)
        path.cubicTo(
            center.x() + 8.0, center.y() - 2.0,
            center.x() + 6.0, center.y() + 7.0,
            center.x(), center.y() + 7.0,
        )
        path.cubicTo(
            center.x() - 6.0, center.y() + 7.0,
            center.x() - 8.0, center.y() - 2.0,
            center.x(), center.y() - 12.0,
        )
        painter.drawPath(path)

    # ---------------------------------------------------------------- 气泡
    def _bubble_text_now(self) -> str:
        text = self._bubble_text
        if self._state == "thinking":
            dots = "." * (1 + int(self._state_t * 2.2) % 3)
            text = text.rstrip(". ") + dots
        return text

    def _draw_bubble(self, painter: QPainter) -> None:
        alpha = max(0.0, min(1.0, self._bubble_alpha))
        if alpha <= 0.01:
            return

        text = self._bubble_text_now()
        font = QFont("Microsoft YaHei UI")
        font.setPointSize(10)
        font.setWeight(QFont.Weight.DemiBold)
        painter.setFont(font)

        metrics = QFontMetrics(font)
        max_text_w = CANVAS_W - 52
        text_rect = metrics.boundingRect(
            QRectF(0.0, 0.0, float(max_text_w), 220.0).toRect(),
            int(Qt.TextFlag.TextWordWrap | Qt.AlignmentFlag.AlignHCenter),
            text,
        )
        body_w = max(104.0, min(float(text_rect.width()) + 34.0, float(CANVAS_W - 16)))
        body_h = float(text_rect.height()) + 24.0
        body = QRectF((CANVAS_W - body_w) / 2.0, BUBBLE_BOTTOM - body_h, body_w, body_h)

        border, ink = BUBBLE_STYLES.get(self._state, BUBBLE_STYLES["idle"])

        path = QPainterPath()
        path.addRoundedRect(body, 16.0, 16.0)
        # 指向机器人的小尖角
        tail = QPainterPath()
        tail.moveTo(body.center().x() - 8.0, body.bottom() - 1.0)
        tail.lineTo(body.center().x() + 1.0, body.bottom() + 13.0)
        tail.lineTo(body.center().x() + 10.0, body.bottom() - 1.0)
        tail.closeSubpath()
        path = path.united(tail)

        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(14, 48, 56, int(26 * alpha)))
        painter.drawPath(path.translated(0.0, 3.0))

        painter.setBrush(QColor(255, 255, 255, int(243 * alpha)))
        painter.setPen(QPen(QColor(border), 2.0))
        painter.drawPath(path)

        painter.setPen(QColor(ink))
        painter.drawText(
            body.adjusted(12.0, 12.0, -12.0, -10.0),
            int(Qt.AlignmentFlag.AlignCenter | Qt.TextFlag.TextWordWrap),
            text,
        )

    # ---------------------------------------------------------------- 交互
    def _build_menu(self) -> None:
        self._menu = QMenu(self)
        self._act_top = self._menu.addAction("总在最前")
        self._act_top.setCheckable(True)
        self._act_top.setChecked(True)
        self._act_top.triggered.connect(self._toggle_on_top)
        self._menu.addAction("打开对话框", self.open_chat)
        self._menu.addAction("回到右下角", self._reset_position)
        self._menu.addAction("陪她玩一下", lambda: self.set_status("好开心！", "done"))

    def _toggle_on_top(self, checked: bool) -> None:
        flags = self.windowFlags()
        if checked:
            flags |= Qt.WindowType.WindowStaysOnTopHint
        else:
            flags &= ~Qt.WindowType.WindowStaysOnTopHint
        self.setWindowFlags(flags)
        self.show()

    def _reset_position(self) -> None:
        self._place_default()

    def _place_default(self) -> None:
        screen = self.screen() or QApplication.primaryScreen()
        area = screen.availableGeometry()
        x = area.right() - self.width() - 24
        y = area.bottom() - self.height() - 12
        self.move(x, y)

    def _ensure_topmost(self) -> None:
        """Re-assert the native topmost flag once the window handle exists."""
        _force_topmost(self)

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        if not self._placed:
            self._placed = True
            self._place_default()
        if self._act_top.isChecked():
            self._ensure_topmost()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_global = event.globalPosition().toPoint()
            self._press_face = self._face_rect().contains(event.position())
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
        elif event.button() == Qt.MouseButton.RightButton:
            self._menu.exec(event.globalPosition().toPoint())
            event.accept()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._drag_offset is not None:
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            event.accept()
            return
        pos = event.position()
        center = QPointF(CANVAS_W / 2.0, 150.0 + 70.0)
        delta = QPointF(
            max(-1.0, min(1.0, (pos.x() - center.x()) / 90.0)),
            max(-1.0, min(1.0, (pos.y() - center.y()) / 90.0)),
        )
        self._target_look = delta

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._press_face:
            # 没怎么移动的点脸 = 打开对话框；拖动不算点击
            moved = 0
            if self._press_global is not None:
                moved = (
                    event.globalPosition().toPoint() - self._press_global
                ).manhattanLength()
            if moved <= 3:
                self.open_chat()
        self._drag_offset = None
        self._press_global = None
        self._press_face = False

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._target_look = QPointF(0.0, 0.0)

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self.set_status("好开心！", "done")


if __name__ == "__main__":
    import sys

    app = QApplication(sys.argv)
    window = PetWindow()
    window.show()
    sys.exit(app.exec())
