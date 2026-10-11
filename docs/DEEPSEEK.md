# Codex → DeepSeek Harness

Codex 通过 `deepseek` MCP 派工和验收；原生 Harness App 或网页 Host 中的专用会话使用自己的模型、工具和 Skill 执行。DeepSeek 任务库与现有 WorkBuddy 任务库分开保存。

## 组成

- `skills/deepseek-executor/`：Codex 的派工、监督、返工和验收流程。
- `src/deepseek-*.ts`：本地 MCP、连接客户端、持久任务管理和事件同步。
- `deepseek-plugin/`：装入真实 Harness Host 的插件，通过本用户的私有 Unix socket 提供有限接口。
- `bin/deepseek-gateway`：Codex MCP 启动入口。

插件连接当前 Host 的原生会话控制器，不另起模型执行进程。Skill 单独安装不能建立连接。App 和网页使用不同 profile 时，模型、工具和 Skill 也可能不同。

这里复用了 WorkBuddy 项目的监督方法：稳定任务编号、持久记录、同一会话返工、精简回报、独立验收，以及断线后先恢复再决定下一步。Harness 提供原生插件和会话控制器，因此连接层单独实现，不需要复用 WorkBuddy 的桌面唤醒与领取队列。

## 本机安装

在项目目录运行构建与检查：

```sh
npm ci
npm run build
npm test
npm run deepseek:plugin:test
node scripts/install-deepseek-skill.mjs
node scripts/install-deepseek-plugin.mjs --profile desktop
```

Harness 插件的安装与加载步骤见 [插件说明](../deepseek-plugin/README.md)。安装器使用目标 App 自带的运行时管理 `desktop` profile；不能用另一版本的全局 `dsh` 代替。它先备份 profile 文件，再添加本机插件依赖和 bundle，保留原有模型、凭据和其他插件。等原生任务空闲后重新加载 profile。

注册 Codex MCP：

```sh
codex mcp add deepseek -- /absolute/path/to/project/bin/deepseek-gateway
```

桌面进程没有正确 Node PATH 时，在注册命令前使用 `--env DEEPSEEK_NODE_BIN=/absolute/path/to/node`。不要覆盖其他 MCP。默认数据库为项目 `data/deepseek/tasks.sqlite`，可用 `DEEPSEEK_DB_FILE` 指定；注册目录可用 `DEEPSEEK_BRIDGE_REGISTRY_DIR` 指定。重新加载 MCP 或打开新 Codex 对话后使用：

```text
使用 $deepseek-executor，让本机 DeepSeek Harness 执行这项任务。
你负责派工、检查真实成果和原会话返工。
```

在当前 Codex 对话尚未重载工具时，可用真实 MCP 客户端检查连接：

```sh
node scripts/deepseek-call.mjs deepseek_health
node scripts/deepseek-call.mjs deepseek_list_sessions
```

该客户端也接受第二个参数作为 JSON 或 `@arguments.json`，用于调用明确指定的 DeepSeek 工具；不会自动创建或派发测试任务。

## 任务闭环

先检查 Host 并选择专用会话，核对工作目录后再派工。稳定保存 taskId、attemptId、原生 requestId、Host 与 sessionId。消息受理不等于执行完成，本轮结束进入 `needs_review`，Codex 独立检查后才记录 `accepted`。

重连先同步已有任务，不重复派发。返工回原 Host 的同一会话；Host 断线、版本不兼容或发送结果不确定时保留阻塞原因，不静默切换到隐藏 CLI 或另一个会话。取消请求和执行停止分别记录。

日常监督用 `brief`，核对原生工具执行用 `deepseek_get_task({taskId, detail: "evidence"})`。证据视图保留请求/轮次、工具参数、工具结果及完成原因，过滤系统提示和模型流；每个长字段最多2000字符，显式标注截断。`full` 保留原始诊断记录；证据视图与文件内容检查共同用于验收。

返工验收要求默认追加。若旧要求已明确作废，传 `acceptanceMode: "replace"` 及完整、非空的新 `acceptanceCommands`，原目标、授权修改范围与历史轮次仍保留。等待输入时，普通进度日志不会清除阻塞；原生新执行步骤或轮次结束才改变对应状态。

插件注册信息带本机连接凭据，只有本用户可读；不把它们纳入交付、版本库或日志回报。无需读取或复制 Harness 的模型密钥。

## 验证范围

2026-10-11 在本机 macOS 的 **DeepSeek Harness App 0.2.0-rc.2 / desktop profile** 完成真实闭环；会话沿用 Harness 已配置的 `glm-5.2` 模型。验证内容如下：

| 检查 | 实际结果 |
| --- | --- |
| 创建专用会话、派工 | 原生专用会话创建成功；Harness 自己调用 Write、Read 创建并读回文件 |
| MCP 断开后恢复 | 派工、等待、读取和验收分别使用独立 MCP 子进程；恢复到原 request 与 turn |
| App 正常退出、重开 | 退出后注册消失；重开后 PID 改变，逻辑 Host ID 和原会话保留 |
| 同一会话返工 | 第二轮原生 Read → Edit → Read，将 `phase: initial` 改为 `phase: revised`；匹配本轮 `turn/end completed` |
| 重复提交 | 原 taskId 再次提交返回 `created:false`，未增加派发或轮次 |
| 独立验收 | Codex 实际读取文件，精确核对两行、末尾换行与53字节，随后记录 `accepted` |
| 真实取消 | 第三轮收到取消后出现匹配请求及轮次的原生 `turn/end aborted`，记录 `cancelled`；已验收文件保持不变 |

具体会话编号、文件路径和原始日志只保留本机，不纳入分享包。Codex 只创建测试目录和派工参数，验收文件由 Harness 实际写入及返工。

构建与 Skill 校验通过；项目121项测试及插件26项测试全部通过。自动化测试覆盖身份、幂等、断线恢复、取消、权限阻塞、分页和任务锁等边界，使用模拟服务或本地 socket，不替代上面的 App 实测。

目前只兼容 **0.2.0-rc.2**；App 升级后要重新核对原生接口。网页 Host 使用相同适配接口，但本轮没有启动或实测独立网页 profile。复杂长任务、系统重启和用户登出未测。App 关闭时需正常重开，桥接不会另起隐藏 Host；权限和输入在 Harness 原生界面处理。单条原生日志超过8MiB时会明确阻塞并保留任务锁，不重发任务。

### 2026-10-11 Skill 复测与修复（MCP 0.1.1）

复测发现并修复等待输入被普通日志清除、返工验收要求无法替换旧条件的问题；增加 `evidence` 视图，并补齐“当前 Codex 对话未加载 MCP 工具时使用已注册服务的 SDK 客户端”的恢复指引。已更新并重新安装全局 Skill。

本轮未调用 Computer Use。派工、状态读取、返工、验收和取消全部通过真实 MCP 与 Harness 原生会话控制器完成；Codex 只准备输入数据、修改桥接实现并独立验收。此前首轮安装验证用过 Computer Use 正常退出/重开 App 与打开验收会话，没有通过 UI 代发业务任务。

- 使用新建专用会话和独立任务编号；具体编号只保留本机。
- 中文含空格目录中，Harness 读取3笔订单并写入汇总：金额57、件数7、记录数3。原生工具记录包含 Read、Write、Read、Bash 核对。
- 同会话返工明确替换旧验收要求，实际通过 Read、Edit、Bash JSON解析核对，将版本从1改为2并新增 `currency: CNY`。Codex 独立解析成果并比对输入未变，记录 `accepted`。
- 另派只读等待输入测试，原生 `ask_user_question` 被识别为 `blocked / waiting_input / runOpen:true`；随后通过 MCP 取消，匹配请求与轮次的 `turn/end aborted` 确认 `cancelled / runOpen:false`。没有替用户回答测试问题或修改权限。
- 同一首轮记录的 MCP JSON 返回量：原始 `full` 为334536字节，`evidence` 为9873字节；两者使用相同80条事件上限。这是返回体积测量，不代表整个任务的 token 节省比例。

当前构建、Skill 校验、项目127项测试和插件26项测试全部通过。回归用例覆盖上述两处已复现问题、新验收列表非空约束及真实 MCP 证据视图；未扩大为网页或复杂长任务验证。测试成果和原始执行历史仅保留本机。
