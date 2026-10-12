---
name: workbuddy-executor
description: 用户要求将任务交给桌面 WorkBuddy 执行、接收反馈、返工或验收时使用。优先通过 Agent Hub 统一入口调用，兼容已有 workbuddy MCP 任务；支持各项目独立目录、原生会话、模型选择与绑定切换。纯原理问答或普通 Codex 自己执行的任务不触发。
---

# WorkBuddy 执行官

Codex 负责派工、必要核对和返工；真实桌面 WorkBuddy 使用自己的模型、工具和 Skill 执行。目标是减少 Codex 执行与重复读取的消耗，同时保留可核对的成果。没有用量数据时不声称节省百分比。

## v0.7.0 统一入口

- 新任务优先使用已运行的 Agent Hub：`agent_hub_submit` → 保存 `hub-…` 编号 → `agent_hub_wait` → 核对真实结果 → `agent_hub_accept`，不合格用 `agent_hub_rework`。首次连接、没有工具或需要其他项目调用时读 [Agent Hub 接入与执行](references/agent-hub.md)。独立 Skill 不包含平台服务。
- 明确 `provider: workbuddy`；业务任务传真实项目的绝对目录 `workspace`，独立任务可省略，由平台自动分配目录。平台原生准备各项目会话，不要求手动开聊天，不使用 Computer Use。当前聚合入口只实现 WorkBuddy；DeepSeek Harness 的旧桥接另行使用，不能声称已经聚合。
- 已知 `hub-…` 编号始终用 Hub 恢复；已有 `workbuddy` taskId 则按下面直连流程恢复。不把两套编号互换，也不因工具未加载或等待超时重复提交。新提交使用稳定的 `idempotencyKey`。
- `submitted` 仅表示已派工，`running` 才表示原生领取；`completed` 表示本轮执行结束且结果格式通过，仍需按下文核对内容。`cancel_requested` 不证明已停止，`uncertain` 不自动重发。只有确认原轮次结束后才返工。监督用约40–50秒有界等待，或 SDK 的程序等待，不用模型反复读取完整日志。
- 保留平台编号及真实 `providerTaskId`、`attemptId`、`sessionId`、`runtimeSource`。真实执行与内容验收要求适用于两条路线；Hub 的验收通过 `agent_hub_accept` 保存具体检查证据。积分余额和逐任务消耗尚未知，不承诺免费扣费归属或节省比例。

## 兼容直连：连接与恢复

- 使用现有 `workbuddy` MCP，主路线 `desktop-queue`。首次安装、无工具或连接异常时才读 [连接步骤](references/setup.md)。自动多项目接入要求完整 Gateway v0.6.0；Skill 本身不包含桥接程序。
- 不使用 Computer Use。先确定当前业务项目的绝对目录，调用 `workbuddy_ensure_workspace({workspace})` 原生创建或复用该目录的真实执行会话；也可直接在 `send_task` 传该目录触发准备。已有会话由用户明确指定时，使用 `ensure_workspace({workspace,sessionId})` 选择并核对。不会要求用户先开聊天或粘贴安装指令。登录和原生权限按实际需要处理。
- 各项目使用各自的目录和执行会话，不将桥接器源码目录或历史默认工作区当成业务目录。一个持久服务监督多个项目；切换选择只影响新任务，旧任务及返工继续使用原会话。多项目派工总是明确传 `workspace` 或 `sessionId`。目录对应的是本地执行会话，不自动建立云端团队空间。
- 先恢复已知 taskId；丢失编号才用 `workbuddy_list_tasks` 的小 limit。已有任务 `working` 时继续等待，不因当时没有等待中的监听器而重启或重发。
- 无已知执行中任务的首次使用检查一次 `workbuddy_health`；需要选择项目时用 `workbuddy_list_workspaces`，不要随意取最新历史 ID。持久模式核对服务的 `workers` 及对应目录状态；`ready` / `online` 仍是 helper 等待语义，不能仅凭 false 判服务失效。记住 sessionId/workspace，之后不反复 health。断线不重派目标；创建结果不确定也不重复创建，核对已预留的真实会话 ID。
- 旧对话尚未加载新增工具时，可用完整项目的 `scripts/workbuddy-call.mjs` 调用同名工具（JSON 或 @参数文件）；其启动器加载本机 .env 并复用同一任务库。不要因工具未刷新退回要求用户手动开会话。明确使用旧 Gateway 或临时监听时，才按连接步骤的兼容流程处理。
- 队列仅 `sessionMode: existing`，workspace 必须匹配真实会话目录。模型可通过原生接口切换，先查询实际可用 ID，不按展示名猜测。模型和绑定操作见下文；省略 model 时沿用会话当前设置。

## 模型选择与绑定切换

- 新 Gateway 支持 `agent_hub_models({sessionId?})` / `workbuddy_list_models({sessionId?,detail:"brief"})`，返回实际可用模型 ID（包括原生已配置的自定义模型）和可选会话的当前模型。不新增账号、凭据或自定义提供商。
- 指定本次任务模型：Hub 的 `agent_hub_submit` 或直连 `workbuddy_send_task` 传 `model:"实际模型ID"`；模型在该会话下一次原生唤醒时配置并读回核对，旧监听不能领取尚未准备好模型的任务。无效模型会阻塞并回报原因，不静默替换。临时监听不足以执行带 model 的队列任务，需要完整持久服务。
- 更换项目绑定或默认模型：先用 `agent_hub_workspaces` / `workbuddy_list_workspaces` 查看绑定；调用 `agent_hub_bind_workspace({workspace,sessionId?,model?})` 或 `workbuddy_ensure_workspace({workspace,sessionId?,model?})`。sessionId 指向该目录的真实会话，省略时创建或复用；model 省略时保留当前模型。原生核对模型成功后才替换已有绑定；有排队或未闭合任务、原生忙碌时，先等待，或绑定另一个空闲的同目录会话。
- 更换绑定只影响后续派工，已经派出的任务及返工仍使用原会话。返工换模型可传 `agent_hub_rework({id,feedback,model})` / `workbuddy_continue_task({taskId,feedback,model})`，必须先确认上轮结束。Hub 返工省略 model 沿用该任务先前指定值；直连省略时用原会话当前值。
- 工具尚未刷新时，使用完整项目的 `scripts/agent-hub-call.mjs` / `scripts/workbuddy-call.mjs` 调用新工具；旧 Gateway 需更新完整程序，不能只换 Skill。模型列表可见不保证账户额度与本轮调用成功。

## 兼容直连：派工

调用 `workbuddy_send_task`，一次写清目标、允许修改的范围、真实输出路径、验收条件和合理期限。复杂任务由 WorkBuddy 内部拆解，避免 Codex 逐步指挥每个工具动作。为任务保存稳定的 taskId；排队受理不等于执行成功。

在目标中加入以下简短回报要求，按任务调整：

> 使用本桌面会话自己的工具实际完成任务并自检；只修改授权范围，不改桥接器、配置或自行写记忆。回报状态、简短结果（通常不超过300字）、真实成果路径、关键来源或测试证据、未解决问题和额外修改。大段日志及完整成果保留在文件中，不贴回。使用本轮 claim 返回的身份与凭证 report；按当前启动指令完成有限领取，持久模式结束本次回复后由服务按需唤醒。

委派不扩大用户授权。Codex 不代写或代改任务成果；需要自己接手时先明确实际执行者，不能把自己的搜索、写入或测试记作 WorkBuddy 的执行证据。

## 兼容直连：精简监督

- 本项目 v0.3.1 起相关工具支持 `detail: brief`，默认用它。该模式只精简返回，完整记录仍在本机。旧工具没有此字段时不要传；支持工具执行环境裁剪结果时，仅显示必要字段，否则使用 `get_task` 的 `includeMessages: false`、小 limit，避免额外读历史。
- `workbuddy_wait` 使用约40–50秒的有界等待，监督不超过任务期限。有新事件就处理；状态未变继续等待，不重复打印任务要求、读取成果、启动搜索或重发。未领取的 queued 连续约四次无变化时检查一次服务或临时监听；按实际登录、权限、绑定或连接原因处理，继续等待原任务，不重复安装或派工。working 的长执行不能因短时无消息冒充失败；期限届满仍无结果就报告阻塞。
- 已领取后应用崩溃、领取轮次未闭合或唤醒提交结果不确定时，检查原会话和已产生文件，明确记录阻塞并决定恢复；不静默重执行，不将正常重启恢复的承诺应用到执行中断。
- 保留 taskId、attemptId、sessionId、runtimeSource、state、artifacts、阻塞原因及简短回报。`reportTruncated: true` 时，如截掉的部分影响判断，按需 `workbuddy_get_task(detail: full, includeMessages: false)` 查看完整回报，不忽略截断。
- `queued`：等原会话真实领取；`working`：执行中，不重叠返工；`needs_review`：执行器已回报，等待核对；`blocked/failed/cancelled`：按具体原因处理，不报成功。
- 等待期间不启动额外 Codex 子代理承担已派给 WorkBuddy 的执行工作，不为凑过程反复打开日志。

## 核对、返工和交付

1. 核对当前回报的身份、轮次和 `runtimeSource: desktop_queue`，以及真实成果。身份检查与 WorkBuddy 自述不能代替内容验收；首次连接的实测或来源疑点才按需只读核查原生工具记录，不默认遍历整份历史。
2. 按任务检查必要证据：小文件读实际内容；长成果只查相关部分；代码读关键 diff 和相关测试；事实查询核对关键官方来源。避免独立重做整套任务，也不能只看“文件非空”就判内容通过。时效或高风险内容仍需足够的独立核对。
3. 不合格时，Hub 任务用 `agent_hub_rework`，直连任务用 `workbuddy_continue_task`；集中列出具体问题和改好标准，保留原目标、会话及修改范围，等新轮次回报。同一阻塞反复出现时定位直接原因，缺登录或权限就请用户完成必要步骤，不盲目重发。
4. 实际检查通过后，Hub 任务用 `agent_hub_accept` 提交 note 和具体 evidence；直连任务用 `workbuddy_accept_task` 提交具体 evidence 和真实 artifactPaths。`accept` 保存验收记录，不自动执行检查。
5. 用户明确选择自行验收时，Hub 保留 `review: pending`，直连保留 `needs_review`，告知“WorkBuddy 执行结束，等待你验收”，不替用户标通过。
6. 批次结束不无限保活：持久服务空队列只检查本机记录，不调用模型；WorkBuddy 回报后运行一次 `claim --wait-seconds 0`，空队列就结束回复，后续任务和返工由服务按需唤醒。持久模式不做四轮空等；临时模式默认连续四次空等（各约50秒）后退出，之后新任务需重启监听。`ready: false` 不等于已完成任务失败或持久服务失效。

最终默认只给出完成状态、成果入口和影响使用的未解决问题。需要时补一句实际执行者；不默认附完整日志、长原理或未经测量的 token 节省结论。

## 真实边界

- 一个 WorkBuddy 回复里可以领取初稿、返工和结束通知；多个队列任务不一定显示为多个聊天气泡。应核对轮次和工具证据，而不是数气泡。
- helper 校验桌面进程来源、原生会话注册和每轮领取凭证；声明的 sessionId 仍需与真实对话核对，不是会话级加密认证。Codex 对成果目录仍有写权限，不能宣称物理隔离或不可伪造。
- Gateway 不自动采集全部工具轨迹；原生能力由 WorkBuddy 提供，不用独立 CLI、隐藏模型或 Codex 代做来冒充桌面任务。
- 持久模式以用户级 LaunchAgent 保存绑定，经仅回环 CDP 与原生 MessageChannel RPC 发送 queuewake；真实会话仍用同一个 helper 领取和回报。需要启动或启用端口时由服务自动启动应用或等会话空闲后重启一次，不要求用户反复手工重启。服务不读取登录凭据、不改 `app.asar`。电脑关机或用户登出时不能执行；登录恢复依赖有效登录、权限和兼容接口，不自动唤醒退出的 Codex。
- v0.4.1 已在 macOS WorkBuddy 5.7.6 实测桌面安装、运行中派工、普通重开、完全关闭自动启动、裸启动无端口时自动正常重启一次，以及回复结束后的同会话返工。四项小文件创建、一项返工和 98 项自动化测试通过，无 Computer Use。本轮未测业务搜索或视频，登录恢复及系统重启未实测。其他版本、工具及复杂任务按实际结果判断，应用升级后核对兼容性。
