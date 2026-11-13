# 自改进 · 第 2 轮报告（P2 计时/提醒）

- 日期：2026-11-14
- 沙盒分支：`selfimprove`（`cd49e8c`）
- 评测：`node selfimprove/evaluate.mjs`（25 个场景：记忆 14 + 计时 11）

## 结论

**建议采纳。** 计时/提醒从“没有该功能”到完整可用：评测 **52.5（14/25）→ 100（25/25）**，Python UI 冒烟 **37/37**，全部回归通过。

## 分数对比

| 指标 | 基线 `2521239` | 候选 `cd49e8c` |
|---|---|---|
| 场景通过 | 14/25（记忆全过、计时全失败） | **25/25** |
| 加权 score | 52.5 | **100** |
| 失败项 | 11 个计时/提醒场景 | 无 |

## 新功能（桌面宠物现在会记时了）

在桌宠对话框里直接说：

| 说法 | 效果 |
|---|---|
| `计时 5 分钟` | 开始倒计时，到点提醒「计时结束：5 分钟」 |
| `10 分钟后提醒我 喝水` / `提醒我 10 分钟后 喝水` | 到点提醒「提醒：喝水」 |
| `查看计时` | 列出进行中的计时/提醒（剩余时间） |
| `取消计时 1` | 取消指定编号 |
| `取消所有计时` | 全部取消 |

配置项（插件设置/`cordis.patch.yml` 均可）：`chatTimerEnabled`（默认开）、`chatTimerMaxActive`（默认 20）、`chatTimerPath`（默认 `$DSH_HOME/deskpet/timers.json`）。

## 实现要点

- **命令直达，不走模型**：`计时/提醒/取消/查看` 开头的消息由 JS 解析处理，立即回复，不消耗 token；其他消息照旧走 DSH 模型。
- **持久化**：计时写入 `timers.json`（原子写、损坏隔离），插件重启后恢复。
- **过期补触发**：重启时已过期的计时会补触发一次，不会重复。
- **并发**：多个计时按到期时间独立触发；数量受 `chatTimerMaxActive` 限制。
- **到点提醒**：通过 `chat/timer` 协议通知 Python，桌宠气泡 + 对话框同时显示「⏰ …」。
- **1 秒 ticker**：插件启动时启动，停用时清理。

## 改动文件

| 文件 | 变化 |
|---|---|
| `index.js` | +282：计时引擎、命令解析、持久化、ticker、配置接入 |
| `config.js` | +3：3 个计时配置字段 |
| `python/deskpet_bridge.py` | +9：`chat/timer` 处理 |
| `python/pet_windows.py` | +7：`show_timer_reminder()` |
| `tests/chat-ui-smoke.py` | +4：计时提醒显示检查 |
| `selfimprove/scenarios/timer.mjs` | 新增 11 个计时场景 |
| `selfimprove/lib/harness.mjs`、`evaluate.mjs` | 假时钟 env、合并两组场景 |

## 验证

| 检查 | 结果 |
|---|---|
| `selfimprove/evaluate.mjs` | **100 分（25/25）** |
| `tests/chat-ui-smoke.py`（离屏 Qt） | **37/37** |
| `tests/config-smoke.mjs` | 通过 |
| `tests/agent-status-smoke.mjs` | 通过 |
| `tests/chat-host-smoke.mjs` | 通过 |
| `tests/native-host-schema.mjs`（Electron） | 通过 |
| `py_compile` / `node --check` | 通过 |

## 风险与限制

- 命令是中文正则匹配，只支持 `计时 X 分钟`、`X 分钟后提醒我 Y`、`查看计时`、`取消计时 N`、`取消所有计时` 这几种说法；
- 到点只在气泡/对话框提示，**没有实时倒计时数字和声音**；
- 以「计时/提醒/取消/查看」开头的消息会被当作命令、不发给模型（这是有意设计）；
- 过期只补触发一次，不会补发“已错过多久”的说明。

## 审批与部署

批准后：

```powershell
git -C .\zhuochong merge selfimprove
# 然后在 DSH 插件管理里停用/启用 dsh-deskpet
```

## 下一轮候选

- P2.5：计时增强（实时倒计时显示、到点声音、重复提醒、自然语言更宽泛）；
- P3：对话风格（陪伴感、少套话、口语化）。
