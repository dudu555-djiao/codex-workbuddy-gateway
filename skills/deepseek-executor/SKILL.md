---
name: deepseek-executor
description: 用户要求 Codex 指挥本机 DeepSeek Harness App 或网页端执行任务、读取反馈、返工和验收时使用。通过 deepseek MCP 连接 Harness 原生 Host 的指定会话。
---

# DeepSeek 执行官

Codex 负责派工、必要核对和返工；DeepSeek Harness 的原生会话使用该会话自己的模型、工具和 Skill 实际执行。模型由 Harness 会话配置决定，产品名不代表执行模型一定是 DeepSeek。

## 连接与派工

- 使用 `deepseek` MCP。没有工具或连接失败时读 [安装与恢复](references/setup.md)；已安装的 MCP 暂未进入当前对话工具列表时，可使用项目自带的同一 MCP 客户端。Skill 本身不包含连接程序。
- 已知 taskId 时先用 `deepseek_get_task` 同步原任务；`deepseek_list_tasks` 只读取本地快照，Host 离线时的 `working` 不是实时执行证明。首次连接用 `deepseek_health` 和 `deepseek_list_sessions` 核对 Host、profile、会话及工作目录。存在多个 Host 或会话时明确选择，不凭最新时间猜测。App 和网页可以使用不同 profile、工具与模型。
- 使用专用 Harness 会话。新建会话要给出真实工作目录；绑定后返工保留同一 Host 与 sessionId。当前会话执行中时等待，不重叠派工。
- `deepseek_send_task` 一次写清目标、允许修改的范围、真实输出路径、验收标准和合理期限。保存 taskId，不因 MCP 断线或等待超时重新发送同一目标。
- 将下面的回报要求加入目标，并按任务调整：

> 使用本 Harness 会话自己的工具实际完成任务并自检；只修改授权范围，不改桥接插件、连接配置或自行写记忆。回报简短结果、实际成果的绝对路径、关键来源或测试证据、未解决问题和额外修改。执行历史由 Harness 和 Gateway 保存，只在任务要求时另写日志文件，不贴回长日志。

## 监督与返工

- 默认精简返回；完整事件保留本地。使用约40–50秒的有界 `deepseek_wait`，有新事件再处理，不反复读取全量历史或独立重做已交出的任务。
- 消息受理只表示进入会话；`working` 表示执行中，`needs_review` 表示本轮结束等待核对，`accepted` 表示已记录独立验收。没有成果或明确失败就如实报告。
- `blocked` 时同时检查 `runOpen` 与 `blockingKind`。仍在运行且等待输入或权限时，在原生 Harness 界面处理；不扩大执行权限、不自动批准未知操作。已结束且回报阻塞或失败时，按实际问题补充条件，再决定原会话返工。取消请求与实际停止分开判断，取消后确认原轮次停止再派下一轮。
- 断线先恢复原 Host 和任务，依据原生请求编号、轮次及事件游标核对状态；发送结果不确定时不盲目重发。执行中断后检查原会话和已有文件再决定恢复。
- Codex 不代写任务成果并归为 Harness 执行。必须接手时明确执行者和范围。

## 核对与交付

1. 用 `deepseek_get_task(detail: "evidence")` 查看精简执行证据，核对 Host、sessionId、attemptId、工具调用和当前轮次结束；只用当前请求关联的结果判断完成。字段标记截断或有具体排查需要时再读 `detail: "full"`，不要将其中系统提示、推理流和私人历史贴回聊天。
2. 按任务读必要的实际成果：小文件看内容，代码看相关 diff 与测试，事实查询核对关键来源。简短回报和文件非空不能代替内容验收。
3. 不合格用 `deepseek_continue_task` 集中列出问题及改好标准，保留原目标、会话与修改范围。验收标准默认追加；要求明确改变且与旧标准冲突时，使用 `acceptanceMode: "replace"` 并给出完整、非空的新 `acceptanceCommands`，避免同时要求旧值与新值。等新轮次结束再核对。
4. 检查通过后用 `deepseek_accept_task` 保存具体 evidence 和真实 artifactPaths；该工具只记录验收，不代替检查。用户选择自己验收时，也先确认匹配轮次真实结束，再保留 `needs_review`。

最终给出完成状态、真实成果入口和影响使用的未解决问题。没有用量测量时不声称节省百分比。连接异常不自动降级为独立 Harness CLI、隐藏 Agent 或 UI 代发任务。
