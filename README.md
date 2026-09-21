# DeepSeek Harness Desktop

面向 Windows 的 DeepSeek Harness 桌面管理器。它不是对 Harness 的分叉，而是把官方 `@deepseek-ai/dsh` 作为可替换运行时，由一个独立桌面监督层负责启动、健康检查、升级、回滚和诊断。桌面版使用独立的托管 profile 目录，保持 DSH profile 与插件格式兼容，同时避免全局 `~/.dsh` 中的旧插件破坏恢复基线。

当前恢复地板锁定为在独立托管 profile 上验证可用的 `@deepseek-ai/dsh@0.1.1-rc.2`；稳定通道会发现 npm `latest`（本次验证为 `0.1.5-rc.2`），但只有通过完整候选观察期才会晋升。预览通道可以发现 alpha 版本，但默认不会自动安装。

## 本地运行

```powershell
npm install
npm run dev
```

生产验证与 Windows 安装包：

```powershell
npm run verify
npm run dist:win
```

安装包会生成在 `release/`。卸载时不会删除用户数据或恢复记录。为防止 Windows 长路径造成依赖文件缺失，安装器使用默认目录，并拒绝长度超过 74 字符的安装路径；默认用户路径过长时可用 NSIS 的 `/S /D=C:\DSHDesktop` 参数安装到短路径。当前安装包未做代码签名；Windows 可能显示 SmartScreen 提示。

## 恢复模型

1. 桌面进程启动官方 DSH Web profile，并只监听 `127.0.0.1` 的随机端口。
2. 新版本先安装到独立候选目录，不覆盖当前版本。
3. 候选版本依次通过 CLI 版本检查、托管 profile 配置合成检查、HTTP 存活检查。
4. 候选版本完成观察期后才成为 `lastKnownGood`。
5. 运行时异常时先自动关闭省 token 配置重试；若候选仍失败，则回滚并启动上一稳定版本。
6. 稳定运行时连续崩溃时，桌面监督器指数退避重启；非捆绑运行时无法恢复时，回落到捆绑版本。
7. 正式安装包会运行一个轻量外部看门狗；桌面主进程非正常退出时，看门狗重新拉起应用。

## 数据边界

- 全局 DSH 数据：`%USERPROFILE%\.dsh`，桌面版不读取或改写。
- 桌面状态：Electron `userData/recovery/state.json`。
- 独立运行时：Electron `userData/runtimes/<version>`。
- 托管配置与会话：Electron `userData/harness-home`（不读取或改写全局 `~/.dsh`）。
- 升级安装器：随应用锁定发布的 npm，不依赖系统 PATH 或全局 Node.js。
- 日志：Electron `userData/logs/desktop.log` 与 `harness.log`。

桌面管理器不会读取或显示 `.credentials.yaml` 的内容，也不会把密钥复制进升级目录。

## 省 token 模式

默认启用、可在中文界面关闭。仅通过官方 DSH 内置组件裁剪过长工具输出、提前压缩长会话，并关闭需要额外模型调用的会话标题生成；不覆盖用户选择的模型或凭据。失败时先自动关闭优化层并尝试原生配置。相关竞品对照、配置边界与测试结果见 [docs/token-optimization.md](docs/token-optimization.md)。

## 官方设计依据

- DeepSeek V4 原生支持 Responses API，并针对 Codex 适配；模型与接口通过运行时层选择，不写死进 UI。
- Codex 的 workspace sandbox、审批策略与 `AGENTS.md` 思路被映射为“最小 IPC + 项目规则 + 明确权限边界”。
- Claude Code 的可恢复会话、权限模式、后台会话与可组合工具思路被映射为“任务运行时独立于桌面壳”。

详细设计与取舍见 [docs/architecture.md](docs/architecture.md) 和 [docs/adr](docs/adr)。
