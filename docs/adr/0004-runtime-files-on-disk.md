# ADR-0004: 官方 DSH 运行时以普通文件随应用发布

## 状态

Accepted

## 背景

DSH 会在 `$DSH_HOME/profiles/node_modules` 中创建指向其依赖闭包的目录联接，让 profile 中的动态插件名称由 Node.js 正常解析。Windows 目录联接不能指向 Electron ASAR 内部的虚拟路径；若把 DSH 放进 ASAR，生成的联接存在但不可读取，稳定版会在启动时误报插件缺失。

## 决策

桌面管理器发布包不使用 ASAR，把官方 DSH 及其依赖作为普通文件放在 `resources/app/node_modules`。管理界面仍保持 Chromium sandbox、上下文隔离和最小 IPC；发布流程继续保留锁定依赖、哈希和后续代码签名边界。

## 后果

- DSH 的官方 profile 解析与插件依赖闭包可在打包版中原样工作。
- 外部 watchdog 和原生模块不需要额外解包路径映射。
- 安装目录不是防篡改边界；正式分发应配合 Windows 代码签名与受保护的安装目录。
