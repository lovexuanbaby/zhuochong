# 自改进 · 第 3 轮报告（P2.5 计时增强）

- 日期：2026-11-14
- 沙盒分支：`selfimprove`（`bb19235`）
- 评测：`node selfimprove/evaluate.mjs`（29 个场景：记忆 14 + 计时 15）

## 结论

**建议采纳。** 计时功能从“能用”到“好用”：评测 **86.96（25/29）→ 100（29/29）**，Python UI 冒烟 **39/39**，全部回归通过。

## 分数对比

| 指标 | 基线 `cc84667`（第 2 轮） | 候选 `bb19235` |
|---|---|---|
| 场景通过 | 25/29 | **29/29** |
| 加权 score | 86.96 | **100** |
| 新增失败项 | ① 自然说法不支持 ② 无实时倒计时推送 ③ 无提示音开关 ④ 到点后不推空列表 | 无 |

## 新增能力

1. **自然说法**：`半小时后提醒我 喝水`、`一刻钟后提醒我 站起来`、`计时 一小时` 都能识别（内部归一化成数字+单位再解析）。
2. **标题栏实时倒计时**：有计时进行中时，对话窗标题显示 `⏳ 1 个计时 · 4分59秒`，每秒刷新；计时结束/取消后恢复原来的模型提示。
3. **到点提示音**：计时触发时播放系统提示音；配置 `chatTimerSound`（默认开）可关闭。
4. **状态推送**：创建/取消/到点都会推送 `chat/timer` 的 `changed` 事件，Python 用同一份数据渲染标题栏。

## 改动文件

| 文件 | 变化 |
|---|---|
| `index.js` | +76：自然说法归一化、`changed` 推送、提示音标记、tick 改造 |
| `config.js` | +1：`chatTimerSound` 配置 |
| `python/deskpet_bridge.py` | +3：`changed` 分支、sound 参数转发 |
| `python/pet_windows.py` | +46：标题栏倒计时（`set_timers`/`_update_hint`）、提示音 `QApplication.beep()` |
| `tests/chat-ui-smoke.py` | +6：倒计时显示与恢复检查 |
| `selfimprove/scenarios/timer.mjs` | +4 个场景（自然说法/changed 协议/到点清空/提示音） |

## 验证

| 检查 | 结果 |
|---|---|
| `selfimprove/evaluate.mjs` | **100 分（29/29）** |
| `tests/chat-ui-smoke.py`（离屏 Qt） | **39/39** |
| `tests/config-smoke.mjs`（含新增配置字段） | 通过 |
| `tests/agent-status-smoke.mjs` | 通过 |
| `tests/chat-host-smoke.mjs` | 通过 |
| `tests/native-host-schema.mjs`（Electron） | 通过 |
| `node --check` / `py_compile` | 通过 |

## 风险与限制

- 有计时进行中时，Host 每秒向 Python 推送一条 `changed`（本地 IPC，开销小，但日志会略多）；
- 提示音用 `QApplication.beep()`，实际音量取决于 Windows 系统提示音设置；
- 自然说法只覆盖 半小时/一刻钟/一小时，其他口语（如“两分钟后”）暂不支持；
- 标题栏倒计时按 1 秒粒度显示，长于 1 小时显示“X小时Y分”。

## 审批与部署

批准后：

```powershell
git -C .\zhuochong merge selfimprove
# 然后在 DSH 插件管理里停用/启用 dsh-deskpet
```

## 下一轮候选

- **P3 对话风格**：陪伴感、少套话、口语化；可先加“风格评测场景”（mock 检查提示词/命令路由），再用真实模型抽检。
- 或 P2.6：重复提醒（每 30 分钟提醒一次）、到点声音可选更多提示音。
