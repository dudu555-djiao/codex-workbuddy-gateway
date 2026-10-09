# Codex 监督 WorkBuddy 的执行顺序

目标是桌面 WorkBuddy 执行，Codex 派工、读取回报、提出修改和检查成果。构建或模拟测试通过不能当作实机成功。

使用 [WorkBuddy 执行官 Skill](../skills/workbuddy-executor/SKILL.md)，通过 `npm run skill:install` 安装。它默认精简监督、不使用 Computer Use，日常任务优先 `detail: brief`。v0.4.1 持久模式首次由用户在真实专用会话粘贴一次安装指令；之后任务或返工进入队列，本机服务通过原生 RPC 按需唤醒同一会话。空闲时不调用模型。单独 Skill 不提供 Gateway 或持久服务。

## 配置

获取完整源码，核对版本。若仓库只有 README 与 ZIP，先解压包，再进入含 `package.json` 的目录。完成依赖、构建、测试，设置 `WORKBUDDY_BACKEND=desktop-queue`，保留现有文件、任务记录及其他 MCP。注册或更新当前桥接器后重启 MCP。

## 启动和选择会话

1. 打开真实 WorkBuddy 专用对话并发一条普通消息。读取 health 的 `workerCandidates`，按原生工作目录核对会话 ID；候选历史不代表活跃监听器。
2. 新的持久连接调用 `workbuddy_prepare_worker({sessionId, persistent: true})`，将返回的完整安装 prompt 交给用户一次粘贴到同一个真实 WorkBuddy 会话。WorkBuddy 用自己的 Bash 安装用户级 LaunchAgent；不通过 Computer Use 代粘贴。只生成 prompt 不能报告已安装。
3. 核对 `bin/workbuddy-service status` 的安装状态和 sessionId/workspace。持久服务在无任务时可以没有等待中的 helper；`health.ready` 仅表示当时正在等任务的 helper。临时模式省略 `persistent: true`，监听结束后须重新粘贴。不要启动隐藏 CLI 或直写原生历史充当桌面对话。
4. 使用会话实际工作目录，模型在 WorkBuddy 选择；队列仅 `sessionMode: existing`，不带 `model` 参数。
5. 先 `list_tasks` 恢复已有目标，不因断线重复投递。

## 派工和监督

`send_task` 写清目标、约束、输出路径、验收条件和期限。记录 taskId、attemptId、sessionId。排队不是执行成功；等待真实领取，再持续调用 `wait/get_task`。

| 状态 | 下一步 |
| --- | --- |
| queued | 持久模式检查服务与会话绑定，临时模式检查监听，继续有界等待原任务 |
| working | 读取主动回报，等真实结果，避免重叠返工 |
| blocked | 核对原会话、权限或期限，以及已产生文件；处理原因后再决定返工 |
| needs_review | 独立检查实际成果和来源 |
| failed | 根据明确原因处理，不把计划说成完成 |
| cancelled | 检查 WorkBuddy 是否真正停止，不假设远端立即停止 |

队列权限/输入在 WorkBuddy UI 处理，不能用 ACP 的 respond 工具绕过。过程日志由执行器主动回报，不假设自动获取所有工具调用。可以独立读取原生历史和产物，不能自行制作交付物后声称 WorkBuddy 完成。

MCP 重启后读取原记录，不自动重发。持久服务保存会话绑定，按需启动或重连原生 WorkBuddy；正常退出并普通方式重开、完全关闭后按队列自动启动，以及裸启动无端口时自动正常重启一次，均已实测在同一会话执行成功，无需重新粘贴安装指令或手工反复重启。电脑关机或用户登出时不能执行，后续登录与系统重启恢复尚未实测；WorkBuddy 登录、权限和接口兼容性仍需有效。服务不自动唤醒退出的 Codex。

执行中应用崩溃、领取记录未闭合或唤醒提交不确定时，先检查原会话、taskId/attemptId 和已产生的文件，明确记录阻塞。不能因重启就重派目标或自动重执行。只有未领取的新轮次可按队列正常唤醒；正在 working 的长任务没有等待中 helper 属于正常情况。

## 返工与验收

WorkBuddy 报完成只进入 needs_review。检查内容、文件、实际来源和相关测试后，给出具体反馈；continue 保留原目标、约束和会话，使用新的轮次。持久模式回报后只做一次 `claim --wait-seconds 0`，空队列就结束回复；原生会话空闲后服务可自动唤醒返工，本轮同会话 Edit/Read 和真实文件比较已通过。不能在活跃轮次中重复发送修改。

检查通过才调用 accept，提供具体 evidence 和真实 artifactPaths。验收工具校验给定文件存在且非空，并保存证据；它不替 Codex 做内容检查，也不证明回报中的每句话正确。

用户自行验收时，报告“WorkBuddy 执行结束，等待你的验收”，保留 needs_review，不提前标 accepted。首次持久连接按 [小清单、返工与重启验收](USER_ACCEPTANCE.md) 核对原生执行与恢复行为。本轮桌面安装、运行中派工、普通重开、完全关闭自动启动、裸启动自动启用端口和回复结束后的返工均已通过，无 Computer Use；共四项小文件创建、一项返工和 98 项自动化测试。本轮未覆盖业务搜索或视频，登录恢复与系统重启未实测，升级后仍需核对兼容性。
