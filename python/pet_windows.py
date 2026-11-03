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
from PySide6.QtWidgets import QApplication, QMenu, QWidget

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

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        if not self._placed:
            self._placed = True
            self._place_default()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
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
        self._drag_offset = None

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
