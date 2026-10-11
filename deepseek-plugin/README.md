# DeepSeek Harness Codex bridge plugin

This bundle runs **inside an existing Harness Desktop or Web profile Host**. It does not launch an independent agent, copy credentials, change permission policy, or inject into the App renderer. The gateway communicates with it through one private local Unix socket.

Supported native runtime: **0.2.0-rc.2 only**. An older global `dsh`, such as 0.1.6-alpha.2, is incompatible. The plugin checks the Host's resolved `@deepseek-ai/dsh-api-session-controller` package version and required methods before publishing its socket. Its peer requirement also lets native plugin compatibility preflight reject incompatible versions.

## Installation

Use the repository's `scripts/install-deepseek-plugin.mjs`, which invokes the **App's bundled CLI** and verifies native profile bundle registration. Do not use the older global `dsh`. Fully quit Harness Desktop before profile package installation, then reopen it after successful installation. A Desktop profile must already have been initialized by opening the App once.

The installed package is `@codex-local/dsh-codex-bridge`. Its `dsh.bundle.patch` inserts the `codex-deepseek-bridge` plugin. It has no runtime peer imports and no lifecycle scripts, so a linked package can load through the App's own Cordis context without resolving another copy of Cordis.

For a separately running Web Host, install/enable the same bundle in its **web** profile using that Host's compatible 0.2.0-rc.2 CLI. Each profile has a distinct logical Host ID. Do not copy Desktop credentials or configure a second hidden Host as an installation shortcut.

## Private transport

- Endpoint: `POST /rpc` over the registered Unix socket.
- Header: `Authorization: Bearer <private token>`.
- Request: `{ "method": "health", "params": {} }`.
- Success: `{ "ok": true, "value": ... }`.
- Failure: `{ "ok": false, "error": { "code": "bridge/...", "message": "..." } }`.
- An explicitly rejected `prompt` before native admission, or an authenticated transport rejection before any native invocation, additionally sets `error.admissionRejected: true`. Any error once native admission could have begun is `bridge/admission-unknown`, without that marker.

`~/.dsh/codex-bridge/` and its subdirectories are private mode **0700**; Unix socket, registration, and request-ledger files are **0600** and owned by the current UID. Filesystem access controls restrict socket connection to the same user; the token additionally rejects unrelated same-user callers without the private registration. This implementation does not claim a portable kernel peer-PID check. It does not expose TCP.

Private registrations live in `~/.dsh/codex-bridge/hosts/<hostId>.json`, containing `hostId`, `socketPath`, `token`, `pid`, `version`, `protocolVersion`, `profile`, `profileDir`, and `runtimeSource`. **Do not print or copy tokens into reports.** Host ID hashes the real profile path plus Desktop/Web runtime source; socket paths and tokens rotate on restart. A second live Host for the same profile is rejected; separate profiles coexist. Normal disposal removes only the current instance's registration and socket. A stale registration owned by a dead PID can be reclaimed.

RPC request bodies are bounded to 1 MiB, responses to 8 MiB, pending native requests to 32, and a request to 30 seconds. Native work that has not settled still holds its pending slot after the HTTP timeout. Use smaller event pages when a response exceeds its limit.

## Canonical methods

| Method | Parameters | Return |
| --- | --- | --- |
| `health` | `{}` | logical Host, runtime/profile, protocol and capability metadata; no token |
| `sessions` | `{}` | `{sessions:[{sessionId,workspace,cwd,busy,running,preset,title,identity}]}` |
| `create` | `{workspace?,cwd?,agentPreset?,sessionId?,title?}` | verified session summary; native title rename when available; `titleApplied` reports success |
| `session` | `{sessionId}` | verified summary, including `activeRequestId` when one owned request is active |
| `prompt` | `{sessionId,requestId,text}` | `{requestId,accepted:true,turnId?,duplicate?}` |
| `events` | `{sessionId,requestId?,afterSeq?:-1,limit?:100}` | `{events,cursor,hasMore}`; limit 1–256, cursor uses original native seq |
| `cancel` | `{sessionId,requestId}` | `{requested,stopped:false,queueRemoval?,alreadyEnded?}`; termination is proved by subsequent durable events |

A native Session turn is a numeric counter; canonical `turnId` is `<sessionId>:turn:<native turn counter>`, accompanied by `nativeTurn` and the original event. Events carry `seq`, `requestId`, canonical `type`, `turnId?`, `timestamp?`, `text?`, `error?`, `rawType`, `data`, and `raw`. Canonical types are `accepted`, `started`, `progress`, `waiting_input`, `completed`, `failed`, and `cancelled`.

## Execution and recovery guarantees

Calls go through the current Host's official `sessionController`. `prompt` uses native `source.rpcId=requestId` idempotence and a private, per-profile request ledger containing identities and a content hash, **not the prompt text**. A reservation is persisted before native admission. After an uncertain admission, no automatic resend is permitted. Same IDs with different content are rejected.

`events` replays `sessionController.inspect` from its original durable log on every request. Request ownership comes from source RPC IDs, durable inbox claims, and native turn numbers; requests merely queued during another turn do not inherit its ending. App/plugin/gateway restarts therefore do not require an in-memory follower to preserve ownership. The plugin never writes the native Session log directly.

`turn/end reason.completed` maps to `completed` only after a real `step/start`. No-step completion, error, interruption, max tokens, and unknown endings cannot prove a successful task. Completed text comes only from the final uninterrupted assistant message without a tool call; user prompts and tool output cannot substitute as the assistant result. Codex must independently inspect artifacts before acceptance.

Queue edits and steering also produce native inbox `outcome:canceled`; replay suppresses a false terminal cancellation when the same request is reinserted. `cancel` removes a queued item only by its matching source RPC ID through native `updateQueue`, or cancels an active turn only when that request owns it. Before active cancellation it replays the current live Session synchronously and rechecks the exact request/turn after any awaited cold read, then invokes native cancellation without another await. It never cancels an unrelated turn. The plugin always returns `stopped:false`; the gateway waits for matched durable cancellation/completion evidence.

Approval requests and `ask_user_question` calls map to `waiting_input`. Resolve them in the native Harness App/Web UI. The bridge has **no approval, permission-change, answer, arbitrary method invocation, shell, or evaluation RPC**.

## Tests

From the repository root:

```sh
node --test deepseek-plugin/test/*.test.mjs
```

These tests use fake native services and real private Unix sockets. They validate the adapter/transport contract, ownership replay, explicit rejection versus uncertain admission, request idempotence, same-profile registration safety, queued cancellation, permissions, bounds, and profile/version guards. They do not substitute for the repository's real App smoke test.

## Native source evidence

The implementation was checked against the installed App's read-only `app.asar` package sources:

- `@deepseek-ai/dsh-api-session-controller/lib/index.js`: `SessionController.list/inspect/create/rename/prompt/updateQueue/cancel`, native request deduplication (`hasPromptRequest`), and `SessionCommandController` admission rules.
- `@deepseek-ai/dsh-agent-loop/lib/index.js`: `ReactLoopInbox.mutate/claim`, request source preservation, `turn/start`, `step/start`, `turn/end`, assistant messages, and `keepInbox` cancellation behavior.
- `@deepseek-ai/dsh-agent/lib/index.js`: `foldConsumedWork/accountsForClaim` explains why a no-step completed turn does not establish completed work.
- `@deepseek-ai/dsh-user-approval/lib/index.js`: durable `approval/asked` and `approval/decided`; the bridge does not answer these requests.
- `@deepseek-ai/dsh-user-questions/lib/index.js`: `ask_user_question` and the native question projections.
- `@deepseek-ai/dsh-app-boot/lib/index.js`: `dsh.bundle.patch`, profile compatibility checks, and `pluginPackages.packageOf`.
- `@deepseek-ai/dsh-desktop-host/lib/index.js`: Desktop runs the shared Web Host using its `desktop` profile; no external agent process is necessary.
