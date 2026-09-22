# 高关注项目架构对照（2026-09-22）

这里借鉴的是公开仓库中可核实的架构边界，不把 GitHub star 数当作设计正确性的证明，也不复制闭源或未公开实现。star 为 2026-09-22 从 GitHub 仓库 API 读取的快照，会持续变化；同一批高关注项目还包括 [OpenHands](https://github.com/OpenHands/OpenHands)（88,744）。

| 项目 | stars 快照 | 公开设计中与本项目相关的点 | 本项目的取舍 |
|---|---:|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) | 232,321 | Cordis 插件树、profile/bundle/patch 分层；官方已有 [Desktop 设计](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)，其壳和运行时作为签名版本单元 | 不重写 agent loop、模型适配或工作台；保持官方 Web profile，桌面层只承担独立数据槽、监督、升级和回滚。我们的独立运行时升级是不同于官方 Desktop 的选择，须承担额外兼容风险 |
| [OpenCode](https://github.com/anomalyco/opencode) | 209,154 | 多界面接同一能力层，规划/执行模式与扩展能力在运行时演进 | 不在桌面壳硬编码模型能力或提示词；以 DSH profile/patch 扩展，避免跟上游竞争维护同一核心 |
| [Claude Code](https://github.com/anthropics/claude-code) | 147,468 | 官方仓库公开 CLI、权限及扩展的用户入口；核心架构并未完整公开 | 仅参考可观察的会话恢复与权限体验，不推断其未公开内部实现 |
| [Codex](https://github.com/openai/codex/tree/main/codex-rs/app-server) | 125,761 | 明确客户端与服务端边界，任务状态不应由 UI 页面缓存充当权威 | 工作台是 DSH 官方 Web UI；运行进程、健康和版本指针以桌面主进程为准 |
| [Cline](https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md) | 68,977 | 无状态 agent loop 与有状态会话/配置编排分层，宿主 UI 不直接管理底层存储 | 桌面 renderer 只发有限 IPC；运行时和恢复状态由主进程管理 |

## 由对照转化的实现

1. **运行时可替换，壳保持薄层。** DSH 的配置和插件继续由官方机制解析，桌面层不维护第二套 agent loop。
2. **持久状态有单一权威。** `RecoveryState` 存储 active、last-known-good、candidate 及其对应数据槽；UI 仅读取快照。
3. **失败边界覆盖数据。** 候选安装在临时槽预检；停止旧写入者后复制数据；候选在副本中烟测。回滚时两个指针同时恢复。
4. **真实打包环境验证。** 仅通过源码测试不足以覆盖 Electron Node 模式、Windows 目录联接及 DSH Web 鉴权；发布流程须运行打包版烟测。

## 未照搬的部分

没有把 Codex/Cline 的内部协议移植到 DSH，也没有承诺跨版本插件二进制兼容。官方 DSH Desktop 的签名更新、完整进程排空和原生插件修复比本项目目前更完整；这些差距必须继续以实测和明确的限制呈现，不能由高 star 对照推导出“同等级稳定性”。
