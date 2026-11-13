# 自改进 · 第 4 轮报告（陪伴人格 v1 · 安静温柔）

- 日期：2026-11-14
- 沙盒分支：`selfimprove`
- 评测：`node selfimprove/evaluate.mjs`（40 个场景：记忆 14 + 计时 15 + 陪伴 11）

## 结论

**建议采纳。** 桌宠从“会聊天+有记忆”升级为「安静温柔型陪伴」：评测 **75（31/40）→ 100（40/40）**，Python UI 冒烟 **39/39**，全部回归通过。

## 分数对比

| 指标 | 基线（第 3 轮） | 候选 |
|---|---|---|
| 场景通过 | 31/40 | **40/40** |
| 加权 score | 75 | **100** |
| 失败项 | 9 个陪伴场景（人格/关系/情绪/主动关心） | 无 |

## 新增能力

1. **安静温柔人格（默认）**
   - 话不多、语气柔和、少感叹号；先接住情绪再回应；不主动刷屏；不装人类也不反复强调 AI。
   - 保留 `chatSystemPrompt` 配置，可随时换成其他性格。

2. **关系感**
   - 新增 `companion.json`：认识时间、聊天轮数、最近互动、主动关心节流。
   - 认识 ≥2 天后，系统提示会带上「你们已经认识 N 天，聊过 M 轮」，回复更自然。

3. **情绪回应**
   - 识别「累/困/加班」「难过/失落」「烦/焦虑/压力」「开心/兴奋」四类情绪，
   - 自动给模型加一句回应提示（先共情、别讲道理、别泼冷水）。

4. **低打扰主动关心（可关）**
   - 深夜（22 点后）轻声提醒休息，每天最多一次；
   - 白天连续 4 小时没说话，轻轻问候一句；
   - 只在桌宠气泡显示，**不写入聊天记录**，不刷屏；`chatProactiveEnabled` 控制。

5. **安静型细节**
   - 计时提示音默认改为**关闭**（`chatTimerSound` 默认 false），避免安静桌宠突然响。

## 改动文件

| 文件 | 说明 |
|---|---|
| `index.js` | 人格默认值、关系数据、情绪提示、主动关心 ticker、提示音默认静音 |
| `config.js` | `chatProactiveEnabled`、`chatCompanionPath`、`chatTimerSound` 默认值 |
| `python/deskpet_bridge.py` | `chat/proactive` 分发 |
| `python/pet_windows.py` | `show_proactive()` 气泡显示 |
| `selfimprove/scenarios/companion.mjs` | 新增 11 个陪伴场景 |
| `selfimprove/lib/harness.mjs`、`evaluate.mjs` | 陪伴环境与场景分组 |

## 验证

| 检查 | 结果 |
|---|---|
| `selfimprove/evaluate.mjs` | **100 分（40/40）** |
| `tests/chat-ui-smoke.py` | **39/39** |
| `tests/config-smoke.mjs` / `agent-status-smoke.mjs` / `chat-host-smoke.mjs` | 通过 |
| `tests/native-host-schema.mjs`（Electron） | 通过 |
| `node --check` / `py_compile` | 通过 |

## 风险与限制

- 人格/情绪提示是“给模型的约束”，**真实回复的体感仍取决于模型**，建议合并后真人聊几轮再微调措辞；
- 情绪识别是关键词启发式，可能漏判/误判（如“累”出现在别处）；
- 主动关心规则固定（22 点后、白天 4 小时无互动、每天最多一次），暂不支持自定义时间段；
- 关系数据只存本地，不参与 DSH 会话。

## 审批与部署

> 注意：`selfimprove` 分支是累积的，合并会**同时带上第 3 轮计时增强**（其中提示音已改为默认静音）。

批准后：

```powershell
git -C .\zhuochong merge selfimprove
# 然后在 DSH 插件管理里停用/启用 dsh-deskpet
```

部署后建议：随便聊几轮，看看人格语气；晚上 22 点后看它会不会轻轻提醒休息。

## 下一轮候选

- **真实模型体感抽检**：跑 5～10 个真实对话场景，你打分，再微调人格/主动关心频率；
- 主动性分级（更安静/偶尔主动/话多）；
- 重复提醒、纪念日等陪伴细节。
