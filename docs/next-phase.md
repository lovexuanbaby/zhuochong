# 当前交付与后续签收

更新：2026-11-19，Asia/Shanghai。

GitHub 已发布版本为 `0.2.2`（前一版 `0.2.1-rc.2`）。`0.2.2` 新增简单日报与反馈式表达自优化，见 [功能说明](./DAILY-REVIEW.md)。完整证据见 [发布状态](./RELEASE-STATUS.md)。

## 已完成

- [x] 活动状态与结果分离；并发、恢复、重载等核心实机验证。
- [x] 记忆查看/删除、稳定标识与版本、保存失败、超时重试、历史保留规则。
- [x] 原生 Schemastery Config，通过实际安装的 Cordis 校验。
- [x] 去除个人 Python 绝对路径，增加独立环境与自动发现。
- [x] setup/doctor 脚本；新 venv 安装 PySide6 Essentials，不共享系统包。
- [x] 中文/空格路径下从 tgz 离线安装，真实 Python 桥接、异常启动和清理通过。
- [x] 计时/提醒、陪伴关系/情绪、低打扰主动关心、事件记忆。
- [x] 超时孤儿消息、历史写入竞态、历史初始化竞态、空 `chatEventPath` 配置修复。
- [x] 候选包 `0.2.1-rc.2`、文件清单、SHA-256 与安装说明。

记忆删除不等待模型调用结束：小型画像写入串行提交，revision 阻止先前的整理结果覆盖新状态。删除前的用户轮次不再参与提炼，规范化事实的摘要也会被过滤；聊天历史仍保留，删除不等于清除模型上下文。

## 复现检查

在源码目录运行：

```powershell
npm ci --ignore-scripts
npm test
npm run release:check
```

可用 `DSHPET_TEST_PYTHON` 指定测试解释器。当前结果为 Config 10 项、Host 25 项、Qt 聊天 39 项、桥接 8 项，另有状态逻辑与 Qt 状态转换检查。

## 后续

- 在另一台干净 Windows 机器上按 `docs/INSTALL.md` 完成安装验收。
- 视需要补充独立 EXE 交付方案。
- 发布前重新确认 `dist` 中 tgz、SHA-256 与 `release-manifest.json` 的版本一致。
