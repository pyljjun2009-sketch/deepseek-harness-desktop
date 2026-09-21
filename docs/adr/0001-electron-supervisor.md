# ADR-0001: 使用 Electron 监督官方 DSH 运行时

## 状态

Accepted

## 背景

需要 Windows 桌面体验，同时保留 DSH 的 profile、插件与后续升级能力。当前机器没有 Rust 工具链，而官方运行时本身是 Node.js 生态。

## 决策

使用 Electron；本地管理 UI 放在隔离 renderer，官方 DSH 作为独立子进程运行，由 main process 监督。

## 后果

### 正面

- 与 DSH Node 运行时一致，能够复用官方 npm 包。
- Renderer 故障不会直接带走 DSH，DSH 故障也不会破坏管理 UI。
- Windows 打包、自启动和看门狗实现直接。

### 负面

- 安装体积高于原生壳。
- 必须持续跟进 Electron 安全版本。

## 备选方案

- Tauri：体积更小，但引入当前环境不存在的 Rust 工具链，并增加 Node sidecar 打包复杂度。
- 直接修改 DSH Web：耦合官方前端，升级时冲突风险高。
