# DSH 桌宠插件开发工作流

更新日期：2026-11-06（Asia/Shanghai）

## 目标与协作约定

制作可以安装到用户自己的 DSH 中使用的 Windows 桌宠插件。模型配置与凭据由 DSH 管理，JS 插件接入宿主并管理 Python 子进程，Python 负责窗口与交互。

本次根据 Codex「你好」会话原工作流、当前仓库及本轮执行的测试同步进度。原工作流位置：`D:\chatgpt\2026-10-28\n-h\outputs\desktop-pet-workflow.md`。项目内保存同内容副本，便于后续协作。

沿用原协作方式：用户可自己编写 Python，助手负责解释、排错和评审，JS 接入层可协作开发。用户明确要求执行修改时，按当次授权范围实施。本轮按「检查已完成阶段，开始下一阶段」实施状态整合与测试；未创建分支、提交或发布。

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

已超过原工作流的「准备开发聊天」阶段：通信、窗口、聊天、历史持久化、长期记忆、基础外观动画已有实现和测试。「状态语义整合」的代码和自动验收已完成，当前等待真实宿主重载验收，之后再扩展记忆管理与发布设置。

| 原阶段 | 当前状态 | 证据与剩余边界 |
|---|---|---|
| 1. 进程通信 | 基线完成 | 真实 Python 子进程完成 ping/pong、shutdown/bye，自动测试验证回收与重复清理 |
| 2. PySide6 窗口 | 已实现 | 已有透明、无边框、置顶机器人窗口，不再是最小 QLabel 原型 |
| 3. 窗口与通信 | 基线完成 | 后台线程只入队，QTimer 在主线程更新 UI；离屏测试覆盖 11 次活动/结果转换、期限与旧协议 |
| 4. DSH 插件启停 | 历史实机通过；本轮重载待验收 | 原会话曾确认启停、单窗口与无黑色控制台；不能代替本轮修改后的现场验收 |
| 5. 宿主状态 | 活动/结果整合自动测试通过 | 任意 agent 运行时 thinking；全部 idle 后逻辑空闲；结果独立保留 3.8 秒，真实宿主待验收 |
| 5. 桌宠聊天 | 已实现，自动回归通过 | 输入、回复、上下文、超时和错误反馈；使用宿主模型，独立保存桌宠聊天 |
| 5. 历史与长期记忆 | 已实现，自动回归通过 | 原子保存、损坏文件隔离、启动恢复、画像提炼与注入；尚无查看/删除记忆入口 |
| 6. 外观、动画与交互 | 基础实现完成 | 呼吸、眨眼、跟随鼠标、思考/结果动画、拖动、右键菜单；组合操作仍需实机回归 |
| 7. 发布 | 尚未完成 | 个人 Python 路径、配置界面、依赖交付方式、干净环境安装仍待处理 |

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

下列结果来自 2026-11-06 本轮实际执行。Host 状态由测试模拟；真实 Python 子进程与离屏 Qt 已实际运行，尚未触发修改后 DSH 中的真实模型任务。

| 命令/文件 | 结果 | 覆盖 |
|---|---|---|
| `node tests/agent-status-smoke.mjs` | 通过 | 四类结果、busy/idle、并发与连续轮次、旧事件/实例、启动快照、握手缓冲、去重、卸载 |
| `python tests/agent-status-ui-smoke.py` | 通过 | 11 次转换、真实队列、气泡与表情、保留期限、过期不重播、新任务清理、旧/异常协议 |
| `node tests/bridge-smoke.mjs <python.exe>` | 6/6 | apply 入口、真实 Python 管道转发 running → result → idle、握手、回收、重复清理 |
| `node tests/chat-host-smoke.mjs` | 20/20 | 聊天、上下文、历史、画像、超时、错误、清理 |
| `python tests/chat-ui-smoke.py` | 23/23 | 输入、回复、失败恢复、长文本、历史、日期分隔、记忆提示 |
| `git diff --check` | 通过 | 本轮变更的空白检查 |

Python/Qt 测试使用带 PySide6 的解释器和 `QT_QPA_PLATFORM=offscreen`。测试在 Windows 沙箱内被拒绝启动时，已经通过授权在沙箱外执行。

## 当前阶段：状态整合已实现，待真实宿主验收

详细拆分、预期行为和操作清单见项目内 `docs/next-phase.md`。

1. 已完成轮次结果与 running/idle 分离，已补并发、连续轮次与 Qt 期限测试。
2. 在 DSH 中重载插件，实测普通完成、中止、失败、连续运行、并发、运行中重载与卸载。
3. 复验桌宠聊天、历史恢复、记忆提示、拖动与关闭，不新增 DSH 会话，不留 Python 进程。
4. 完成记录后，再由用户按原协作流程提交、合并；当前不声称本轮修改已经提交或推送。
5. 稳定性验收后建议先做「记忆查看/删除」，再做 Config 设置和依赖交付。计时、提醒与更丰富的协议仍为后续候选。

## 后续功能与发布待办

### 记忆管理

- [ ] 提供查看记忆条目的入口，按已有事实结构展示。
- [ ] 支持删除指定事实，保存后刷新计数；重启不恢复已删除条目。
- [ ] 明确删除事实与保留原始聊天记录的关系，避免自动提炼立即重新生成。
- [ ] 覆盖空记忆、保存失败、并发提炼与删除场景。

### 设置、路径与交付

- [x] JS 从模块路径定位 `python/deskpet_bridge.py`，不依赖当前工作目录。
- [x] `package.json` 已声明 `python/*.py`、`requirements.txt` 等打包文件。
- [ ] 增加宿主适配的 Config schema，使必要运行设置可编辑。
- [ ] 将 `cordis.patch.yml` 中个人 Python 路径转为最终用户可用的配置/安装方案。
- [ ] 决定要求安装 Python/PySide6，还是交付打包辅助程序；requirements.txt 不代替安装。
- [ ] 复验 windowsHide 与桌宠可见性、控制台/任务栏体验，不盲目改回旧设置。
- [ ] 缺少 Python/PySide6、管道关闭、子进程异常退出、超时终止应有可理解反馈与恢复路径。
- [ ] 在干净 Windows 环境验证中文/空格路径、启停、聊天、错误恢复、数据更新与卸载范围。
- [ ] 确认支持版本、依赖许可、安装说明、版本号和发布包；本次不作发布承诺。

## Git 与交接快照

2026-11-06 本地检查：

- 当前分支 `main`，HEAD 为 `c228e28`（打包依赖声明与 README 安装说明）。
- 本地缓存的 `origin/main` 与 HEAD 相同；本次未 fetch，不能据此确认远程实时状态。
- 历史提交已包含 `c229fbc`（聊天、持久化、长期记忆）、`bc36ccc`（界面与动画）、`b919ab2`（任务结果文案）。
- 本轮状态改动尚未提交：`index.js`、`python/deskpet_bridge.py`、`python/pet_windows.py`、README、桥接测试及两个新增状态测试。
- `cordis.patch.yml` 的 Python 路径修改在本轮状态开发前已存在；本次保留，不能混称为新改动。
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
| Python → JS | ready、pong、bye、chat |
| JS → Python | chat/accepted、chat/reply、chat/error、chat/history、chat/memory |

所有消息继续使用一行一个 UTF-8 JSON；stdout 仅放协议，stderr 放诊断；聊天 id 与 ping id 独立。
