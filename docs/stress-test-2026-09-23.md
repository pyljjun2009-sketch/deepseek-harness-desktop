# v0.4.0 多轮压力与恢复测试（2026-09-23）

环境：Windows 10.0.26200、Electron 44.0.0、捆绑 DSH 0.1.1-rc.2。测试使用临时 DSH 数据槽与本机回环地址；未连接真实模型账号或消耗模型额度。

| 测试 | 轮次与负载 | 结果 |
| --- | --- | --- |
| 类型检查、单元测试、构建 | `npm run verify` | 7 个测试文件、25 项用例全部通过，Vite 与 Electron 主进程构建通过 |
| 打包后功能回归 | `npm run smoke:packaged`，连续 3 轮 | 3/3 轮通过目录选择器、Web 启动、坏候选拒绝、数据槽隔离、候选回滚和稳定版恢复 |
| 并发与故障恢复 | 10 轮；每轮初始与恢复 Web 各 100 个并发请求 | 2,000/2,000 请求通过；10/10 轮恢复状态持久化正确 |
| 高峰并发与故障恢复 | 3 轮；每轮初始与恢复 Web 各 200 个并发请求 | 1,200/1,200 请求通过；3/3 轮恢复状态持久化正确 |
| 监督器自动恢复 | 两组并发测试各执行 3 次实际终止 DSH 子进程 | 6/6 次自动重启并重新在线 |

100 并发单阶段耗时为 63–371 毫秒；200 并发为 122–267 毫秒。这是本机回环请求阶段总耗时，不代表模型推理吞吐量或公网性能。压力过程中未发起模型推理请求。

本版本移除了桌面版内的可选外部账号工具集成及其打包文件。升级时只会清除旧桌面恢复状态中的废弃集成设置，同时保留活动运行时、数据槽、稳定版本和省 token 设置；不会访问或更改独立本地客户端目录及其账号配置。

复现命令：

```powershell
npm run verify
npm run dist:win
npm run smoke:packaged
$env:DSH_STRESS_ROUNDS='10'
$env:DSH_STRESS_CONCURRENCY='100'
$env:DSH_SUPERVISOR_ROUNDS='3'
npm run stress:packaged
$env:DSH_STRESS_ROUNDS='3'
$env:DSH_STRESS_CONCURRENCY='200'
npm run stress:packaged
```

限制：测试覆盖本机 Windows 打包运行时和恢复行为，不包含真实模型输出正确性、真实订阅账号配额调用，也未在另一台全新 Windows 设备上完成图形安装器交互验证。
