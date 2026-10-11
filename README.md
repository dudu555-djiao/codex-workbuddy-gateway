# Agent Hub：本机 Agent 执行工作台

当前版本 **v0.7.0**。目标是让不同项目、程序和 Agent 通过统一接口使用已有执行器。首期接入 **WorkBuddy**；DeepSeek Harness 原桥接保留，尚未加入聚合接口；qodex 后续单独确认接入。

已提供本机工作台、HTTP API、JavaScript 客户端、CLI 和统一 MCP。项目会话自动准备；任务、执行事件和返工记录持久保存；执行完成与内容验收分开。积分余额与消耗尚未接入，明确返回未知。

```sh
npm ci
npm run build
# 首次安装从 .env.example 创建 .env；升级时保留已有配置。
npm run skill:install
./bin/agent-hub install
./bin/agent-hub status
```

工作台默认地址：<http://127.0.0.1:18492/>。依赖现有 desktop-queue 配置、WorkBuddy 登录、权限及可用额度。

- [设计方案](docs/AGENT_HUB_DESIGN.md)
- [接入说明：HTTP / SDK / CLI / MCP](docs/AGENT_HUB.md)
- [v0.7.0 下载：完整项目与独立 Skill](https://github.com/dudu555-djiao/codex-workbuddy-gateway/releases/tag/v0.7.0)

下文为兼容保留的 WorkBuddy / DeepSeek 独立桥接说明。旧发布包不包含新的聚合平台。

---

# Codex → WorkBuddy / DeepSeek Harness

Codex 派任务、监督进度并独立检查成果，WorkBuddy 或 DeepSeek Harness 的原生会话使用自己的模型、工具和 Skill 实际执行。本机 MCP 保存任务、回报及同一会话的返工记录。

**v0.6.0 引入的兼容能力：WorkBuddy 按项目自动创建、复用和选择执行会话。** 调用 `workbuddy_ensure_workspace` 或派工时传入项目的绝对目录，即可通过原生接口准备该项目的独立会话；无需 Computer Use、手动新建聊天或逐项目粘贴安装指令。一个持久服务监督多个项目，保留旧绑定和已排队任务。首次登录与原生权限仍在 WorkBuddy 处理。下方 v0.5.0 发布链接和 v0.4.1 验证记录属于历史版本，不包含当前本地聚合平台。

## 多项目调用

每个项目提供自己的目录。工作区在这里指本地目录和其原生执行会话，不会自动创建 WorkBuddy 云端项目、团队空间或云端资源。

```javascript
workbuddy_ensure_workspace({workspace: "/absolute/project-a"})
workbuddy_ensure_workspace({workspace: "/absolute/project-b"})
workbuddy_send_task({workspace: "/absolute/project-a", objective: "实际任务及验收条件"})
```

`ensure_workspace` 创建或复用专用会话，不执行业务目标。传入同目录已有的 `sessionId` 可选择那个真实会话。选择变化只影响后续派工，旧任务及返工仍保持原会话；旧执行器仍由服务监督。`workbuddy_list_workspaces` 列出目录、会话、选择和原生注册状态。多项目已注册时，派工必须提供 `workspace` 或 `sessionId`，不会悄悄投到旧默认目录。队列仍拒绝远程修改模型；模型沿用 WorkBuddy 设置。

其他支持 stdio MCP 的 Agent 可以启动本项目的 `bin/workbuddy-gateway` 并调用相同接口。自己的程序也可使用命令入口（从任意目录调用脚本绝对路径）：

```sh
node /path/to/gateway/scripts/workbuddy-call.mjs workbuddy_ensure_workspace '{"workspace":"/absolute/project-a","detail":"brief"}'
node /path/to/gateway/scripts/workbuddy-call.mjs workbuddy_list_workspaces '{}'
```

创建前保存预留会话 ID，重复请求复用映射。连接中断或创建结果不确定时不会自动重建；可以核对原生历史，或明确选择一个已存在的真实会话。升级需构建并重新加载持久服务及 MCP；旧对话看不到新增工具时可使用上述脚本启动最新客户端。

**v0.5.0 新增 [Codex → DeepSeek Harness](docs/DEEPSEEK.md)**：独立的 `deepseek` MCP 0.1.1、原生 Host 插件及 `deepseek-executor` Skill，支持指定会话派工、恢复、返工、取消和验收。业务派工通过原生接口完成，不通过 Computer Use 操作聊天框。已在 macOS Harness App **0.2.0-rc.2** 实测文件任务、App 冷重启、原会话返工、订单汇总、等待输入与取消；网页 Host 未实测。当前项目127项测试和插件26项测试通过。

完整下载和两个独立 Skill 包见 [v0.5.0 发布页](https://github.com/dudu555-djiao/codex-workbuddy-gateway/releases/tag/v0.5.0)。新装用户下载完整项目；已有可用 MCP 和插件的用户可只更新对应 Skill。DeepSeek 安装步骤见 [Harness 文档](docs/DEEPSEEK.md)，下文保留 WorkBuddy 的配置与使用方法。

**v0.4.1 在 `desktop-queue` 上新增 macOS 持久服务：首次在真实 WorkBuddy 专用会话粘贴一次安装指令，之后按队列需要自动唤醒同一原生会话，空队列不调用模型。** 本轮在 WorkBuddy 5.7.6 实测通过桌面自行安装及 LaunchAgent 激活、自动文件任务、正常退出后普通方式重开、应用完全关闭后的自动启动、未开启调试端口时自动正常重启一次，以及回复结束后的同会话返工。四项小文件创建与一项返工的原生 Write/Read、Edit/Read、队列归属和真实内容均已核对，无 Computer Use；98 项自动化测试通过。用户登出再登录和系统重启未实测。本轮未测试业务搜索或视频；2026-10-08 的临时队列及官方价格查询记录仍保留，v0.2.0 的失败经过见 [失败复盘](docs/FAILURE_REVIEW.md)。

## 下载后能直接使用吗？

**首次使用需要本机配置；单独 Skill 只是操作流程，不包含连接 WorkBuddy 的程序。** 下载选择如下：

| 使用情况 | 应下载的内容 | 还需做什么 |
| --- | --- | --- |
| 首次使用或要使用 Agent Hub | 完整项目 `codex-workbuddy-gateway-v0.7.0.zip`，或含完整源码的仓库 | 安装依赖、构建、保留或创建 .env，再安装平台服务；WorkBuddy 须已登录 |
| 已有 v0.7.0 平台或兼容 WorkBuddy MCP | `workbuddy-executor-v0.7.0.zip` | 将解压后的 `workbuddy-executor` 放入 Codex 配置目录的 `skills/`；统一入口要求完整项目 v0.7.0，旧任务仍可走兼容 MCP |
| 已有 DeepSeek MCP 0.1.1 与兼容原生插件 | `deepseek-executor-v0.7.0.zip` | 保留独立 Harness 接入方式；该 Skill 随包分发，本版没有聚合 Harness 执行器 |

独立 Skill 包没有 `package.json`，不能在其中运行 `npm run skill:install`；该命令只在完整项目目录可用。要使用 `detail: brief`，Gateway 需为 v0.3.1 或更新版本；旧版没有该参数时 Skill 会使用兼容流程。

首次环境要求：macOS、能正常运行的 Codex（桌面版或 CLI；注册需可用的 `codex` 命令）、已登录且有模型可用额度的 WorkBuddy、Node.js 与 npm。本项目实测 WorkBuddy 5.7.6；Windows/Linux 和其他 WorkBuddy 版本尚未验证。个人用户不需要企业资质、WorkBuddy 开放平台应用、client_secret 或 OpenAI API key，使用自己 WorkBuddy 已有的模型和工具。

Codex 可以直接完成依赖安装、构建、Skill 安装和 MCP 注册。v0.6.0 使用 `ensure_workspace` 原生创建会话并在首次需要时安装持久服务；用户处理登录和原生权限。业务派工和返工自动走队列。电脑关机或用户登出时服务不能执行；下次登录恢复仍依赖有效登录、权限和兼容接口。保留的旧临时监听模式需要在监听结束后重新粘贴启动指令。

## WorkBuddy 执行官 Skill

这是让 Codex 采用固定分工的操作说明：WorkBuddy 执行与自检，Codex 精简派工、必要核对和返工。v0.7.0 新任务优先使用 Agent Hub，兼容已有 WorkBuddy MCP 任务。按当前业务项目目录自动准备原生会话，不使用 Computer Use。

在完整项目目录安装：

```bash
npm run skill:install
```

安装到 Codex 配置目录下的 `skills/workbuddy-executor`（通常为 `~/.codex/skills/workbuddy-executor`）；已有不同版本会保留备份。统一 MCP 注册方式见 [Agent Hub 说明](docs/AGENT_HUB.md)；当前对话尚未加载工具时可使用 `scripts/agent-hub-call.mjs`。重新打开对话后使用：

```text
使用 $workbuddy-executor，通过 Agent Hub 让 WorkBuddy 完成这项任务。你负责精简派工和必要验收，成果由 WorkBuddy 实际执行和交付。
```

Skill 的规则见 [SKILL.md](skills/workbuddy-executor/SKILL.md)。普通任务不重复读取全量日志或独立重做整套搜索。九个任务/状态工具支持 `detail: brief`；默认仍为 `full`，兼容旧调用。brief 保留身份、状态、阻塞、成果路径与最多2000字符的最新回报，明确标记截断；它不改变本机完整记录，也不替代独立验收。这里减少的是返回上下文，没有实测整个任务的 token 节省比例。

## 连接原理

```text
Codex → MCP → 本机任务队列 → 持久服务按需原生唤醒
                    ↑ 领取任务 / 回报
             桌面 WorkBuddy 专用会话
                    ↓
             自己调用工具完成实际工作
                    ↓
Codex 读取回报 → 检查实际文件 → 同一队列返工 → 验收
```

v0.6.0 使用 `ensure_workspace` 原生创建或复用会话，并在首次需要时安装 `bin/workbuddy-service` 用户级 LaunchAgent。服务保存各项目的会话和目录映射，监看持久队列，通过仅回环 CDP 连接原生 MessageChannel RPC，以 `session:sendMessage` 发送队列唤醒消息；实际任务仍由对应原生会话运行 `bin/workbuddy-worker claim/report`。无需逐项粘贴，也无需维持模型空等。

这不是调用官方本地助手 API，也不是把 WorkBuddy 内置 CLI 当作桌面端。helper 只传递数据，不启动另一个模型，不代写成果。它检查调用进程来自 WorkBuddy 桌面应用，核对声明的会话存在于原生历史，并用每轮独立领取凭证校验回报。会话编号仍需与启动指令所在的真实对话核对；这些检查不等于证明每个回报里的描述都正确。

持久服务在存在待领取任务且专用会话空闲时唤醒它；无任务时只在本机检查队列。正常结束回复后可等待下一次唤醒。已经领取的轮次若因应用崩溃中断，需要检查原会话和已有文件并明确处理，服务不会静默重执行。模型在 WorkBuddy 界面选择；队列路线拒绝远程修改模型。过程消息由 WorkBuddy 主动回报，Codex 仍需独立检查实际文件或来源。

## 配置

适用于 macOS，使用 Node.js 22.13.0 或以上（推荐 Node 24 LTS）、npm 和可用的 Codex CLI。[Node 官方文档](https://nodejs.org/api/sqlite.html)说明从 22.13.0 起本项目使用的 `node:sqlite` 不再要求额外实验开关。

公开仓库曾只提供 README 与旧 ZIP。下载后先确认完整源码目录里有 `package.json`、`src/`、`bin/`，并核对包内版本；旧 ZIP 不自动包含新修复。不要在仅有 README 的目录安装。

```bash
cp -n .env.example .env
npm ci
npm run build
npm test
npm run skill:install
```

在 `.env` 设置：

```ini
WORKBUDDY_BACKEND=desktop-queue
```

保留已有配置与任务记录。旧 `gateway` 或 `desktop-acp` 配置不会自动迁移；修改后需要重启对应 MCP 进程。

若 Node 只在交互式终端的 nvm 等环境中可用，桌面 Codex/WorkBuddy 可能找不到它。让 Codex 通过 `command -v node` 得到本机真实绝对路径，并在本机 `.env` 设置 `WORKBUDDY_NODE_BIN='实际路径'`；不要把这类机器专属配置提交 GitHub。文件路径带空格时必须加引号。项目目录需保留在稳定位置，移动后更新 MCP 注册路径。

注册到 Codex：

```bash
PROJECT_DIR="$(pwd)"
codex mcp add workbuddy -- "$PROJECT_DIR/bin/workbuddy-gateway"
```

若已有配置，先用 `codex mcp get workbuddy` 核对路径，不覆盖其他 MCP。重新打开 Codex 对话或重启 MCP，使新版工具生效。

## 原生准备持久执行会话

v0.6.0 默认直接调用 `workbuddy_ensure_workspace({workspace:"项目绝对目录"})`。原生接口初始化目录、创建和命名真实会话；桥接器核对原生注册后保存映射。首次没有服务时自动安装，已有服务则增加项目映射，保留原默认绑定。此流程不要求用户先开聊天或粘贴指令。

以下为 v0.4.1 兼容流程，仅在明确使用旧版或临时模式时参考：

1. 在 WorkBuddy 中打开专用会话，先发一条普通消息，使其进入原生历史。
2. Codex 调用 `workbuddy_health`。`workerCandidates` 是历史会话候选，**不表示正在监听**。按真实会话与工作目录选择编号，不能随意取最新项。
3. 调用 `workbuddy_prepare_worker({sessionId: "选定编号", persistent: true})`，将返回的完整 `prompt` 一次粘贴到那个真实 WorkBuddy 对话。该工具只生成安装指令。
4. WorkBuddy 用自己的 Bash 运行 `bin/workbuddy-service install --session-id ... --workspace ... --cdp-port 18491`。服务在需要时自动启动原生应用，或等会话空闲后正常重启一次以启用端口，这两种场景本轮均已实测，不要求用户手工反复重启。核对 `./bin/workbuddy-service status` 与会话绑定，登录或权限请求由用户处理。
5. 向该 `sessionId` 派小任务，并验证真实文件、同一会话返工、正常退出重开后的自动领取和最终验收。`health.ready` 表示当时有 helper 等待，不是持久服务已安装的判断。

需要临时队列时，省略 `persistent: true`。该模式只生成本次监听 prompt，连续有限空等或退出应用后需重新启动。持久服务可用 `./bin/workbuddy-service status` 检查、`./bin/workbuddy-service uninstall` 卸载；保留任务记录，具体说明见下列文档。

完整步骤和限制见 [桌面队列执行会话](docs/QUEUE_WORKER.md) 与 [Codex 监督工作流](docs/CODEX_WORKFLOW.md)。`./bin/workbuddy-doctor` 只读检查环境与当前监听状态，不派任务。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `workbuddy_ensure_workspace` | 按目录原生创建、复用或选择执行会话 |
| `workbuddy_list_workspaces` | 列出各项目绑定和当前选择 |
| `workbuddy_health` | 检查监听器，列出原生历史候选 |
| `workbuddy_prepare_worker` | 生成选定会话的临时监听或一次性持久安装指令 |
| `workbuddy_send_task` | 保存唯一任务并排队；不代表已执行 |
| `workbuddy_wait` / `workbuddy_get_task` | 读取当前轮次进展与回报 |
| `workbuddy_get_messages` / `workbuddy_list_tasks` | 恢复已有任务和历史 |
| `workbuddy_continue_task` | 保留原目标、约束和会话，发送验收反馈 |
| `workbuddy_accept_task` | 保存独立检查的证据与验收结论 |
| `workbuddy_cancel_task` | 请求停止；不保证桌面动作立刻停止 |
| `workbuddy_respond_task` | ACP 兼容路线的输入响应；队列权限在 WorkBuddy 界面处理 |

同一 `taskId` 重复提交不会重复派工。队列使用 `sessionMode: existing`，传 `workspace` 时先自动准备该目录的会话再派工；若指定 `sessionId`，其原生目录必须匹配。不支持 `model` 参数。默认任务期限 30 分钟，单次 `wait` 最长 55 秒。超时或断线不会自动重发。

`queued` 是等待领取，`working` 是领取后执行，`needs_review` 是 WorkBuddy 回报结束，`accepted` 才是 Codex 检查后记录通过。队列与 MCP 重启后可以恢复记录；已安装的持久服务负责原生 WorkBuddy 唤醒，不自动唤醒已经退出的 Codex。

## 给 Codex 的配置提示词

```text
请读取这个项目的 README、docs/QUEUE_WORKER.md 和 docs/CODEX_WORKFLOW.md，
帮我在本机配置 Codex 指挥桌面 WorkBuddy 的 desktop-queue 路线。
直接完成你能做的依赖、构建、测试、配置和 MCP 注册，保留原文件及其他 MCP。
需要我登录、解锁或处理原生权限时，只告诉我当前那一步。
使用 v0.6.0 的 ensure_workspace 按业务项目目录原生创建或复用执行会话，
并在派工时明确传入 workspace；不要使用 Computer Use，也不要要求我手动创建聊天或粘贴安装指令。
只有历史记录或排队受理不算连接成功；必须看见桌面 WorkBuddy 实际领取并完成任务。
用创建小清单、同一会话返工和正常退出重开后自动领取来验证，不做视频。
你只派工和检查，不代替 WorkBuddy 写测试成果，不上传我的配置和任务记录。
遇到无法唤醒、权限或回报阻塞时如实说明，不能宣称已经跑通。
```

## 本地打包

```bash
npm run build
npm test
npm run package
```

打包白名单包含源码、编译产物、测试、启动器、文档、示例配置、Harness 原生插件及两个 Skill，输出完整项目 ZIP、SHA-256 与文件清单；另输出仅含四份指令文件的 `workbuddy-executor-v版本.zip` 和仅含两份指令文件的 `deepseek-executor-v版本.zip`。独立 Skill 包不包含 MCP 或插件。排除 `.env`、`data/`、日志、会话记录、Cookie、工作成果、其他个人 Skill 和 `node_modules`。打包命令只生成本地文件。打包内容检查不能保证任意未来代码不带隐私，分享前仍应核对文件清单。

保留 `desktop-acp`、`cli`、`gateway` 和官方 `api` 兼容实现作历史用途；桌面监督只接受声明支持的桌面路线。当前 Mac 主路线是任务队列，持久服务在其上提供按需原生唤醒。98 项自动化测试及本轮四项小文件创建、一项返工均通过，覆盖运行中派工、正常重开、完全关闭自动启动与裸启动后自动启用端口。用户登出再登录和系统重启未实测；业务搜索、视频及复杂长任务不在本轮验证范围。WorkBuddy 升级后需重新核对原生 RPC 兼容性，不能保证所有未来版本可用。已有 Codex MCP 进程需重新加载新版。
