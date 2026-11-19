# 0.2.1-rc.2 交付状态

更新：2026-11-19，Asia/Shanghai。

## 仓库内已完成

- agent 忙闲状态与任务结果分离，支持并发、恢复、运行中重载。
- 长期记忆查看、确认删除、失败恢复、请求超时、稳定标识与版本校验。
- 真正的 `@deepseek-ai/schemastery@3.18.5` Config，已通过安装中的 DSH/Cordis 原生 `resolveConfig()` 校验。
- 去掉补丁中的开发机 Python 绝对路径；支持独立环境、PATH、标准 Windows 安装目录。
- setup/doctor 脚本安装与诊断 `PySide6-Essentials==6.12.0`。
- 计时/提醒、陪伴关系与情绪、低打扰主动关心、事件记忆。
- 修复超时/停用后的孤儿用户消息、历史写入竞态、历史初始化竞态、空 `chatEventPath` 配置。
- 更新测试、安装说明和发布文档，重新生成候选包与校验清单。
- 安装脚本修复：长路径判定改为读取系统 `LongPathsEnabled` 策略（策略已启用时不再误拒深路径）；新增 `-PipIndex` / `DSHPET_PIP_INDEX` 指定包源镜像，并在依赖安装失败时给出镜像用法。

## 已执行的验证

| 验证 | 结果 |
|---|---|
| Config 和自动查找 Python | 10 项通过 |
| Host 聊天与记忆管理 | 25 项通过 |
| Qt 聊天与记忆 UI | 39 项通过 |
| 活动/结果状态逻辑 | 通过 |
| 状态 Qt 消息队列 | 通过 |
| 真实 Python 桥接 | 8 项通过 |
| 安装中 DSH 的原生 Cordis validator | 通过 |
| 全新、未共享系统包的 Python venv | 通过 |
| 候选 tgz 打包与清单检查 | 通过 |
| 上一版 tgz 离线安装 | 通过 |
| 安装脚本语法与本机注册表读取 | 3 个脚本解析无误；`LongPathsEnabled` 读取结果与本机策略一致 |

原生 Host 校验没有启动另一份 Harness，也没有调用模型。包安装测试和桥接测试使用独立临时数据，不修改用户聊天或记忆。

可复现命令：源码目录 `npm ci --ignore-scripts`、`npm test`、`npm run release:check`。安装步骤见 `docs/INSTALL.md`。

## 发布物

- `dist/dsh-deskpet-0.2.1-rc.2.tgz`
- `dist/dsh-deskpet-0.2.1-rc.2.tgz.sha256`
- `dist/release-manifest.json`

版本号、打包文件清单和 SHA-256 以 `release-manifest.json` 为准。

## 人工签收与后续

2026-11-09 用户已确认上一版测试通过并授权发布；本轮代码改动后的发布包需要重新签收。当前阶段不推送 Git、不上传 npm；项目仍为 `private: true`，通过 GitHub 发行附件交付。

发布说明见 `docs/RELEASE-NOTES-0.2.1-rc.2.md`。
