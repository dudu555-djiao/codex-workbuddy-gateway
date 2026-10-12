# Agent Hub 使用说明

本机单用户聚合执行服务。当前接入 WorkBuddy 桌面执行器；DeepSeek Harness 旧桥接保持可用，但尚未加入平台适配器，qodex 尚未接入。平台不用 Codex 执行委派任务。

设计依据见 [设计方案](AGENT_HUB_DESIGN.md)。需要 macOS、Node.js 22.13+、已登录且有可用额度的 WorkBuddy。`.env` 使用现有 `WORKBUDDY_BACKEND=desktop-queue`。不需要先手动打开每个业务项目的 WorkBuddy 会话。

## 启动

```sh
npm ci
npm run build
./bin/agent-hub serve
```

工作台默认在 <http://127.0.0.1:18492/>。程序接口使用 Bearer token；浏览器工作台自动建立仅本机使用的会话。平台只监听回环地址，不开放跨域或公网访问。

常驻运行：

```sh
./bin/agent-hub install
./bin/agent-hub status
```

install 安装独立的用户级 LaunchAgent；现有 WorkBuddy 唤醒服务继续使用原注册。需要先结束手动启动的 Agent Hub 服务再安装。status 返回地址、进程及 token 文件位置，避免将 token 本身打印到日志。uninstall 删除平台服务，保留记录。

可在 `.env` 配置：

```ini
AGENT_HUB_PORT=18492
AGENT_HUB_MAX_CONCURRENT=1
# AGENT_HUB_STATE_DIR=/absolute/private/state
```

修改后重新 install 或重启手动服务。平台并发只约束平台任务；旧 MCP 和手动 WorkBuddy 任务仍按原规则执行。底层会话锁继续保证同一会话不重叠领取。账号登录、原生工具权限和应用兼容性仍需有效。

## 一次调用取得结果

在另一个 Node.js 项目中导入本项目已编译客户端的绝对路径：

```js
import { AgentHubClient } from "/absolute/agent-hub/dist/platform/client.js";

const hub = AgentHubClient.local();
const result = await hub.run({
  provider: "workbuddy",
  workspace: "/absolute/business-project",
  task: "读取本目录的输入数据，按月份汇总，并返回 JSON",
  output: "json",
  idempotencyKey: "monthly-summary-2026-10"
}, { timeoutMs: 1_800_000 });

if (result.status === "completed") console.log(result.result.json);
else console.error(result.status, result.error);
```

workspace 省略时分配独立目录，适合问答、文本及独立任务。workspace 必须是已存在的绝对目录，平台规范化路径并自动准备原生会话。output 为 text、json 或 artifacts；可提供 constraints 字符串数组和 timeoutSeconds（10–86400，默认 1800）。

run 由本机程序等待，不要求另一个大模型反复读取日志。wait 超时只停止等待，任务不被取消，使用返回或提交时保存的 id 恢复。需要随时保存编号时先 `hub.submit()`，再 `hub.wait()`。相同 idempotencyKey 和相同请求返回原任务；相同键而请求内容不同返回 409，避免重试意外执行两次。跨项目也应使用不同的稳定键。

## 命令行

将上面的请求对象保存为 task.json，然后从任意目录调用：

```sh
/absolute/agent-hub/bin/agent-hub run @task.json
/absolute/agent-hub/bin/agent-hub run @task.json --no-wait
/absolute/agent-hub/bin/agent-hub get hub-xxxxxxxx
/absolute/agent-hub/bin/agent-hub cancel hub-xxxxxxxx
```

相对参数文件按调用时所在目录解析。run 的 stderr 立即打印任务编号，stdout 打印任务对象；失败、阻塞和不确定状态返回非零退出码。

## HTTP 与其他语言

运行 status，读取 tokenFile 指向的私有文件，用它作为 `Authorization: Bearer ...`。不要把 token 放进 URL、版本库或日志。Python 例子使用标准库：

```python
import json, pathlib, urllib.request

state = pathlib.Path("/absolute/agent-hub/data/platform")
connection = json.loads((state / "connection.json").read_text())
token = pathlib.Path(connection["tokenFile"]).read_text().strip()
request = urllib.request.Request(
    connection["url"] + "/v1/runs",
    data=json.dumps({"task": "返回一份三条项目检查清单", "output": "json",
                     "idempotencyKey": "checklist-001"}).encode(),
    headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    method="POST")
run = json.load(urllib.request.urlopen(request))["run"]
print(run["id"])
```

API 路径见设计方案。`GET /v1/runs/:id/wait?timeoutSeconds=45` 最长 50 秒，有变化或执行结束后读取当前结果；该接口等待执行结束或需要处理，不因每一条进度事件结束。`GET .../events?after=事件ID` 每页最多 100 条；持续读取至空即可补齐历史。`GET .../stream` 是 SSE，支持 after 或 Last-Event-ID，连接保留至客户端关闭。文件下载使用结果的数组下标：`GET .../artifacts/0`。

## 给其他 Agent 使用的 MCP

在宿主的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "/absolute/agent-hub/bin/agent-hub-mcp",
      "args": []
    }
  }
}
```

先启动平台服务。支持 agent_hub_providers、submit、get、list、wait、events、cancel、rework、accept。旧 workbuddy 和 deepseek MCP 保留，平台 MCP 为新增入口。无需复制业务项目到平台仓库。

## 状态、结果和验收

queued 是平台排队，dispatching 是准备/派工，submitted 是已提交但尚未由原生 WorkBuddy 领取，running 才是领取执行。completed 表示执行器回报结束且本轮结果契约通过；review=pending 表示内容尚未独立验收。平台验证结果文件结构与真实产物，不证明业务结论正确。

独立检查后在工作台填写实际检查结果，或使用 `hub.accept(id, note, evidence)` 记录验收；返工使用 `hub.rework(id, feedback)`，继续原任务、原会话，生成新的轮次结果文件。JSON 或文件契约不合格会返回 INVALID_OUTPUT，可在确认执行已结束后返工。验收证据必须是实际检查，不能用“平台格式检查通过”替代内容核对。

cancel_requested 表示已请求停止，未确认停止前继续占用平台并发。平台队列里尚未派工的任务可立即取消。uncertain 表示无法确定派工是否发生，不自动重发；先核对原会话、底层任务和产物。该状态保留占位，首期没有一键强制释放或自动重试。blocked 且 holdsCapacity=true 同样需要确认底层停止；不能通过新建任务绕过。

## 数据与已知限制

平台记录、令牌、自动目录和分轮次结果默认在 data/platform/；原生任务继续进入现有任务库和 data/runs/。这些目录不参与 Git 和发布打包。文件下载只允许该任务工作目录及本轮结果目录，拒绝越界的符号链接。

积分余额和逐任务消耗均为 null/unavailable，不能将未知视为零消耗。未验证免费积分的具体扣减归属，也未接入计费或自动购买。当前桌面通道支持指定原生 model ID，并在原生唤醒前配置和读回核对；省略时使用 WorkBuddy 会话当前模型。项目会话会复用，尚无自动轮换和上下文成本管理。事件来自执行器主动回报，不能保证完整工具轨迹。

首期没有公网访问、多账号托管、OpenAI 兼容推理 API，也不把 WorkBuddy、DeepSeek Harness 或 qodex 的能力视为等价。接入新的执行器实现 AgentProvider 并注册到 HubEngine 即可；各执行器仍必须验证登录、真实来源、输出、取消和额度语义。

## 模型与绑定接口

- MCP：`agent_hub_models({sessionId?})` 查询当前可用模型；`agent_hub_workspaces({})` 查看绑定；`agent_hub_bind_workspace({workspace,sessionId?,model?,title?})` 创建、复用或切换同目录真实会话与默认模型。
- HTTP：`GET /v1/providers/workbuddy/models`（可选 sessionId 查询参数）；`GET /v1/providers/workbuddy/workspaces`；`POST /v1/providers/workbuddy/workspaces` 接受上述绑定 JSON。
- SDK：`hub.models(sessionId?)`、`hub.workspaces()`、`hub.bindWorkspace({workspace,sessionId?,model?,title?})`；CLI：`agent-hub models [sessionId]`、`agent-hub workspaces`、`agent-hub bind @binding.json`。
- submit 可额外传 model、sessionId。指定 sessionId 时必须同时提供其真实 workspace；模型 ID 从实时列表选择，不用展示名猜测。包括已在 WorkBuddy 配置的自定义模型，不新增提供商或凭据。
- `hub.rework(id, feedback, model?)` / `agent_hub_rework` 的可选 model 指定下一轮模型；省略沿用任务之前指定值。返工保持原会话。

绑定中的模型变更要求原生空闲且没有排队或未闭合任务；更换绑定只影响后续派工，已派出的任务和返工继续原会话。单次任务的 model 在其下一次原生唤醒时配置，领取权限按执行轮次保存；旧监听不能抢领另一模型任务。模型无效或配置核对失败时阻塞回报，不静默换模型，也不自动重发未知提交。模型列表可见不保证额度或执行成功。
