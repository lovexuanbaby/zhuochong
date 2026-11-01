import { spawn } from "node:child_process";

console.log("Node 测试程序已启动");

const python = spawn(
  "python",
  [".\\python\\deskpet_bridge.py"],
  {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }
);

python.stdout.setEncoding("utf8");
python.stderr.setEncoding("utf8");

python.stdout.on("data", (data) => {
  console.log("收到 Python:", data.toString().trim());
});

python.stderr.on("data", (data) => {
  console.error("Python 日志:", data.toString().trim());
});

python.on("error", (error) => {
  console.error("启动 Python 失败:", error.message);
});

python.on("close", (code) => {
  console.log("Python 已退出，退出码:", code);
});

setTimeout(() => {
  console.log("发送 ping");
  python.stdin.write('{"type":"ping"}\n');
}, 1000);

setTimeout(() => {
  console.log("发送 shutdown");
  python.stdin.write('{"type":"shutdown"}\n');
}, 2000);