# 首次连接、持久服务或临时监听恢复

仅在 MCP 缺失、首次安装或连接异常时读取。日常任务使用 SKILL.md 的精简派工流程。持久服务与临时监听使用不同恢复方式，先核对现有安装。

## 项目未配置

定位用户本机完整的 Codex → WorkBuddy Desktop Bridge 项目，目录应包含 `package.json`、`src/`、`bin/` 和本 Skill；不要猜用户路径或把只有 README 的目录当完整项目。

新用户需要下载完整项目，独立 Skill ZIP 不含 Gateway、依赖或 MCP 配置。只有已有可用 Gateway 的用户，才直接把独立 ZIP 中的 `workbuddy-executor` 文件夹放入 Codex 配置目录的 `skills/`（通常 `~/.codex/skills/`）；不在独立 Skill 目录执行 npm 安装命令。

本项目目前适用于 macOS，v0.4.1 已在 WorkBuddy 5.7.6 实测桌面安装及 LaunchAgent 激活、运行中派工、普通重开、完全关闭自动启动、裸启动无端口时自动正常重启一次，以及回复结束后的同会话返工。四项小文件创建、一项返工和 98 项自动化测试通过；登录恢复及系统重启未实测。确认 WorkBuddy 已登录且所选模型可用，Node.js 至少22.13.0（推荐24 LTS）、npm 与 `codex` 命令可用。个人队列路线不需要企业资质、开放平台应用或 API key；持久模式需要完整 Gateway v0.4.1，独立 Skill ZIP 不能代替它。

在项目目录核对 README 和本地配置，完成能直接执行的步骤：

```sh
npm ci
npm run build
npm test
npm run skill:install
```

从 `.env.example` 创建缺失的 `.env`，保留已有配置和任务库。队列主路线需要 `WORKBUDDY_BACKEND=desktop-queue`，不需要官方企业应用凭据。不要读取登录 token 或 Cookie 来绕过连接。

若桌面应用找不到终端里的 Node，使用 `command -v node` 查本机路径，在本机 `.env` 填入带引号的 `WORKBUDDY_NODE_BIN='实际绝对路径'`。不要公开本机 `.env`。不要随意移动已注册的项目目录，移动后需要更新 MCP 路径。

用 `codex mcp get workbuddy` 核对现有注册。缺失时在实际项目目录运行：

```sh
PROJECT_DIR="$(pwd)"
codex mcp add workbuddy -- "$PROJECT_DIR/bin/workbuddy-gateway"
```

更新注册后需要重新加载对应 MCP 或新开 Codex 对话，新版 `detail: brief` 参数才生效。只注册桥接器不代表桌面已连接，不覆盖无关 MCP。Skill 安装命令为 `npm run skill:install`；独立 Skill 包不包含 Gateway，仍需完整项目和已配置的 MCP。

## 首次安装持久服务

1. 先恢复已有任务；`working` 时没有等待中的 helper 是正常情况，继续等该任务，不重启。确实没有活跃执行任务且监听未启动时，让用户在 WorkBuddy 登录，打开专用对话并发一条普通消息，使会话进入原生历史。只在确实缺少这一步时要求用户完成。
2. 调用 `workbuddy_health(detail: brief)`，核对候选 sessionId 和实际工作目录。多个候选不确定时让用户指明；不自动选最新会话。
3. 调用 `workbuddy_prepare_worker({sessionId, persistent: true})`，把完整 prompt 交给用户一次粘贴到同一个真实 WorkBuddy 专用会话。本工作流不通过 Computer Use 代粘贴；指令生成本身不代表已安装。
4. WorkBuddy 自己用 Bash 运行生成指令中的 `bin/workbuddy-service install --session-id ... --workspace ... --cdp-port 18491`。这次授权用于安装本项目用户级 LaunchAgent 与会话绑定；后续业务任务仍不得改桥接配置或写记忆。服务在需要时自动启动应用，或等会话空闲后正常重启一次以启用端口，这两种场景已实测，不要求用户反复手工重启。登录及原生权限请求由用户处理，不在执行中任务上强行重启。
5. 用 `bin/workbuddy-service status` 核对安装状态、sessionId/workspace。服务使用 `RunAtLoad` / `KeepAlive`，通过启动调试环境与仅回环 CDP 连接原生 MessageChannel RPC，用 `session:sendMessage` queuewake 唤醒绑定会话；原会话仍通过 helper 实际执行。无空闲模型轮询，不读取登录凭据或修改 `app.asar`。
6. 指定该 sessionId 和匹配的 workspace 派工，等待真实领取与回报，再验证同会话返工、正常退出重开后无需 bootstrap 自动领取。安装成功、候选历史或 `queued` 都不能证明业务执行。

## 已安装持久服务

先恢复已有 taskId 和服务绑定，不再次要求粘贴安装指令。匹配服务已安装且心跳有效、没有 helper 等待时，health 返回 `persistent_service_idle`；`ready` / `online` 保留 helper 等待语义，因此 false 不代表安装丢失。已绑定 health 省略无关历史候选，只返回服务绑定信息；不同任务库不继承无关服务绑定；改过任务库时重新核对，不能套用旧绑定。WorkBuddy 回报后只运行一次 `claim --wait-seconds 0`，空队列就结束回复。回复结束后的返工、普通重开后的下个任务、完全关闭时按队列自动启动，以及裸启动无端口时自动正常重启一次，均已实测在原会话完成。登录恢复和系统重启未实测，不扩大为所有未来版本的保证。

`bin/workbuddy-service status` 用于检查，`bin/workbuddy-service uninstall` 用于用户要求停止或卸载服务时移除启动注册；保留任务记录。项目路径移动后需修复注册，不能继续依赖旧路径。电脑关机或用户登出时不能执行，下次登录恢复仍需有效登录、权限与兼容接口。WorkBuddy 升级后核对兼容性，服务不自动唤醒退出的 Codex。

## 仅需临时监听

省略 `persistent: true` 调用 `workbuddy_prepare_worker({sessionId})`，用户粘贴到相同真实会话，由 WorkBuddy 自己运行 claim。这种模式默认连续四次空等（各约50秒）后结束；结束回复、退出应用或停止领取后，下一批任务需要重新粘贴 bootstrap。它不会安装持久服务。不反复启动并行 claim。

## 不一致或阻塞

- 后端为旧 `api`、`gateway`、`cli` 或不适配版本的 `desktop-acp` 时，先如实说明路线差异，不能把隐藏执行器当用户桌面 WorkBuddy。
- 队列不支持远程选模型、新建桌面会话或用 `respond_task` 绕过原生权限；权限请求由用户在 WorkBuddy 处理。
- MCP 断线用原 taskId 恢复，不重新派相同目标。任务期限届满按 blocked 处理，不自动重发。
- 已领取轮次因应用崩溃中断、领取未闭合或唤醒提交不确定时，检查原会话、轮次与已有文件，明确阻塞后再决定恢复；服务不能静默重执行。不要把正常退出重开恢复当作中断任务自动重跑的许可。
- 取消是协作请求，不保证已执行操作回滚。需要确认停下时检查现有状态和必要记录，不操作桌面 UI。
- 回报来源或内容有疑点时，可以只读定位原生会话的相关工具记录，输出工具名、轮次和成果路径即可；不把包含凭证的原始命令、完整聊天记录放进模型上下文或公开包。
