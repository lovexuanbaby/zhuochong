# 下一阶段开发准备：状态整合与真实宿主验收

日期：2026-11-06。状态：代码整合与自动回归已完成，真实 DSH 重载验收待执行。来源为 Codex「你好」工作流、当前代码和本轮执行结果。

## 本阶段目标

在保留 `agent/status` 的 running → idle 转换和并发汇总能力的基础上，恢复已在旧版本验收过的成功、中止等任务结果反馈，完成本轮改动的真实 DSH 验证。

本轮已补回 `session/event` 结果监听，并与忙闲活动状态分离。自动验证已覆盖成功、失败、中止、未知原因；真实 DSH 验收仍单独保留。

## 实现任务

### A. 分开处理活动与结果

已实施设计：

- `agent/status` 决定活动状态。任意 agent 仍运行时保持 thinking；全部结束后进入 idle。
- `session/event` 的 `turn/end` 决定结果：completed、error、aborted、未知原因分别对应 done、error、aborted、ended；idle 本身不推断结果。
- 结果提示与活动状态分别保存：空闲时短暂播放结果动画和提示，3.8 秒后恢复待命；仍运行时保持 thinking 表情，同时可显示某项任务的结果。时长由 `STATUS_DURATION` 集中定义。
- 并发时已结束任务的结果不能把其他任务变成空闲；最近收到的有效结果替换上一条提示。按 session 对象身份/turn 关联结果，丢弃旧轮次和已替换 agent 的事件。
- 已读取本机运行时代码确认：turn/end 在轮次 finally 中产生，driver 结束时才发 idle，同一个 running 区间可含多个轮次。已覆盖同区间新 turn/start 清除旧结果，亦容忍配对 end 晚于 idle 的情况。
- `pet.state` 增加可选 `result: { id, state }`，相同 id 不续期或复播。Qt 复用现有动画计时推进结果期限，新的运行/轮次清掉旧期限；保留旧终态消息与聊天协议。

已修改 `index.js`、`python/deskpet_bridge.py`、`python/pet_windows.py` 及状态/桥接测试；模型路由、历史/记忆文件格式和凭据归属保持原有实现。

### B. 自动验收

- [x] running → idle 保持通过，idle 不被当作成功。
- [x] completed/error/aborted/未知结果能显示，idle 不立即擦除结果提示。
- [x] 下一轮立即恢复 thinking；过期提示计时器不会覆盖新任务。
- [x] A 结束时 B 仍运行，保持 thinking；B 也结束后才 idle。
- [x] 一个 running 区间中多次 turn/end 不造成错误的空闲切换。
- [x] 旧实例/旧轮次不会覆盖新实例/新轮次。
- [x] 启动快照、握手前事件、重复事件、运行中释放和插件卸载仍通过。
- [x] Host 聊天 20/20、Qt 聊天 23/23、真实 Python 桥接 6/6 回归通过；Qt 状态测试覆盖 11 次转换。

现有命令（从项目根目录执行；使用已安装 PySide6 的 Python）：

```powershell
node tests/agent-status-smoke.mjs
node tests/chat-host-smoke.mjs
$env:QT_QPA_PLATFORM = 'offscreen'
& '<python.exe>' tests/agent-status-ui-smoke.py
& '<python.exe>' tests/chat-ui-smoke.py
node tests/bridge-smoke.mjs '<python.exe>'
git diff --check
```

每条命令应分别检查退出码。实机检查使用正常桌面环境，不能带着 offscreen 设置启动待观察的桌宠。

### C. 真实 DSH 验收

经宿主插件管理入口重载已链接的 `dsh-deskpet`；不要通过手工改写 profile 依赖来替代插件管理。当前会话没有可调用的 DSH 插件管理工具，执行时需先确认可用入口，或由用户在 DSH 界面重载。

| 场景 | 应观察到 | 当前结果 |
|---|---|---|
| 空闲启用 | 单个桌宠，握手成功，进入 idle | 待本轮实测 |
| 普通任务 | running 时 thinking；完成结果可见；idle 后回到待命 | 代码整合完成，待实测 |
| 用户中止 | 中止结果可见，最终 idle，下一轮可运行 | 待实测 |
| 可控失败 | 显示失败，不把 idle 写成成功；后续任务可恢复 | 旧工作流也未完成此项 |
| 连续输入 | 同一运行区间不中途错误待机 | 待实测 |
| 两个并发 agent | 一个结束时仍 thinking，全部结束才 idle | 待实测 |
| 运行中重载 | 读取当前 agent 快照，立即恢复正确状态 | 待实测 |
| 运行中停用再启用 | 无残留 Python 进程、重复监听或多窗口 | 待本轮实测 |
| 桌宠聊天和重启 | 连续聊天、失败恢复、历史恢复、记忆计数正常 | 待本轮实测 |

记录测试时间、运行时版本、场景、观察结果与必要日志。模拟事件测试、离屏测试和历史用户反馈分别记录，不互相替代。

## 完成标准与后续

本阶段完成需满足：自动检查全过、上表实机结果有记录、旧结果提示与新忙闲语义都正确、README/工作流一致。提交前检查用户已有的 Python 路径变更；用户决定提交、合并与推送。

之后建议做记忆查看/删除：复用已有 facts 结构和原子保存方法；先明确历史保留与再次提炼规则，再设计协议和界面。Config 设置、Python 依赖交付和干净环境验证安排到发布准备。计时/提醒不在本阶段实施。
