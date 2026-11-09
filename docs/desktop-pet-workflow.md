# DSH 桌宠插件开发工作流

更新日期：2026-11-09（Asia/Shanghai）。11 月 6–7 日实机记录保留，当前增加候选包交付结果。

## 目标与协作约定

制作可以安装到用户自己的 DSH 中使用的 Windows 桌宠插件。模型配置与凭据由 DSH 管理，JS 插件接入宿主并管理 Python 子进程，Python 负责窗口与交互。

本次根据 Codex「你好」会话原工作流、当前仓库及本轮执行的测试同步进度。原工作流位置：`D:\chatgpt\2026-10-28\n-h\outputs\desktop-pet-workflow.md`。项目内保存同内容副本，便于后续协作。

沿用原协作方式：用户可自己编写 Python，助手负责解释、排错和评审，JS 接入层可协作开发。用户明确要求执行修改时，按当次授权范围实施。上一轮完成状态整合与自动测试；本轮由用户操作 DSH、助手核对事件和进程完成核心实机验收，未额外修改功能代码、创建分支、提交或发布。

```text
用户已有的 DSH（模型、凭据、agent 生命周期）
    ↕ 宿主服务与事件
index.js（Python 生命周期、状态映射、聊天、历史与记忆）
    ↕ UTF-8，每行一个 JSON
python/deskpet_bridge.py（后台读输入 → 队列 → Qt 主线程）
    ↕ 界面方法
python/pet_windows.py（桌宠、动画、聊天对话框）
```

`dshai.py` 的独立 SDK 实验不作为插件入口；不另起 Harness，不要求第二份 API Key。当前聊天直接使用宿主 `llm` 和 `agentDefaultModel`，不创建或写入 DSH 会话。

## 当前阶段

已超过原工作流的「准备开发聊天」阶段：通信、窗口、聊天、历史持久化、长期记忆、基础外观动画已有实现和测试。「状态语义整合」的代码和自动验收已完成；真实 DSH 的完成、中止、下一轮恢复、并发、启停、运行中重载和历史恢复已验收。真实失败、同一 running 区间连续轮次、桌宠重启后新消息回复仍单列待验，未将整个发布验收标为完成。

| 原阶段 | 当前状态 | 证据与剩余边界 |
|---|---|---|
| 1. 进程通信 | 基线完成 | 真实 Python 子进程完成 ping/pong、shutdown/bye，自动测试验证回收与重复清理 |
| 2. PySide6 窗口 | 已实现 | 已有透明、无边框、置顶机器人窗口，不再是最小 QLabel 原型 |
| 3. 窗口与通信 | 基线完成 | 后台线程只入队，QTimer 在主线程更新 UI；离屏测试覆盖 11 次活动/结果转换、期限与旧协议 |
| 4. DSH 插件启停 | 本轮空闲启停与运行中重载通过 | 进程数按 1 → 0 → 1 变化；运行中重载新进程启动于任务区间内，父进程为同一 DSH Host |
| 5. 宿主状态 | 自动测试及核心实机路径通过 | completed、aborted、下一轮恢复和并发已核对；真实失败仍待实测 |
| 5. 桌宠聊天 | 已实现，自动回归通过 | 输入、回复、上下文、超时和错误反馈；使用宿主模型，独立保存桌宠聊天 |
| 5. 历史与长期记忆 | 已实现，自动回归与本轮恢复检查通过 | 用户确认重启后聊天历史及记忆提示保留；本轮已加入记忆查看/删除入口 |
| 6. 外观、动画与交互 | 基础实现完成 | 呼吸、眨眼、跟随鼠标、思考/结果动画、拖动、右键菜单；组合操作仍需实机回归 |
| 7. 发布 | 0.2.0-rc.1 候选包已生成 | Config、自动路径、安装/诊断脚本、本机独立环境和包安装检查通过；目标 UI 与另一台干净 Windows 待人工签收 |

## 本次纠正与差异

### 状态语义

- 2026-11-02 原会话曾由用户确认：正常结束显示任务完成、中止显示任务已中止、下一轮恢复思考，idle 不立即覆盖结果；真实失败场景未验收。
- 2026-11-06 本会话按 running → idle 请求改为监听 `agent/status`、`agent/created`、`agent/disposed`，按 agent 实例汇总运行状态。启动时从 `agents.list()` 恢复；握手前暂存，握手后发送；重复状态不重置动画；卸载移除监听。
- 前一轮仅接入忙闲状态时移除了原轮次结果监听；**本轮已经补回 `session/event`，按 session 对象身份与 turn 关联结果**，映射 completed/error/aborted/其他原因到 done/error/aborted/ended。
- **idle 只代表空闲，不代表成功。** Host 用可选 `result: { id, state }` 单独通知结果；Qt 保留提示 3.8 秒。仍有任务时保持思考表情；空闲时可短暂播放结果动画，随后回到待命。重复 id 不延长提示，新的运行或轮次立即清掉旧提示；并发结果显示最近一条。
- 已复核本机 runtime 的真实时序：turn/end 先在轮次结束时产生，整个 driver 退出时才发 idle；同个 running 区间可含多个轮次。自动测试覆盖这一情形、旧事件、实例替换、运行中加载与释放。
- 当前忙闲统计范围是宿主 agent 注册表；桌宠直接调用 `llm` 的聊天等待提示由聊天对话框管理，不会自动形成一个 DSH agent。

### 聊天与协议

- 原计划「选择专用/当前 DSH 会话」已经被当前实现替代：`agentDefaultModel.currentSelection()` 选择模型，`ctx.llm.stream()` 获取回复，桌宠自己维护上下文，不向 DSH 会话写入消息。
- 实际协议为 `chat`、`chat/accepted`、`chat/reply`、`chat/error`，不是旧草案的 `chat.send` / `chat.reply`。
- 已加入 `chat/history` 和 `chat/memory`。默认数据目录为 `$DSH_HOME/deskpet/`；未设置 DSH_HOME 时使用用户主目录下 `.dsh/deskpet/`。
- 聊天与画像为本地明文 JSON；画像提炼会使用宿主配置的模型，沿用 README 的说明。
- 原 `test.mjs` 保留为手工工具；自动验证以 `tests/` 为准。生产握手依据匹配的 pong，不应为同步旧计划而改回固定延迟。

## 验证记录

下列自动测试来自 2026-11-06 实际执行。另于 11 月 6 日至 7 日开展真实 DSH 验收；已通过完成、中止、下一轮恢复、并发、启停、运行中重载和历史恢复，具体时间、用户观察与事件/进程证据见 `docs/live-status-validation.md`。自动测试与实机结果分别记录。

| 命令/文件 | 结果 | 覆盖 |
|---|---|---|
| `node tests/agent-status-smoke.mjs` | 通过 | 四类结果、busy/idle、并发与连续轮次、旧事件/实例、启动快照、握手缓冲、去重、卸载 |
| `python tests/agent-status-ui-smoke.py` | 通过 | 11 次转换、真实队列、气泡与表情、保留期限、过期不重播、新任务清理、旧/异常协议 |
| `node tests/bridge-smoke.mjs <python.exe>` | 8/8 | apply 入口、真实 Python 管道、握手、回收、EOF 和超时终止 |
| `node tests/chat-host-smoke.mjs` | 24/24 | 聊天、上下文、历史、画像、稳定 ID 记忆查看/删除、竞态保护、超时、错误、清理；此前 25 项为计数误写 |
| `python tests/chat-ui-smoke.py` | 36/36 | 输入、回复、失败恢复、长文本、历史、记忆查看/删除确认、保存失败、超时和迟到响应 |
| `git diff --check` | 通过 | 本轮变更的空白检查 |

Python/Qt 测试使用带 PySide6 的解释器和 `QT_QPA_PLATFORM=offscreen`。测试在 Windows 沙箱内被拒绝启动时，已经通过授权在沙箱外执行。

## 当前阶段：用户确认验收通过，提交 GitHub 预发布

详细拆分、预期行为和操作清单见项目内 `docs/next-phase.md`。

1. 已完成轮次结果与 running/idle 分离，已补并发、连续轮次与 Qt 期限测试。
2. 已通过普通完成、中止、下一轮恢复、并发、启停与运行中重载；后续补验真实失败和同一运行区间的连续轮次。
3. 复验桌宠聊天、历史恢复、记忆提示、拖动与关闭，不新增 DSH 会话，不留 Python 进程。
4. 用户已将状态代码提交为 `82a4ded`；继续补验收记录，再由用户决定推送。本文不声称已确认远程实时状态。
5. 记忆管理、Config、路径适配、独立环境安装和候选包检查已完成。2026-11-09 用户确认测试均通过，并授权提交、推送和 GitHub 预发布；按用户反馈记录签收，不虚构额外实机日志。计时/提醒为后续功能。

## 后续功能与发布待办

### 记忆管理

- [x] 提供查看记忆条目的入口，按已有事实结构展示。
- [x] 支持删除指定事实，保存后刷新计数；删除及过滤信息跨重启保留。
- [x] 删除不改聊天历史；后续只从新用户轮次提炼，并过滤同一规范化事实。新表述仍可能从新对话学到。
- [x] 覆盖空记忆、保存失败、并发提炼与删除、超时与迟到响应场景。

### 设置、路径与交付

- [x] JS 从模块路径定位 `python/deskpet_bridge.py`，不依赖当前工作目录。
- [x] `package.json` 已声明 `python/*.py`、`requirements.txt` 等打包文件。
- [x] 增加真实 Schemastery Config；通过原生 Cordis 校验，设置界面操作仍待重载后确认。
- [x] 将个人 Python 路径改为显式设置/环境变量/独立环境/自动发现方案。
- [x] 采用独立 Python + PySide6 Essentials，提供 setup 与 doctor；不捆绑 EXE。
- [ ] 复验 windowsHide 与桌宠可见性、控制台/任务栏体验，不盲目改回旧设置。
- [x] 缺少 Python/PySide6 启动指引、EOF 退出、退出超时终止与清理通过实际子进程检查。
- [ ] 在干净 Windows 环境验证中文/空格路径、启停、聊天、错误恢复、数据更新与卸载范围。
- [x] 明确本机已验版本、安装说明和 0.2.0-rc.1 本地候选包；未公开发布。

## Git 与交接快照

本轮实机验收开始时的本地检查：

- 当前分支 `main`，HEAD 为 `82a4ded`（状态活动与结果分离），其前一提交为 `c228e28`。
- 本地 `main` 比缓存的 `origin/main` 领先 1 个提交；本次未 fetch，不能据此确认远程实时状态。
- 历史提交已包含 `c229fbc`（聊天、持久化、长期记忆）、`bc36ccc`（界面与动画）、`b919ab2`（任务结果文案）。
- 状态代码、界面和自动测试已在 `82a4ded` 中；当前新增实机验收记录及其文档更新尚未提交。
- 最初的 `cordis.patch.yml` 个人路径修改已有记录；按本轮发布适配要求，现已移除，改为可配置的自动发现。
- 工作流和下一阶段说明已更新为本轮实现/测试结果，README 已包含协议与文档入口。

继续沿用：确认工作区 → 按授权创建小功能分支 → 实现并验证 → 用户提交/合并 → 合并后再验收。建议新分支使用 `codex/` 前缀；本次没有创建分支、提交、合并或推送。

## 当前文件职责与消息表

| 文件 | 职责 |
|---|---|
| `index.js` | Host 插件、桥接、忙闲状态、直接模型聊天、历史与长期记忆 |
| `python/deskpet_bridge.py` | 唯一生产 Python 入口；协议与 Qt 主线程消息分发 |
| `python/pet_windows.py` | 桌宠绘制、动画、交互和聊天对话框 |
| `python/pet.py`、`test.mjs` | 旧测试/手工排错，不是生产入口 |
| `tests/` | 桥接、状态、聊天与 UI 的自动检查 |
| `cordis.patch.yml` | 插件安装补丁与本机配置 |
| `README.md`、`requirements.txt`、`package.json` | 说明、依赖及包清单 |

| 方向 | 实际消息 |
|---|---|
| JS → Python | ping、shutdown、pet.state |
| Python → JS | ready、pong、bye、chat、memory/list、memory/delete |
| JS → Python | chat/accepted、chat/reply、chat/error、chat/history、chat/memory、chat/memory/details、chat/memory/error |

所有消息继续使用一行一个 UTF-8 JSON；stdout 仅放协议，stderr 放诊断；聊天 id 与 ping id 独立。
