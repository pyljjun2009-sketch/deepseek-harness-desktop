# ADR-0003: 管理 UI 使用最小权限 IPC

## 状态

Accepted

## 背景

桌面壳能够启动命令和打开本地服务，若 renderer 获得 Node 或任意 IPC 能力，XSS 的影响会扩大为本机代码执行。

## 决策

启用 `contextIsolation`、Chromium sandbox 和 `nodeIntegration: false`；preload 只暴露固定参数的命令。工作台窗口不注入 preload，不允许任意导航或新窗口。

## 后果

### 正面

- UI 漏洞无法直接访问文件系统或 shell。
- 权限面可审计、可测试。

### 负面

- 新功能必须显式增加 IPC 合约。
- 不能在 renderer 中直接调用 Node 库。

## 备选方案

- 直接暴露 `ipcRenderer`：灵活但安全边界不可控。
- `<webview>` 嵌入 DSH：攻击面与生命周期更复杂，因此使用独立受限窗口。
