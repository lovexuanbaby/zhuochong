import json
import sys


def send_message(message: dict) -> None:
    """向 JS 发送一行 JSON。"""
    text = json.dumps(message, ensure_ascii=False)
    print(text, flush=True)


def log(message: str) -> None:
    """调试日志写到 stderr，不能写到 stdout。"""
    print(message, file=sys.stderr, flush=True)


def handle_message(message: dict) -> bool:
    """
    处理一条来自 JS 的消息。
    返回 False 时，主循环结束。
    """
    message_type = message.get("type")

    if message_type == "ping":
        send_message({
            "type": "pong",
        })
        return True

    if message_type == "shutdown":
        send_message({
            "type": "shutdown.ack",
        })
        return False

    send_message({
        "type": "error",
        "message": f"未知消息类型：{message_type}",
    })
    return True


def main() -> None:
    log("Python bridge started")

    # 告诉 JS：Python 已经启动完成
    send_message({
        "type": "ready",
    })

    # 每次读取一行；每行应该是一个 JSON 对象
    for line in sys.stdin:
        line = line.strip()

        # 空行直接跳过
        if not line:
            continue

        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            send_message({
                "type": "error",
                "message": f"JSON 格式错误：{error.msg}",
            })
            continue

        if not isinstance(message, dict):
            send_message({
                "type": "error",
                "message": "消息必须是 JSON 对象",
            })
            continue

        should_continue = handle_message(message)

        if not should_continue:
            break

    log("Python bridge stopped")


if __name__ == "__main__":
    main()