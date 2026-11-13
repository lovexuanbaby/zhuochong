# 桌宠自改进循环（人工批准模式）

目标：让 Agent 在**沙盒副本**里改进桌宠代码，自动评测打分，只有分数不降、测试全过，
并且**你批准**之后，才把改动合并进主仓库并部署到 DSH。

## 每轮流程

```text
1. 基线：node selfimprove/evaluate.mjs   → 记下 score 与失败场景
2. 选目标：从 FAIL / 薄弱场景里挑一个（一次只改一个点）
3. 改动：在沙盒 selfimprove 分支修改代码（index.js / python / tests）
4. 复测：重跑 evaluate.mjs；必要时一并跑新版自带测试
5. 报告：生成 selfimprove/reports/round-N.md（改了什么、分数变化、风险）
6. 人工批准 → 合并回 main → 重新启用插件部署
   不批准 → git reset --hard 丢弃本轮改动
```

## 硬性规则

- **只在沙盒工作树** `..\.selfimprove-worktree` 里改代码；不要直接改主工作区、不要改已安装的 DSH profile。
- 每次只动**一个能力点**，改动范围不超过 `index.js`、`python/*.py`、`tests/*`、`selfimprove/*`；
  禁止修改 `chat-history.json`、`user-memory.json` 等用户数据文件。
- 评测必须 **score 不下降且失败场景减少** 才可提交；否则回滚。
- 每轮最多 3 次自动重试；单轮时间预算 ≤ 20 分钟；连续 3 轮无提升则停止并汇报。
- 部署必须你明确批准；部署前先跑一遍 `scripts/test.mjs` 与 `selfimprove/evaluate.mjs`。
- 任何“为了通过评测而改评测/放宽断言”的行为一律视为失败，回滚。

## 沙盒命令

```powershell
# 首次创建（Git 用项目自带的 portable git）
.\selfimprove\setup-sandbox.ps1

# 在沙盒里评测
cd ..\.selfimprove-worktree
node selfimprove\evaluate.mjs

# 查看本轮 diff
git diff

# 批准后合并
cd ..\zhuochong
git merge selfimprove
```

## 评分口径

- 每个场景有标题与权重；score = 通过权重 / 总权重 × 100。
- 场景覆盖：记忆整理请求结构、JSON 解析变体、去重截断、类型归一、删除 revision 校验、
  已删除记忆防回流、记忆注入、损坏文件隔离、失败轮隔离、提示注入防护。
- 当前评测用 **mock LLM**（确定性、不花钱）；后续可加“真实模型抽检”作为加分项。
