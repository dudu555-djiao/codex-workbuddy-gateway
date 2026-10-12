# Agent Hub v0.7.0

用于新任务、跨项目调用和统一结果获取。已有直连 WorkBuddy 任务继续使用原 taskId 和旧 MCP；不要转成新 Hub 任务重跑。

## 连接

定位完整项目：包含 `bin/agent-hub`、`bin/agent-hub-mcp`、`dist/platform/client.js`、`package.json`。独立 Skill ZIP 只有指令，不含服务或本机连接信息。平台只监听本机回环地址，默认工作台 `http://127.0.0.1:18492/`。

在完整项目目录运行 `./bin/agent-hub status`。未安装时按项目 `docs/AGENT_HUB.md` 完成构建与 `./bin/agent-hub install`，保留已有 `.env`、任务记录、WorkBuddy 服务及默认绑定。平台与 WorkBuddy 唤醒服务是两个进程；Hub 在线不证明 WorkBuddy 已登录或额度可用。仅在首次或异常时查询 `agent_hub_providers`。

宿主已注册 `agent-hub` MCP 时直接使用其工具。工具未进入当前对话时，可通过同一项目的 MCP 客户端调用，不需要等待重开对话：

```sh
node /absolute/agent-hub/scripts/agent-hub-call.mjs agent_hub_providers '{}'
node /absolute/agent-hub/scripts/agent-hub-call.mjs agent_hub_submit @request.json
node /absolute/agent-hub/scripts/agent-hub-call.mjs agent_hub_wait '{"id":"hub-…","seconds":45}'
```

参数文件按调用时的目录解析。客户端使用该安装的 `.env` 和本机私有令牌，不打印令牌。若需配置其他支持 stdio MCP 的宿主，command 使用完整项目 `bin/agent-hub-mcp` 的绝对路径。此能力也可由其他项目通过 HTTP、SDK 或 CLI 调用，不依赖 Codex；具体接口见完整项目 `docs/AGENT_HUB.md`。

## 提交与恢复

`agent_hub_submit` 示例：

```json
{
  "provider": "workbuddy",
  "workspace": "/absolute/business-project",
  "task": "读取本目录的输入，完成明确目标；写清允许修改的范围和验收标准",
  "output": "json",
  "constraints": ["只修改授权的业务文件，不改平台、配置或写记忆"],
  "idempotencyKey": "business-project:stable-job-id",
  "timeoutSeconds": 1800
}
```

workspace 须是已有的绝对目录，原生会话自动创建或复用；独立任务省略 workspace，平台自动分配独立目录。output 为 text、json 或 artifacts；平台会加入本轮结果文件的回报要求，无须调用者手写内部 helper 凭证。跨项目使用不同稳定键；相同键与相同请求复用原任务，请求不一致会冲突，不能换键绕过未知派工。

保存返回的 `run.id`。按 `agent_hub_get({id})` 和 `agent_hub_wait({id,seconds:45})` 恢复。需要进度时使用带 after 游标的 events，避免反复完整读取。等待超时不会取消任务，平台重启不会授权重复提交。首次使用或来源疑点才核对必要的原生记录。

## 结果、返工和验收

- queued / dispatching / submitted / running：等待原任务，不重派。新任务默认全局并发1，同一项目串行；旧直连和手动任务不计入平台并发预算。
- completed：检查 `result.text`、`result.json` 或 `result.artifacts` 的实际内容；结果契约通过不等于业务正确。对应 `runtimeSource` 必须是 desktop_queue。
- 不合格且原轮次已结束：`agent_hub_rework({id,feedback:"具体问题和改好标准"})`，保留原会话、生成下一轮结果。仍持有执行占位时不重叠返工。
- 已完成实际内容检查：`agent_hub_accept({id,note:"检查结论",evidence:["具体检查、输入或产物与预期结果"]})`。该接口只记录独立验收，不执行检查；用户自行验收时保留 review=pending。
- cancel_requested / uncertain / blocked 且 holdsCapacity=true：确认原执行是否已停止。取消是协作请求，不回滚既有操作。不自动重发未知任务，也不通过新建任务绕过占位；首期没有一键强制释放。

Codex 不代写委派成果并归为 WorkBuddy。平台运行、排队或服务心跳均不能代替真实执行证据。支持调用时指定原生模型，以及更换项目绑定；仍不支持读取积分余额与逐任务扣费、完整工具轨迹、多账号或公网访问。DeepSeek Harness 和 qodex 尚未加入统一适配器。

## 模型与会话绑定

先调用 `agent_hub_models({sessionId?})`，从 models 中选择实际 ID。`agent_hub_submit` 可额外传 `model`、`sessionId`；指定 sessionId 时同时传该会话的真实 workspace。省略 model 沿用原生会话选择，指定时在下一次原生唤醒前配置并核对。

`agent_hub_workspaces({})` 查看已登记项目；`agent_hub_bind_workspace({workspace,sessionId?,model?})` 创建/复用或更换同目录会话绑定及默认模型。更换模型要求会话原生空闲且没有排队或未闭合任务；可以选择另一空闲同目录会话。已派出的任务及返工不迁移会话。返工选其他模型使用 `agent_hub_rework({id,feedback,model})`。

旧对话工具未刷新可调用：

```sh
node /absolute/agent-hub/scripts/agent-hub-call.mjs agent_hub_models '{}'
node /absolute/agent-hub/scripts/agent-hub-call.mjs agent_hub_bind_workspace @binding.json
```

CLI 对应 `agent-hub models [sessionId]`、`agent-hub workspaces`、`agent-hub bind @binding.json`；SDK 对应 `hub.models(sessionId?)`、`hub.workspaces()`、`hub.bindWorkspace({workspace,sessionId?,model?})`。模型 ID 包含已在 WorkBuddy 配置的自定义模型，不能据此承诺额度或某模型必定能执行成功。
