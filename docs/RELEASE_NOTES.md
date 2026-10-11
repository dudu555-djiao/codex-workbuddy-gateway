# Agent Hub v0.7.0

不同项目可通过工作台、HTTP、JavaScript SDK、CLI 或统一 MCP 调用真实桌面 WorkBuddy，自动准备项目目录对应的原生会话，不必由 Codex 逐步指挥，也无需 Computer Use 或手动为每个项目新开聊天。

- 持久任务队列、幂等提交、全局并发与同目录串行，重启后恢复原任务，不确定派工不自动重放。
- 文本、JSON 和文件结果；分轮次结果、原会话返工、协作取消，以及独立内容验收记录。
- 本机回环服务和用户级常驻服务，保留既有 WorkBuddy 默认绑定与旧 MCP 任务。
- WorkBuddy 执行官 Skill 新任务优先走 Agent Hub；已有直连任务继续用原编号恢复。
- 独立 DeepSeek Harness 桥接及 Skill 保留，尚未加入聚合接口；qodex 尚未接入。

本机构建与157项自动化测试通过。真实 WorkBuddy 已验证 CSV 月度汇总、原会话返工、任务领取后的平台重启，以及自动目录中的独立文本任务；业务结果经实际内容检查。

积分余额、逐任务消耗及免费积分扣减归属尚未知；模型沿用 WorkBuddy 原生设置。当前是 macOS 本机单用户服务，未实现多账号或公网访问。完整使用条件与验证边界见 README、docs/AGENT_HUB.md 和 docs/USER_ACCEPTANCE.md。

下载选择：

- `codex-workbuddy-gateway-v0.7.0.zip`：完整项目，首次安装或升级平台使用。
- `workbuddy-executor-v0.7.0.zip`：仅含 WorkBuddy 操作 Skill，需要已有兼容平台或 MCP。
- `deepseek-executor-v0.7.0.zip`：保留的独立 Harness 操作 Skill，需要已有 MCP 与原生插件。
- 对应 `.sha256` 和完整项目 manifest 用于核对包内容。所有包排除 `.env`、私有令牌、任务库、会话记录及本机成果。
