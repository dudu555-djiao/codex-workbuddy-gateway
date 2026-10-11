# 安装与恢复

此 Skill 需要配套项目中的 DeepSeek MCP 和 `deepseek-plugin` 原生插件。单独复制 Skill 不能建立连接。源码与本机安装步骤见项目 `docs/DEEPSEEK.md`；先定位已安装项目，保留已有 WorkBuddy MCP、Harness 模型、凭据和插件。

当前对话没有 `deepseek_*` 工具但 MCP 已注册时，读取 `codex mcp get deepseek --json` 的启动 command 定位项目（本项目入口为 `bin/deepseek-gateway`），只取需要的路径和运行环境，不回显整份配置。项目中已有 `scripts/deepseek-call.mjs`，它通过 SDK 连接同一个 stdio MCP 服务：

```sh
node "/实际项目目录/scripts/deepseek-call.mjs" deepseek_health
node "/实际项目目录/scripts/deepseek-call.mjs" deepseek_get_task @/绝对路径/arguments.json
```

参数文件是该工具的 JSON 参数，例如 `{"taskId":"已知任务编号","detail":"evidence"}`。沿用 MCP 注册的 Node 路径、`DEEPSEEK_DB_FILE`、Host 和注册目录设置；使用绝对参数路径可在其他工作目录调用。该客户端只建立 MCP 连接，仍由当前 Harness 原生会话执行，不另起模型或用 UI 发送任务。派工前持久保存固定 taskId 和参数文件；CLI 失败或超时时先查询原任务，不自动重复发送。MCP 确实未安装或能力版本过旧时按项目文档安装或升级，不拼装另一套临时执行器。

运行 `deepseek_health` 检查插件注册的 Host，再用 `deepseek_list_sessions` 选择专用会话。注册文件包含本机连接凭据，只供连接程序读取，不把 token、完整注册文件、模型密钥或原始私人对话贴入聊天或公开成果。

插件运行在真实 Harness Host 内。App 退出时不可执行；重开后先重新发现同一 profile 的 Host，再核对原 sessionId 与原任务。不同 Host 同时加载同一个原生会话可能产生 writer-held；恢复原 Host，不能通过另起隐藏进程规避占用。

连接故障依次检查 App 是否启动完成、插件是否已加载、版本能力是否兼容和原会话是否存在。没有已执行证据时不宣称成功；发送结果不确定时保留任务记录并核对原生请求编号。不要读取模型凭据文件来伪造浏览器登录或修改原生日志。
