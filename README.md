# DeepSeek Harness Desktop

> 基于 DeepSeek 官方桌面源码的 0.5.0 社区恢复候选版已通过自动资格验收（2026-10-11）。锁定官方 `0.2.0-rc.2`，默认中文，Sub2API 已移除。同一成品通过首次安装、同版本替换及独立卸载、三次真实崩溃恢复、两轮生产欢迎页正常退出及实际工作台/设置 UI 检查；原生文件夹选择和工作台原生菜单退出仍需人工确认。已发布稳定版保持 0.4.0，不更新 latest。安装包入口见 [发布目录](https://github.com/pyljjun2009-sketch/deepseek-harness-desktop/releases)；迁移、复现和限制见 [官方桌面升级说明](docs/official-desktop-upgrade.md)、[最新验证记录](docs/test-report-0.5.0.md) 和 [ADR 0006](docs/adr/0006-official-desktop-baseline.md)。

## 0.5.0 官方桌面基线

采用官方工作台、Host、项目与会话管理、API 配置、插件格式及完整解释器/Office 运行时；社区层只负责中文默认值、自己的更新源与完整安装恢复。它不是官方签名发行包，候选安装包未签名（Authenticode: NotSigned），Windows 可能显示安全提示；不使用官方 nightly，也不把新运行时与旧桌面壳混用。2026-10-10 官方发布列表已有 0.2.1-alpha.2，本候选不会自动切换到 alpha。

恢复按“重试 → 禁用第三方插件 → 已校验完整稳定副本”有界执行，版本与数据槽配对回退。首次健康观察 45 秒后，还须完成约 1 GB 的物理快照和 SHA-256 校验，才能具备稳定副本恢复保障；没有完整副本或副本损坏时停止重试并保留记录。失败版本的新会话保留，不自动合并。全局 `.dsh` 和独立 Sub2API 目录不读取、不修改。

本地 Host 使用系统分配的回环端口，避免上游默认 19387 被其他程序占用时重试/回滚仍失败；认证、桌面转发与健康检查仍使用官方返回的连接地址。此修复已纳入源码与密封门禁，并在最终包并行健康及真实回退中复测，见 [ADR 0008](docs/adr/0008-loopback-ephemeral-host-port.md)。

看门狗在每次存活采样前检查本轮干净退出标记，修复 Windows 生产配置下已完成官方清理却仍等待退出的问题。两轮欢迎页正常关闭均确认主进程和看门狗自行退出、无重启且载荷不变；正常用户退出仍不在可取消的 before-quit 提前写标记，不添加新的强制退出路径。工作台原生菜单退出与欢迎页关闭不同，仍须人工验收，见 [ADR 0009](docs/adr/0009-watchdog-clean-shutdown-handshake.md)。

Windows x64 开发与构建：

```powershell
npm ci
$env:DSH_OFFICIAL_SOURCE = 'C:\DSHB\harness-020rc2'
npm run verify
npm run dist:official
```

正式安装包的发行版本来自 `official.lock.json`，而根 package 的 0.4.0 仍是保留的旧壳工具版本。默认 `dist:win` 已指向官方构建，本候选分支的 GitHub 工作流使用官方构建并要求隔离安装/真实恢复资格测试，仅保存安装器与 blockmap 构建产物，不自动发布 Release 或 latest。仅完成完整准备后可用 `--stage-only` 复用经校验资源；仅封装安装器可用 `dist:official:repackage`，不会跳过载荷门禁，也不会主动上传。

当前候选的原生目录选择使用官方 Electron 对话框，不再运行旧 Win32 folder dialog worker。真实对话框交互仍须验收，不把单测等同于本机点击通过。模型配置沿用官方入口；没有真实模型负载测量，因此不宣称 token 节省百分比。

### 稳定晋升前的人工门槛

按照 [本机人工验收操作单](docs/manual-acceptance-0.5.0.md) 完成两轮原生文件夹选择与工作台菜单退出后，才能填写 [本地记录模板](docs/stable-readiness.example.json) 的副本。模板默认全部未测试，不能提前填入通过。只读检查命令：

```powershell
npm run qualify:stable:automatic
npm run qualify:stable
```

前者再次核对同一成品的自动安装、恢复与界面报告；后者要求 `.official-build/stable-readiness.json` 中有同一安装器哈希的两轮维护者人工声明。缺少记录、失败、未测试或绑定错误都会阻止就绪判定。人工声明不是实机点击的自动证明，检查通过也不构成发布授权；两条命令都不会启动桌面程序、读取账号或改写 GitHub/更新通道。

此 CI 保护属于候选分支的新增改动，仍需 PR 审核合并；没有直接修改 `main` 或历史引用上的工作流，不代表仓库所有旧标签的发布规则已全局关闭。现有 0.5.0 候选安装器及其测试证据保持不变，0.4.0 仍是稳定版。

## 0.4.0 旧监督壳历史说明

以下只适用于已发布 0.4.0，不是 0.5.0 的构建命令或数据布局。历史旧壳构建使用显式 `dist:legacy`。

面向 Windows 的 DeepSeek Harness 桌面管理器。它不是对 Harness 的分叉，而是把官方 `@deepseek-ai/dsh` 作为可替换运行时，由一个独立桌面监督层负责启动、健康检查、升级、回滚和诊断。桌面版使用独立的托管 profile 目录，保持 DSH profile 与插件格式兼容，同时避免全局 `~/.dsh` 中的旧插件破坏恢复基线。

当前恢复地板锁定为在独立托管 profile 上验证可用的 `@deepseek-ai/dsh@0.1.1-rc.2`；稳定通道会发现 npm `latest`，但只有通过完整候选预检和观察期才会晋升。2026-09-22 对 `0.1.5-rc.2` 的独立安装验证发现上游 Web 插件树缺少运行时依赖，本桌面版会拒绝激活该候选并继续运行稳定版；这不是已验证可用的升级。预览通道可以发现 alpha 版本，但默认不会自动安装。

Windows x64 安装包：[查看最新发布版](https://github.com/pyljjun2009-sketch/deepseek-harness-desktop/releases/latest)。安装包未签名；安装前可对照 Release 发布说明中的 SHA-256 校验值。

## 本地运行

```powershell
npm install
npm run dev
```

旧壳生产验证与 Windows 安装包：

```powershell
npm run verify
npm run dist:legacy
```

安装包级压力测试可运行 `npm run pack` 后执行 `npm run stress:packaged`；轮次与并发数可由 `DSH_STRESS_ROUNDS`、`DSH_STRESS_CONCURRENCY` 和 `DSH_SUPERVISOR_ROUNDS` 调整。最近一次多轮结果与覆盖限制见 [压力测试记录](docs/stress-test-2026-09-23.md)。

安装包会生成在 `release/`。卸载时不会删除用户数据或恢复记录。为防止 Windows 长路径造成依赖文件缺失，安装器使用默认目录，并拒绝长度超过 74 字符的安装路径；默认用户路径过长时可用 NSIS 的 `/S /D=C:\DSHDesktop` 参数安装到短路径。当前安装包未做代码签名；Windows 可能显示 SmartScreen 提示。

## 恢复模型

1. 桌面进程启动官方 DSH Web profile，并只监听 `127.0.0.1` 的随机端口。
2. 新版本先安装到独立候选目录，不覆盖当前版本。
3. 下载后的 CLI 与 Web HTTP 先在临时空数据槽检查；停止旧运行时后复制活动数据槽，候选在副本上再次通过配置合成与 HTTP 存活检查。预检失败不会切换当前版本。
4. 候选版本完成观察期后才成为 `lastKnownGood`。
5. 运行时异常时先关闭省 token 配置重试；若候选仍失败，则同时切回上一稳定版本及其数据槽。失败候选槽保留以便人工找回期间产生的会话，自动回滚不会合并这些数据。
6. 稳定运行时连续崩溃时，桌面监督器指数退避重启；非捆绑运行时无法恢复时，回落到捆绑版本。
7. 正式安装包会运行一个轻量外部看门狗；桌面主进程非正常退出时，看门狗重新拉起应用。

桌面版始终挂载 DSH 自带的应用内目录浏览器，替代 `0.1.1-rc.2` 在 Windows 上会提前退出的原生文件夹选择进程。此兼容层与省 token 开关相互独立；升级候选仍需通过配置合成与 Web 预检。默认只监听本机回环地址，不应把 Web 端口公开到局域网或互联网。

## 数据边界

- 全局 DSH 数据：`%USERPROFILE%\.dsh`，桌面版不读取或改写。
- 桌面状态：Electron `userData/recovery/state.json`。
- 独立运行时：Electron `userData/runtimes/<version>`。
- 托管配置与会话：默认稳定槽为 Electron `userData/harness-home`；升级后的隔离槽为 `userData/profile-homes/slot-*`（不读取或改写全局 `~/.dsh`）。
- 升级安装器：随应用锁定发布的 npm，不依赖系统 PATH 或全局 Node.js。
- 日志：Electron `userData/logs/desktop.log` 与 `harness.log`。

桌面管理器不会解析或显示 `.credentials.yaml` 的内容；升级时会把托管数据槽整体复制到本机候选槽，因此其中的凭据文件也会随之复制。临时下载目录不承载用户凭据，失败候选槽默认保留，请按本机敏感数据对待。

## 省 token 模式

默认启用、可在中文界面关闭。仅通过官方 DSH 内置组件裁剪过长工具输出、提前压缩长会话，并关闭需要额外模型调用的会话标题生成；不覆盖用户选择的模型或凭据。失败时先自动关闭优化层并尝试原生配置。相关竞品对照、配置边界与测试结果见 [docs/token-optimization.md](docs/token-optimization.md)。

## 官方设计依据

- DeepSeek V4 原生支持 Responses API，并针对 Codex 适配；模型与接口通过运行时层选择，不写死进 UI。
- Codex 的 workspace sandbox、审批策略与 `AGENTS.md` 思路被映射为“最小 IPC + 项目规则 + 明确权限边界”。
- Claude Code 的可恢复会话、权限模式、后台会话与可组合工具思路被映射为“任务运行时独立于桌面壳”。

官方 DeepSeek Harness 现在也有自己的 [Desktop 设计](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)。本项目定位为独立的恢复优先监督壳，而非其官方桌面版；运行时独立升级的兼容性风险高于官方的壳与运行时绑定更新。详细设计、热门项目对照与取舍见 [docs/architecture.md](docs/architecture.md)、[docs/popular-projects.md](docs/popular-projects.md) 和 [docs/adr](docs/adr)。
