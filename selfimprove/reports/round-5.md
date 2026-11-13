# 自改进 · 第 5 轮报告（R5 情绪状态层）

- 日期：2026-11-14
- 沙盒分支：`selfimprove`（`e02c74e`）
- 评测：`node selfimprove/evaluate.mjs`（49 个场景：记忆 14 + 计时 15 + 陪伴 11 + 情绪 9）

## 结论

**建议采纳。** 桌宠现在有连续的情绪状态，而不是每句话重新“猜”：评测 **82.28（41/49）→ 100（49/49）**，全部回归通过。

> 客观说明：这是**行为模拟层**（识别→状态→表达），不是“真的情感”。它让回复更连贯、更贴合上下文，但不会让模型产生真实感受。

## 分数对比

| 指标 | 基线（第 4 轮） | 候选 |
|---|---|---|
| 场景通过 | 41/49 | **49/49** |
| 加权 score | 82.28 | **100** |
| 失败项 | 8 个情绪场景 | 无 |

## 新增能力

1. **情绪状态持久化**（`companion.json` 的 `emotion` 字段）
   - `valence` 心情（-1～1）、`energy` 精力（0～1）、最近 5 条情绪事件（mood/强度/时间）。
2. **自然衰减**：心情随时间趋近 0，精力趋近 0.5（例如 10 小时后负向情绪明显减弱）。
3. **否定句防误判**：`我不累`、`还好`、`没加班` 不会被当成疲惫；测试已覆盖。
4. **状态注入回复**：状态明显时，系统提示带「# 你的状态」（心情/精力/最近用户情绪），模型回复更连贯。
5. **协议扩展**：每轮成功回复后推送 `pet.mood`（valence/energy/mood），Python 侧已接收保存，供后续表情/动画使用。
6. **可关闭**：`chatEmotionEnabled`（默认开），关闭后不更新、不注入、不推送。

## 改动文件

| 文件 | 变化 |
|---|---|
| `index.js` | +124：情绪状态、衰减、否定规则、提示注入、pet.mood 推送 |
| `config.js` | +1：`chatEmotionEnabled` |
| `python/deskpet_bridge.py` | +3：`pet.mood` 分发 |
| `python/pet_windows.py` | +10：`set_mood()` 保存状态 |
| `selfimprove/scenarios/emotion.mjs` | 新增 9 个情绪评测场景 |

## 验证

| 检查 | 结果 |
|---|---|
| `selfimprove/evaluate.mjs` | **100 分（49/49）** |
| `tests/chat-ui-smoke.py` | 39/39 |
| `tests/config-smoke.mjs` / `agent-status-smoke.mjs` / `chat-host-smoke.mjs` | 通过 |
| `tests/native-host-schema.mjs`（Electron） | 通过 |
| `node --check` / `py_compile` | 通过 |

## 风险与限制

- 情绪识别仍是**关键词规则 + 否定表**，会漏判复杂表达（如反讽、混合情绪）；
- 状态目前**没有可见表情变化**（Python 只保存，后续轮次再做表情/气泡风格联动）；
- 状态是模拟，不应对用户宣称“它真的懂你的感受”；
- 可随时 `chatEmotionEnabled: false` 关闭。

## 审批与部署

批准后：

```powershell
git -C .\zhuochong merge selfimprove
# 然后在 DSH 插件管理里停用/启用 dsh-deskpet
```

## 下一轮

按路线图进入 **R7 事件记忆**（记得“11 月 12 日加班到很晚”这类具体事件），或先做 R6 主动关心 v2（作息学习 + 凌晨/早安）。建议 R7 优先。
