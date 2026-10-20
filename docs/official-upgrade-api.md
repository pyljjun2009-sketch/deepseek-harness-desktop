# 官方升级接口 v1

本项目固定官方桌面包与官方源码的同一版本，再重构社区恢复版；不会把官方安装器直接运行在社区版安装目录中。官方包有不同的应用身份和数据管理约定，直接覆盖会丢失社区恢复入口。此接口不读取账号、API 密钥或全局 `.dsh`，不包含安装器执行权限。

## 已接通的操作

| 操作 | 实现 | 限制 |
| --- | --- | --- |
| 检查 | `createOfficialUpgradeProvider().check({ baselineVersion, allowPrerelease })` | 只读固定 Windows x64 HTTPS 更新源；预览版默认不允许自动采用 |
| 下载 | `provider.download(descriptor, physicalCacheDirectory)` | 固定官方域名和版本化路径；大小与 SHA-512 必须一致；不覆盖并发出现的缓存 |
| 本地校验 | `provider.verify(absoluteFile, descriptor)` | 物理文件、大小与摘要；拒绝链接、UNC/设备路径；摘要不替代签名检查 |
| 升级准备 | `provider.prepare(descriptor, baselineVersion)` | 拒绝降级，返回完整重构与资格测试要求；不执行 shell 或安装器 |

`interfaceVersion: 1`、provider、平台、架构、完整版本、URL、SHA-512、大小和发布时间组成升级描述。解析器只使用这些已验证字段，忽略的发行说明不进入 UI、命令或配置。协议或目标平台变更需要新适配器和测试，不能把新格式静默解释为旧格式。

## 开发命令

```powershell
npm run upgrade:official:check
npm run upgrade:official:download
npm run upgrade:official:plan
```

检查命令以本项目 `official.lock.json` 的官方基线比较，不检测本机已安装桌面的版本。下载命令只下载锁中固定的官方包，不因为远端出现更新版本就修改锁。清单请求限制 32 KiB；下载最多 1 GiB，传输有限时，重定向被拒绝。缓存损坏时报告失败并保留现有缓存，不自动删改未知文件。

官方包的入口清单位于 `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`。截至 2026-10-19，固定包是 `0.2.1-rc.2`，对应官方源码提交 `687f282e8625c6b8d11ff58211a90524be2e4317`、pnpm `11.28.5`、Electron `44.7.0`。它仍是候选版本；社区 `0.6.0` 的新成品必须完成独立资格测试，不能继承 `0.5.0` 成品的通过记录。[官方版本记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)

## 与现有更新/恢复流程连接

```text
官方清单 → 验证描述 → 下载固定包 → 大小/SHA-512/人工签名核对
                                  ↓
同版本固定源码 → 社区薄适配 → 完整运行时与安装器 → 同成品资格测试
                                                    ↓
                                        人工原生交互验收 → 另行审阅发行
```

已安装社区版的“检查更新”继续使用官方 `DesktopUpdateCoordinator` 和本项目固定 GitHub `latest` 源。新源码提供的 `dshDesktopUpdateChannel` 在社区清单中明确设为 `latest`；不再改写上游协调器的通道逻辑，也不接入官方 nightly 自动安装。现有完整安装事务、健康观察、版本/数据槽配对和有界回退保持独立，准备计划不能绕过它们。

未来 UI 或自动化调用方只能消费此受限接口。增加安装动作时必须复用现有社区安装器和资格门槛，不能向渲染器暴露原始 IPC、任意下载地址、文件路径或命令执行。接口返回的 `automaticInstallAllowed: false` 不是可由调用方忽略的提示，当前提供者没有 `install` 方法。

## 后续官方升级接入

1. 显式检查官方 feed，审阅官方同版本发布和源码提交；不能把 RC/alpha 当作稳定版。
2. 同步修改 `official.lock.json` 的源码与包描述、工具链版本，重新适配薄补丁；旧安装包、索引和成品证据保留。
3. 下载固定包并校验，再由维护者显式运行 `node scripts/build-official.mjs --refresh-runtime-lock --package --unpacked`。此选项只用于基线迁移，且必须先通过缓存中固定官方包的摘要验证；新生产锁只在完整运行时及壳准备成功后才写回。
4. 审阅新生成的 `official-runtime.lock.yaml` 后，后续普通 `npm run dist:official` 继续使用冻结生产锁；不得通过关闭校验来接受变动 tarball。
5. 重新封装并绑定最终载荷/安装器摘要，执行隔离安装、真实崩溃恢复、中文 UI、正常退出及两轮原生人工验收。旧版通过记录不能自动授权新版。
6. 另行审阅社区发行；本接口不发布 Release、不写 latest，也不改已安装应用。

默认源目录应使用短的物理路径，例如 `C:\DSHBuild\harness-021rc2`；现有源目录可由 `DSH_OFFICIAL_SOURCE` 明确指定。只有构建源码定位会解析既有路径的真实位置；下载缓存、候选载荷、恢复与安装器 QA 始终拒绝链接祖先。新 QA 目录在 `C:\DSHNative` 下，避免把迁移后的历史 junction 当成新测试根。
