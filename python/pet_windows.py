import sys

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QLabel, QVBoxLayout, QWidget


class PetWindow(QWidget):#self指代窗口，方便self.调用工具
    def __init__(self):
        super().__init__()

        self.setWindowTitle("我的桌宠")
        self.resize(240, 160)

        self.status_label = QLabel("桌宠已启动")#窗口上的文字
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        layout = QVBoxLayout(self)
        layout.addWidget(self.status_label)

    def set_status(self, text):
        self.status_label.setText(text)


if __name__ == "__main__":
    app = QApplication(sys.argv)

    window = PetWindow()
    window.show()

    sys.exit(app.exec())