# 自改进 · 第 1 轮报告（记忆质量）

- 日期：2026-11-14
- 沙盒分支：`selfimprove`（工作树 `../.selfimprove-worktree`，**未改动主仓库/已安装插件**）
- 改动文件：`index.js`（+31 / −8）
- 评测：`node selfimprove/evaluate.mjs`（mock LLM，确定性、不联网）

## 结论

**建议采纳。** 评分从 **80.95（12/14）提升到 100（14/14）**，全部回归测试通过，改动仅限记忆文本处理与整理提示词，风险可控。

## 分数对比

| 指标 | 基线 `76a3d5a` | 候选 `f589cab` |
|---|---|---|
| 场景通过 | 12/14 | **14/14** |
| 加权 score | 80.95 | **100** |
| 失败项 | ① 记忆文本含换行/控制字符（提示注入风险）<br>② 整理提示词未提醒“不要恢复已删除记忆” | 无 |

## 改动内容

### 1. 记忆文本单行化（防提示注入）

新增 `sanitizeFactText()`：

```js
function sanitizeFactText(text) {
  return text
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}
```

应用于三处：
- `parseMemoryFacts()`：模型输出解析（含换行的记忆文本会被压成单行，超长仍丢弃）；
- `readMemory()`：加载历史记忆文件时归一化（兼容旧数据，空值过滤）；
- `memoryFactId()`：删除防回流哈希基于归一化文本，保持新旧一致。

### 2. 整理提示词增加“已删除记忆”护栏

`memoryExtractionPrompt(existingFacts, maxFacts, forgottenCount)` 新增第三参数：
存在已删除记忆时追加规则：

> 6. 用户已删除 N 条记忆：不要恢复、不要重新添加已删除的内容，只根据最近对话与已有记忆整理。

`updateMemory()` 传入 `this.forgottenFactHashes.size`。

## 验证

| 检查 | 结果 |
|---|---|
| `selfimprove/evaluate.mjs` | **100 分（14/14）** |
| `tests/config-smoke.mjs` | 通过 |
| `tests/agent-status-smoke.mjs` | 通过 |
| `tests/chat-host-smoke.mjs` | 通过 |
| `tests/native-host-schema.mjs`（Electron Node 模式） | 通过 |
| `node --check index.js` | 通过 |

Python/UI 测试未跑：本轮未改 Python 与 Qt 代码。

## 风险与回滚

- 记忆文本中的多行内容会被合并为一行——这是预期行为（防注入），显示更安全；
- 旧记忆文件若存在换行/异常空白，加载时归一化后 id 变化，但删除防回流哈希基于同一归一化算法，不会误放行；
- 回滚：`git -C ..\.selfimprove-worktree reset --hard main` 即可，主仓库未受影响。

## 审批与部署

批准后执行：

```powershell
# 1) 合并到主仓库 main
git -C .\zhuochong merge selfimprove

# 2) 重载已安装插件（禁用/启用一次）
#    DSH 插件管理 → dsh-deskpet → 停用 → 启用
```

部署后建议：打开桌宠「记忆」窗口刷新一次，确认 5 条记忆显示正常；随便聊两轮观察“已记住 N 件事”变化。

## 下一轮候选

- P2：计时/提醒能力（当前版本还没有，属于 `docs/next-phase.md` 的下一阶段），先补场景再让 Agent 改进；
- P3：对话风格（陪伴感、少套话、口语化）。
