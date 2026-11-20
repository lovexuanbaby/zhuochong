"""Inline controls for local pet conversations and Host-owned DSH sessions."""
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QComboBox, QLabel, QPushButton

class ConversationPanel(QWidget):
    def __init__(self, chat):
        super().__init__(chat)
        self._chat = chat
        self._sequence = 0
        self._pending = None
        self._pending_action = None
        self._revision = None
        self._target = None
        self._timeout = QTimer(self)
        self._timeout.setSingleShot(True)
        self._timeout.timeout.connect(lambda: self.set_error({"id": self._pending, "message": "请求超时，请刷新确认结果，勿重复新建。"}))
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(5)
        row = QHBoxLayout()
        self._mode = QComboBox(self)
        self._mode.addItem("桌宠对话", "pet")
        self._mode.addItem("DSH 任务", "dsh")
        self._workspace = QComboBox(self)
        self._workspace.hide()
        self._refresh = QPushButton("刷新", self)
        self._refresh.clicked.connect(self.refresh)
        row.addWidget(self._mode)
        row.addWidget(self._workspace, 1)
        row.addWidget(self._refresh)
        self._sessions = QComboBox(self)
        for combo in (self._mode, self._workspace, self._sessions):
            combo.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
            combo.setMinimumContentsLength(10)
            combo.setStyleSheet(
                "QComboBox {background:#0b1b21;color:#dff7f2;padding:4px;font:9pt 'Microsoft YaHei UI';}"
                "QComboBox QAbstractItemView {background:#10262d;color:#dff7f2;"
                "selection-background-color:#176a68;selection-color:#ffffff;outline:0;}"
                "QComboBox QAbstractItemView::item {color:#dff7f2;padding:4px;}"
                "QComboBox QAbstractItemView::item:selected {background:#176a68;color:#ffffff;}"
            )
        self._note = QLabel("", self)
        self._note.setWordWrap(True)
        self._note.setTextFormat(Qt.TextFormat.PlainText)
        self._note.setStyleSheet("color:#7fa9b5;font:8.5pt 'Microsoft YaHei UI';")
        self._new = QPushButton("新建", self)
        self._select = QPushButton("切换", self)
        self._clear = QPushButton("清空选中", self)
        self._delete = QPushButton("删除选中", self)
        self._all = QPushButton("清空全部桌宠历史", self)
        self._new.clicked.connect(lambda: self.request("new"))
        self._select.clicked.connect(lambda: self.request("select"))
        self._clear.clicked.connect(lambda: self.confirm("clear"))
        self._delete.clicked.connect(lambda: self.confirm("archive" if self.mode == "dsh" else "delete"))
        self._all.clicked.connect(lambda: self.confirm("clear-all"))
        actions = QHBoxLayout()
        for button in (self._new, self._select, self._clear, self._delete): actions.addWidget(button)
        self._confirmation = QWidget(self)
        confirm_layout = QVBoxLayout(self._confirmation)
        confirm_layout.setContentsMargins(0, 0, 0, 0)
        self._confirm_text = QLabel(self._confirmation)
        self._confirm_text.setWordWrap(True)
        self._confirm_text.setTextFormat(Qt.TextFormat.PlainText)
        self._confirm_text.setStyleSheet("color:#dff7f2;font:9pt 'Microsoft YaHei UI';")
        self._yes = QPushButton("确认", self._confirmation)
        self._no = QPushButton("取消", self._confirmation)
        self._yes.clicked.connect(self.accept_confirmation)
        self._no.clicked.connect(self.cancel_confirmation)
        confirm_buttons = QHBoxLayout()
        confirm_buttons.addWidget(self._yes); confirm_buttons.addWidget(self._no)
        confirm_layout.addWidget(self._confirm_text); confirm_layout.addLayout(confirm_buttons)
        self._confirmation.hide()
        for button in (self._refresh, self._new, self._select, self._clear, self._delete, self._all, self._yes, self._no):
            button.setAutoDefault(False); button.setDefault(False)
            button.setStyleSheet("QPushButton {color:#dff7f2;background:#17433f;border:1px solid #2f8073;border-radius:6px;padding:5px;font:8.5pt 'Microsoft YaHei UI';} QPushButton:disabled {color:#668581;}")
        outer.addLayout(row); outer.addWidget(self._sessions); outer.addLayout(actions)
        outer.addWidget(self._all); outer.addWidget(self._note); outer.addWidget(self._confirmation)
        self._mode.currentIndexChanged.connect(self.refresh)
        self._sessions.currentIndexChanged.connect(self.update_controls)
        self.refresh_note()
        self.update_controls()

    @property
    def mode(self):
        return self._mode.currentData()

    def refresh_note(self):
        dsh = self.mode == "dsh"
        self._workspace.setVisible(dsh)
        self._clear.setVisible(not dsh); self._all.setVisible(not dsh)
        self._delete.setText("归档选中" if dsh else "删除选中")
        self._note.setText("真实 DSH 任务；审批请到 DSH。归档只隐藏，不删除原始历史。" if dsh else "桌宠独立对话。新建保留旧对话；清空不删除长期记忆、事件、日报或 DSH 记录。")

    def update_controls(self):
        ready = self._pending is None and self._target is None
        editable = ready and not self._chat.pending
        selected = bool(self._sessions.currentData())
        self._mode.setEnabled(ready); self._sessions.setEnabled(ready); self._workspace.setEnabled(ready)
        self._refresh.setEnabled(ready)
        self._new.setEnabled(editable and (self.mode == "dsh" and bool(self._workspace.currentData()) or self.mode == "pet" and self._revision is not None))
        for button in (self._select, self._clear, self._delete): button.setEnabled(editable and selected)
        self._all.setEnabled(editable and self._revision is not None)

    def refresh(self, *_):
        if self._pending is not None: return
        self.cancel_confirmation()
        self.refresh_note()
        self.request("list")

    def request(self, action, captured=None):
        if self._pending is not None: return
        if action != "list" and self._chat.pending:
            self._note.setText("请等待当前发送或回复结束后再切换对话。")
            return
        values = captured or {"mode": self.mode, "action": action, "sessionId": self._sessions.currentData(), "revision": self._revision, "workspaceId": self._workspace.currentData()}
        self._sequence += 1
        self._pending = self._sequence
        self._pending_action = action
        self._chat.sync_input_state()
        self.update_controls()
        self._timeout.start(35000)
        self._note.setText("正在读取会话……" if action == "list" else "正在处理，请稍候……")
        callback = getattr(self._chat._owner, "on_conversations", None)
        try:
            if callback is None: raise RuntimeError("Host 会话管理未连接")
            callback({**values, "id": self._sequence})
        except Exception as error:
            self.set_error({"id": self._pending, "message": str(error)})

    def confirm(self, action):
        if self._pending is not None or self._chat.pending: return
        self._target = {"mode": self.mode, "action": action, "sessionId": self._sessions.currentData(), "revision": self._revision}
        text = "归档这个 DSH 会话？仅从列表隐藏，不删除原始历史。" if action == "archive" else ("清空全部桌宠对话？" if action == "clear-all" else f"{self._clear.text() if action == 'clear' else self._delete.text()}：{self._sessions.currentText()}？")
        if self.mode == "pet": text += "\n长期记忆、事件、日报和 DSH 数据会保留。"
        self._confirm_text.setText(text)
        self._confirmation.show()
        self.update_controls()

    def cancel_confirmation(self):
        self._target = None
        self._confirmation.hide()
        self.update_controls()

    def accept_confirmation(self):
        target = self._target
        if target is None: return
        self.cancel_confirmation()
        self.request(target["action"], target)

    def set_result(self, message):
        if self._pending is None or message.get("id") != self._pending: return
        mode = "dsh" if message.get("type") == "dsh/sessions" else "pet"
        if mode != self.mode: return
        self._pending = None
        self._pending_action = None
        self._timeout.stop()
        self._revision = message.get("revision")
        self._sessions.blockSignals(True)
        previous = self._sessions.currentData()
        self._sessions.clear()
        for item in message.get("sessions", []):
            if not isinstance(item, dict) or not isinstance(item.get("id"), str): continue
            label = str(item.get("title") or item["id"][:8])
            label += " · 运行中" if item.get("running") else " · 当前" if item.get("active") else ""
            self._sessions.addItem(label, item["id"])
        selected = message.get("currentId") if mode == "pet" else message.get("selectedId")
        index = self._sessions.findData(selected if message.get("replaceHistory") else previous or selected)
        if index >= 0: self._sessions.setCurrentIndex(index)
        self._sessions.blockSignals(False)
        workspace = self._workspace.currentData()
        self._workspace.clear()
        for item in message.get("workspaces", []):
            self._workspace.addItem(str(item.get("title") or item["id"]), item["id"])
            self._workspace.setItemData(self._workspace.count()-1, item.get("path", ""), Qt.ItemDataRole.ToolTipRole)
        index = self._workspace.findData(workspace)
        if index >= 0: self._workspace.setCurrentIndex(index)
        self.refresh_note()
        if message.get("replaceHistory"):
            if mode == "pet": self._chat.activate_pet_conversation(message.get("entries", []))
            else: self._chat.activate_dsh_conversation(message.get("view") or {"sessionId": None, "entries": [], "running": False})
        self.update_controls()
        self._chat.sync_input_state()

    def set_error(self, message):
        if self._pending is None or message.get("id") != self._pending: return
        self._timeout.stop(); self._pending = None; self._pending_action = None
        self._note.setText(str(message.get("message") or "会话操作失败，请刷新"))
        self.update_controls()
        self._chat.sync_input_state()

    def hideEvent(self, event):
        self.cancel_confirmation()
        super().hideEvent(event)
