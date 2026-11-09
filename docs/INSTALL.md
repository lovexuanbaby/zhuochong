# 安装与发布说明（Windows）

本版为 `0.2.0-rc.1` 本地安装候选包，沿用现有 DSH 模型和凭据。交付方式为 **JS 插件包 + 独立 Python 虚拟环境**，不捆绑 Python 可执行文件。

## 前提

- Windows；DSH Desktop 已安装并配置模型。
- Python 3.10 或更高版本；`PySide6-Essentials` 固定为 `6.12.0`（包含窗口所需 Qt 模块，不安装 WebEngine 等无关组件）。
- 安装依赖时需要能访问 Python 包源；此过程不会读取模型密钥。
- 已验证的 DSH 接口基线为 `0.2.1-rc.5`；其他版本需重新确认。

## 安装

1. 解压插件源码，或将 `.tgz` 解压后进入其中的 `package` 目录。
2. 在 PowerShell 运行以下命令。脚本创建独立环境，默认位置为 `$DSH_HOME\deskpet\runtime`，未配置 DSH_HOME 时为用户主目录下 `.dsh\deskpet\runtime`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
# 如果本机 Python 不在标准目录：
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Python 'C:\path with spaces\python.exe'
```

`ExecutionPolicy Bypass` 只应用于这次脚本进程，不修改系统执行策略。脚本不会安装另一份 DSH 或覆盖聊天、记忆文件。

3. 使用 DSH 的插件管理入口安装本地包或链接目录。让 DSH 完成 JS 依赖安装，不手工编辑 profile 的依赖文件。
4. 在插件设置中将 `pythonPath` 留空，启用插件。已有的显式 `pythonPath` 和 `DSHPET_PYTHON` 优先于自动环境；需要使用新环境时清除旧覆盖。
5. 进入桌宠对话框；右上角“记忆”可查看、刷新和删除长期记忆。删除前有确认。

## 配置与故障诊断

插件导出真正的 Schemastery Config，提供 Python 路径、超时、上下文和历史上限、记忆开关与整理频率等字段。模型覆盖需同时填写 `chatProvider` 与 `chatModel`；不填写时沿用 DSH 当前模型。

Python 选择顺序为：插件显式设置 → `DSHPET_PYTHON` → 独立环境 → PATH（排除 Windows Store 别名）→ Windows 标准 Python 安装目录。无需固定用户名、工作目录或盘符。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
# 对特定解释器检查：
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1 -Python 'C:\path\python.exe'
```

`doctor.ps1` 检查 Python/PySide6 版本与导入，输出解释器和数据目录。启用失败时查看 DSH 的 `[python]` 日志；依赖缺失应重新运行 setup。启用前已存在的插件实例需停用再启用，才能载入新代码。

未启用 Windows 长路径支持时，Qt wheel 内部的部分文件名很长；安装脚本会拒绝长度超过 80 字符的虚拟环境根目录。优先使用默认用户数据目录；若改用短 `-DataRoot`，在插件设置里指定对应 Python，或让 DSH 使用同一个 DSH_HOME。插件本身可以放在中文/空格路径，脚本不会修改系统长路径策略。

## 数据与删除语义

- 聊天历史和用户画像分别保存在 `chat-history.json`、`user-memory.json`，均为本机明文。
- 删除记忆不删除聊天记录；原聊天仍可能出现在模型上下文中。
- 删除成功后停止从删除前的旧用户轮次提炼画像；已删除事实的规范化文本摘要被过滤，防止同一条事实重新保存。
- 新对话重新提及相关内容时，模型仍可能生成不同表述。删除记忆不是清除全部对话数据，也不是提供方数据删除操作。
- 查看/删除不调用模型；已在执行的模型请求不会因为删除而撤回。
- 停用或卸载插件不会自动删除用户历史、画像或独立 Python 环境。需要清理时先停用插件、备份数据，再按上述目录手工处理。

## 开发与候选包

```powershell
npm ci --ignore-scripts
npm test
npm run release:check
```

`DSHPET_TEST_PYTHON` 可指定测试用解释器。自动回归使用离屏 Qt，不操作真实聊天记录。`release:check` 检查打包文件清单与个人绝对路径，生成 `.tgz`、SHA-256 校验和及清单；不推送 Git，不上传 npm。

正式面向其他用户发布前，仍需在另一台干净 Windows 机器按本说明安装。当前机器的新虚拟环境、中文/空格路径和本地包测试不能替代另一台机器验收。
