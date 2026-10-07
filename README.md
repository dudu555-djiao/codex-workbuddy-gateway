# Codex → WorkBuddy Personal Gateway

这是面向个人账号的路线 A：Codex 通过 MCP 调用本机桥接器，桥接器把 ACP 请求发送到 WorkBuddy 桌面端当前打开的 interactive 对话，并把回复返回给 Codex。它不依赖 WorkBuddy 开放平台的企业硬件接入，也不要求 `client_id` 或 `client_secret`。

推荐使用 `WORKBUDDY_BACKEND=desktop-acp`。它复用当前桌面会话，因此 WorkBuddy 窗口会实时显示 Codex 发出的任务。`gateway` 仍可作为隐藏 Host 的兼容备用路线，但不会绑定可见的当前对话。

WorkBuddy 桌面安装包当前带有 CodeBuddy CLI。WorkBuddy 启动后会创建一个带当前个人账号登录态的本地 Gateway；本项目自动发现该服务的端口和认证信息，再通过 HTTP/SSE 转发任务和结果。

## Codex 可用的工具

- `workbuddy_health`：检查本机 WorkBuddy 桌面端是否存在可用的 interactive ACP 会话。
- `workbuddy_send_task`：向已登录的 WorkBuddy 启动一个任务。相同 `taskId` 不会重复发送。
- `workbuddy_get_task`：读取任务状态并同步 WorkBuddy 输出。
- `workbuddy_get_messages`：读取 Gateway 保存的执行消息。
- `workbuddy_continue_task`：把 Codex 的验收反馈发回同一任务，要求 WorkBuddy 返工并重新报告。
- `workbuddy_accept_task`：Codex 检查工作区、diff 和测试后，记录最终验收通过。
- `workbuddy_cancel_task`：终止本机 CLI 子进程并标记任务取消。

任务和消息写入 SQLite，默认是 `data/tasks.sqlite`。

## 个人账号安装步骤

先确认 WorkBuddy 已安装在默认位置：

```text
/Applications/WorkBuddy.app
```

然后在终端执行：

```bash
PROJECT_DIR="/absolute/path/to/codex-workbuddy-gateway"
cd "$PROJECT_DIR"

cp .env.example .env
npm install
npm run build
```

个人路线推荐配置是：

```ini
WORKBUDDY_BACKEND=desktop-acp
WORKBUDDY_ACP_PERMISSION_MODE=allow_once
```

在 WorkBuddy 桌面端先打开要接收任务的对话，并保持窗口运行。桥接器会扫描 `~/.workbuddy/sessions/*.json`，选择最新的 `kind=interactive` 会话，通过 `/api/v1/acp/connect` 和 `session/prompt` 投递任务。默认对每个权限请求只授予一次；纯只读审查时可设置 `WORKBUDDY_ACP_PERMISSION_MODE=deny`。

## 注册到 Codex

```bash
cd "$PROJECT_DIR"
codex mcp add workbuddy -- "$PROJECT_DIR/bin/workbuddy-gateway"
```

`bin/workbuddy-gateway` 会自动加载项目根目录的 `.env`，并把工作目录切换到 Gateway 项目根目录；`bin/workbuddy-cli` 用于首次登录。

如果自动发现失败，可以在 `.env` 中手动指定 WorkBuddy 本地服务：

```ini
WORKBUDDY_GATEWAY_URL=http://127.0.0.1:64523
WORKBUDDY_GATEWAY_PASSWORD=本机 WorkBuddy 进程提供的临时密码
```

## 第一次测试

先确保 WorkBuddy 桌面端已安装并保持运行，在 Codex 中输入：

```text
请调用 workbuddy_health，检查本机 WorkBuddy CLI 是否可用。
```

返回 `online: true` 后，再输入：

```text
请调用 workbuddy_send_task：

taskId: demo-20261006-001
objective: 检查当前项目的 Git 状态，并报告工作目录和未提交文件
workspace: /你的项目绝对路径
acceptanceCommands: ["git status --short"]
```

Codex 随后调用 `workbuddy_get_task` 或 `workbuddy_get_messages` 读取结果。Codex 应检查真实工作区、Git diff 和测试结果：需要修改时调用 `workbuddy_continue_task`，确认无误后调用 `workbuddy_accept_task`。WorkBuddy 的 `TASK_STATUS: completed` 只表示执行结束，不能替代 Codex 验收。

## 当前个人路线的边界

- 这是本机桌面端 Live Interactive ACP 桥接，不是 WorkBuddy 官方 Local Assistant Open API。
- ACP 连接依赖 WorkBuddy 当前版本的本地协议；升级 WorkBuddy 后若 `/api/v1/acp` 行为改变，需要更新桥接器。
- 必须先打开一个 interactive 对话；没有可见对话时 `workbuddy_health` 会返回 offline。
- WorkBuddy 升级可能改变本地 Gateway 的端口或协议；Gateway 会在健康检查中报告连接失败。
- 任务在 WorkBuddy 当前桌面会话中执行，使用 WorkBuddy 当前个人登录态。
- 终止工具会结束本机子进程；已经写入磁盘的修改不会自动回滚。
- 官方 Open API 后续如果对个人账号开放，可以设置 `WORKBUDDY_BACKEND=api`，再按 `.env.example` 配置 OAuth。

## 官方连接器能力的关系

WorkBuddy 的“连接器”是让 WorkBuddy 调用外部 MCP 或 CLI 的入口；它不是个人账号获得 Local Assistant Open API 的替代授权方式。[连接器文档](https://open.workbuddy.cn/docs/connector)

官方文档明确把本地助手 Open API 绑定到硬件接入或 Buddy 应用的第三方应用授权流程；个人账号无法直接从硬件接入创建这条 API 凭据。[第三方应用文档](https://open.workbuddy.cn/docs/third-party-app)

## 验证

```bash
npm test
npm run build
```

测试覆盖 API 客户端、业务错误、任务幂等、SQLite 消息去重和状态更新；MCP Server 也已通过 `initialize` 和 `tools/list` 握手测试。
