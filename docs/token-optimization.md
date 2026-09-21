# DeepSeek token 优化取舍

本桌面版将稳定和可恢复性置于省 token 率之上。它默认启用 [官方 DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 已包含的 `tool-result-pruner`、`compaction-basic` 与 `command-compact`，再关闭额外调用模型的 `session-title-llm`。配置见 [`config/token-saving.patch.yml`](../config/token-saving.patch.yml)。这层配置可在界面关闭；运行时失败时会自动关闭后重试，不会改动用户模型选择和 API 密钥。

## GitHub 同类项目对照

| 项目 | 可借鉴做法 | 本版取舍 |
|---|---|---|
| [dsh-token-optimizer](https://github.com/Zoria-Lind/dsh-token-optimizer) | 分层工具输出压缩、MCP 工具延迟加载、长会话压缩、节省统计 | 采用“先控长输出和上下文”的思路；暂不注入第三方钩子、图像摘要或权限较高的插件，以降低版本兼容风险 |
| [dsh-memory-toolkit](https://github.com/123caiji/dsh-memory-toolkit) | 跨会话记忆、分层压缩与上下文治理 | 暂不改变记忆语义和模型路由，避免恢复后行为不一致 |
| [dsh-token-pet](https://github.com/Jimmy0123-ux/dsh-token-pet) | token 用量可视化和提示词优化 | 暂不引入额外常驻界面或插件依赖 |

第三方仓库声称的节省比例属于各自项目的测量或估算，不代表本桌面版的实际效果。

## 本版验证范围

- 单元测试以约 24,000 字符的重复工具输出为样本，验证官方裁剪器保留首尾且输出少于原文 30%。这是字符量测试，不是 API 计费 token 节省率。
- 候选版本需通过 CLI、配置合成、HTTP 启动和观察期；优化配置出错时先退回原生配置。
- 目前未完成真实用户多会话 API 账单 A/B 测试；实际节省会随输出长度、会话历史和模型计费规则变化。
