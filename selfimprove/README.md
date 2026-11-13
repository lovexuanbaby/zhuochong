# selfimprove · 桌宠自改进闭环（受控版）

这是给桌宠用的**自改进训练场**：Agent 在沙盒副本里改代码 → 跑确定性评测 →
分数提升且不破坏原有测试才保留 → **人工批准后**才合并部署。

## 目录

| 路径 | 作用 |
|---|---|
| `evaluate.mjs` | 评测入口：跑全部场景、算分、写 `reports/latest.json` |
| `scenarios/memory.mjs` | 记忆子系统评测场景（请求结构/解析/去重/删除/注入/防回流/注入防护） |
| `lib/harness.mjs` | mock DSH 上下文（llm + agentDefaultModel），隔离临时目录，不读真实用户数据 |
| `run-loop.md` | 每轮循环规则、红线、评分口径 |
| `setup-sandbox.ps1` | 创建/重建沙盒工作树（避免改动正在运行的插件目录） |
| `reports/` | 每轮评测 JSON 与报告 |

## 快速开始

```powershell
# 在项目根（zhuochong）下、用便携 git 创建沙盒
.\selfimprove\setup-sandbox.ps1

# 切到沙盒跑评测
cd ..\.selfimprove-worktree
node selfimprove\evaluate.mjs
```

## 安全边界

- 评测使用 mock LLM，**不联网、不花钱、不调用真实模型**；
- 所有历史/记忆文件都写在系统临时目录，不碰 `~/.dsh/deskpet/*.json`；
- 循环只允许改 `index.js`、`python/*.py`、`tests/*`、`selfimprove/*`；
- 是否部署由人批准，评测通过 ≠ 自动上线。

## 后续路线

- P1 记忆质量（当前）
- P2 计时/提醒能力（对应 `docs/next-phase.md` 的下一阶段）
- P3 对话风格（陪伴感、少套话）
- 每阶段先补评测场景，再让 Agent 针对失败场景改进。
