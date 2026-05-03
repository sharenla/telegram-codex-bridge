# Telegram Codex Bridge (Codex GUI-like, via `codex app-server`)

[![Release](https://img.shields.io/github/v/release/sharenla/telegram-codex-bridge)](https://github.com/sharenla/telegram-codex-bridge/releases)
[![License](https://img.shields.io/github/license/sharenla/telegram-codex-bridge)](https://github.com/sharenla/telegram-codex-bridge/blob/main/LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-black)](https://github.com/sharenla/telegram-codex-bridge)

Language: [中文](#zh-cn) | [English](#english)

An unofficial self-hosted Telegram bridge for Codex that forwards Telegram messages to a local `codex app-server`, then sends streaming progress and final results back to Telegram.

> Unofficial project: this bridge is not affiliated with OpenAI.  
> If you enable high-permission mode, your Telegram bot effectively becomes a remote execution entrypoint to your machine.

## Install With Codex

The easiest install flow is to hand this repo URL to your local Codex and let Codex set it up for you:

`https://github.com/sharenla/telegram-codex-bridge`

**Chinese prompt**

```text
请帮我安装并配置这个项目：https://github.com/sharenla/telegram-codex-bridge

要求：
1. clone 仓库并安装依赖
2. 从 .env.example 复制出 .env
3. 帮我填写 TELEGRAM_BOT_TOKEN
4. 运行 npm run discover-chat，拿到 chat_id 后填入 TELEGRAM_ALLOWLIST
5. 启动 bridge
6. 如果我要它跟随 Codex 启动，再执行 npm run install:launch-agent
```

**English prompt**

```text
Please install and configure this project for me:
https://github.com/sharenla/telegram-codex-bridge

Steps:
1. clone the repo and install dependencies
2. copy .env.example to .env
3. help me fill in TELEGRAM_BOT_TOKEN
4. run npm run discover-chat, get my chat_id, and write it to TELEGRAM_ALLOWLIST
5. start the bridge
6. if I want it to auto-start with Codex, also run npm run install:launch-agent
```

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/sharenla/telegram-codex-bridge.git
cd telegram-codex-bridge
cp .env.example .env
npm i
npm run discover-chat
npm start
```

Then edit `.env` and fill:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWLIST`

If you want the bridge to start and stop with Codex on macOS:

```bash
npm run install:launch-agent
```

</details>

<a id="zh-cn"></a>

## 中文

### 这是什么

把 Telegram 里的消息转发到本机 `codex app-server`，并把 Codex 的流式进度、工具执行状态和最终结果回传到 Telegram。

它的目标不是做一个一次性 `codex exec` 包装器，而是尽量复现 Codex GUI 的体验：

- 持续对话
- thread / turn 级上下文
- 工具调用过程可见
- 可切模型、切思考强度、切工作目录
- 可接 OpenClaw 账号池做自动切号

### `codex-cli` 和 `app-server` 的关系

- 安装反馈里看到“可用 `codex-cli 0.x`”是正常的。
- 这个项目实际启动的是本机 `codex` 二进制里的 `app-server` 子命令：

```bash
codex app-server --listen stdio://
```

- 所以本机 `codex` / `codex-cli` 的版本，直接决定了 `app-server` 能不能正常握手，以及支持哪些协议能力。

### 常用命令

- 直接发送文本：发起一次 Codex `turn/start`
- `/menu`：打开快捷按钮面板
- `/status`：查看当前 `thread / model / effort / cwd`，以及最近一次上下文占用观测
- `/truth`：查看当前项目绑定的 repo / runtime / state / logs 真相源
- `/refresh`：重新绑定当前项目的真相源，并让下一次用户消息带上 source-of-truth bootstrap
- `/new`：新开线程
- `/compact`：把当前 thread 压缩成摘要，并切到一个新的 thread
- `/stop`：中断当前 turn；在群聊里还会清空已排队的新任务
- `/cwd /abs/path`：切换工作目录
- `/projects`：列出 source-of-truth 项目
- `/project <index|id|path>`：切换项目并重置 thread
- `/sessions`：列出当前 cwd 下最近的 Codex sessions
- `/resume <index|threadId>`：把当前 Telegram 会话绑定到已有 Codex thread
- `/handback`：打印可在本机终端执行的 `codex resume` 命令
- `/continue <message>`：当同一 workspace 另一个 chat 正在跑任务时，强制继续一次自然语言 turn
- `/diff`、`/git status`、`/test`、`/review`、`/rollback`：显式工程命令；自然语言交互不受影响
- `/models`：查看推荐模型；内置快捷别名 `5.2 / 5.4 / 5.5`
- `/model 5.4`：切模型（会保存成 `gpt-5.4`）
- `/model 5.5 xhigh`：同时切模型和思考等级
- `/efforts`：查看思考级别
- `/effort xhigh`：切换思考强度
- `/think medium`：`/effort` 的别名
- `/autoroute auto`：开启按任务难度自动选择模型和思考等级；也支持 `off / suggest / lock / unlock`
- `/route <message>`：预览某条消息会被分到哪个模型和思考等级
- `/extensions`：只读查看 app-server 发现到的 skills / apps / MCP / plugins
- `/skills`、`/apps`、`/mcp`、`/plugins`：分别查看扩展子系统；支持 `refresh` 的命令会强制刷新
- `/accounts`：查看账号池
- `/account 2`：切到第 2 个账号
- `/authsync`：从账号池同步最新认证并重启 Codex 后端（常用于 token 失效/断流后自救）
- `/answer <token> ...`：回答需要输入的问题

自动路由默认关闭，避免升级后改变现有会话行为。设置 `CODEX_AUTO_ROUTE=auto` 或发送 `/autoroute auto` 后，bridge 会在每个新 turn 前按确定性规则选择 `model / effort`：简单文本走 `gpt-5.2 / low`，普通代码任务走 `gpt-5.4 / high`，命中 live/runtime/auth/deploy/trading/root-cause 等高风险信号时走 `gpt-5.5 / xhigh`。`/autoroute suggest` 只记录和预览，不自动覆盖；`/autoroute lock` 会保留当前手动选择。

扩展命令默认只读，不会安装或启用插件。普通消息里如果写入 `$app`、`$skill` 或 `$plugin` 名称，bridge 会尽量把它转换成 Codex app-server 的精确 `mention` input；如果当前 app-server 不支持对应列表接口，会降级为普通文本。

桌面端体验相关命令优先围绕“选对项目、接上已有 thread、能随时交还本机 Codex”设计。`/projects` 使用同一份 source registry，避免 Telegram 会话长期停在 `/Users/wukong`；`/sessions` 和 `/resume` 走 app-server 的 thread 列表/恢复接口；`/handback` 用于从 Telegram 切回本机 CLI。bridge 会按 chat + project 保存 thread，切回项目时优先恢复该项目的 thread；同一 workspace 有其他 chat 正在运行时，普通自然语言任务默认挡住，显式 `/continue` 才会绕过。

显式工程命令是增加项，不改变普通自然语言路径。`/diff` 和 `/git status` 是只读；`/test` 只在当前 cwd 有 `package.json` 的 `scripts.test` 时运行 `npm test`；`/review` 会用 Codex review 当前工作树 diff；`/rollback` 只输出候选回滚命令，不自动执行 destructive 操作。

### 群聊行为

- 群里只有 **@bot** 或 **直接回复 bot** 的消息才会触发
- 普通群消息会被忽略
- 如果当前 turn 还在运行，新的群聊任务会进入队列，不会直接改写当前任务
- 如果你想临时调转方向，先发 `/stop`，再发新任务
- 群里的过程消息默认会脱敏：
  - 保留文字性的处理进度
  - 隐藏代码、路径、命令输出和 diff
- 群里的最终结果默认不脱敏

### 跟随 Codex 启动

如果你希望“打开 Codex 就启动 bridge，关闭 Codex 就停止 bridge”，在 macOS 上运行：

```bash
npm run install:launch-agent
```

它会安装一个 `launchd` agent，并把运行副本同步到：

`~/Library/Application Support/telegram-codex-bridge-service`

卸载：

```bash
npm run uninstall:launch-agent
```

### Telegram 网络 / 代理

如果 Telegram 在你当前网络环境里不稳定，可以让 bridge 的 Telegram 请求显式走本机代理：

```bash
TELEGRAM_PROXY_URL=http://127.0.0.1:1082
TELEGRAM_POLL_TIMEOUT_SECONDS=5
```

- `TELEGRAM_PROXY_URL` 一般填本机 Clash / Mihomo 的 `mixed-port`
- 留空时，bridge 会优先直连；如果发现本机 Clash Verge 配置，也会自动尝试它的 `mixed-port`
- 如果你明确不想走代理，可以设成：

```bash
TELEGRAM_PROXY_URL=direct
```

### Codex 网络 / 代理

注意：`TELEGRAM_PROXY_URL` 只影响 Telegram，不影响 Codex（`codex app-server`）。

如果 chatgpt.com 在你当前网络环境里不稳定 / 断流 / 被阻断，可以让 Codex 也走本机代理（环境变量会被 bridge 继承）：

```bash
HTTPS_PROXY=http://127.0.0.1:1082
# or:
ALL_PROXY=socks5h://127.0.0.1:1082
```

### 真相源 / Source Registry

Telegram 只是输入输出通道。为了让 bridge 更接近 Codex 桌面端的判断路径，bridge 会为每个 chat 维护一个 source-of-truth profile：

- `/project /abs/path` 会切换 `cwd`、重置 thread，并重新绑定项目真相源
- `/truth` 会显示当前 profile 里的 repo、live runtime、service copy、state files、logs、LaunchAgent、Codex homes
- `/refresh` 会重新计算绑定，并让下一次真实用户消息自动附带一段 source-of-truth bootstrap
- 如果没有匹配到 profile，bridge 会退回到 `cwd-only`，并提醒不要把 cwd 当成 live runtime truth
- bridge 启动时默认会从 `DESKTOP_CODEX_HOME` 同步桌面端的 memories / skills / plugins / rules 到 bridge 的独立 `CODEX_HOME`
- 同步会保留 bridge 自己的 `auth.json`、sessions、sqlite state 和 logs；`config.toml` 会过滤掉 root 级 `approval_policy`、`sandbox_mode`、`notify`

仓库默认会加载 `config/source-registry.json`，里面维护本机各业务项目的 repo / runtime / state / logs 入口；`SOURCE_REGISTRY_PATH` 只在你要覆盖这份默认表时才需要设置。

内置 fallback profile 会覆盖 bridge 自身：

- workspace repo：当前 checkout 或 `BRIDGE_WORKSPACE_ROOT`
- installed service copy：`~/Library/Application Support/telegram-codex-bridge-service`
- state：service copy 下的 `data/store.json`
- logs：service copy 下的 `data/logs`
- LaunchAgent：`com.sharenla.telegram-codex-bridge`

你也可以用 JSON 文件替换默认项目真相源：

```bash
SOURCE_REGISTRY_PATH=/absolute/path/source-registry.json
DESKTOP_CODEX_HOME=~/.codex
CODEX_CONTEXT_SYNC=1
```

示例：

```json
{
  "projects": [
    {
      "id": "telegram-codex-bridge",
      "name": "Telegram Codex Bridge",
      "root": "~/Documents/Playground/telegram-codex-bridge",
      "aliases": [
        "~/Library/Application Support/telegram-codex-bridge-service"
      ],
      "sources": {
        "canonicalRepo": "~/Documents/Playground/telegram-codex-bridge",
        "installedServiceCopy": "~/Library/Application Support/telegram-codex-bridge-service",
        "stateFiles": [
          "~/Library/Application Support/telegram-codex-bridge-service/data/store.json"
        ],
        "logs": [
          "~/Library/Application Support/telegram-codex-bridge-service/data/logs"
        ],
        "launchAgents": [
          "com.sharenla.telegram-codex-bridge"
        ],
        "codexHomes": [
          "~/.codex"
        ]
      },
      "mustCheckBeforeAnswer": [
        "For bridge behavior, verify the installed service copy, store.json, logs, and LaunchAgent before trusting the workspace checkout."
      ],
      "neverAssume": [
        "Do not assume workspace edits are live until the installed service copy is synced or checked."
      ]
    }
  ]
}
```

### 多机器注意事项

- 这个 bridge 目前使用 Telegram `getUpdates` 轮询
- **同一个 bot token，同一时刻只应该有一个活跃 bridge 实例**
- 如果同一个 token 同时跑在两台机器上，更新会被两边抢，常见现象包括：
  - 某台机器突然不回
  - thread 重复创建
  - 上下文表现混乱

如果你要两台机器同时在线，建议：

- 每台机器一个独立 bot token
- 或者同一时刻只保留一台 bridge 在线

### 单账号 / 多账号

- 单账号完全可以用：把 `.env` 里的 `CODEX_ACCOUNTS_SOURCE` 留空即可
- 多账号时，把 `CODEX_ACCOUNTS_SOURCE` 指向 OpenClaw 的 `auth-profiles.json`；多个账号池可以用逗号分隔，bridge 会按账号去重并保留最新 token
- 建议保留：

```bash
CODEX_AUTO_ACCOUNT_FAILOVER=1
# optional: try these accounts only after other usable accounts
CODEX_LAST_RESORT_ACCOUNTS=someone@example.com
```

这样遇到 429 / quota / rate-limit 这类账号层错误时，会按账号池优先级自动切到下一个账号再重试；每个新 Codex turn 开始前也会主动跳出临时坏号、已过期账号或 last-resort 账号。

`CODEX_LAST_RESORT_ACCOUNTS` 可以填邮箱、profileId 或 accountId；匹配到的账号仍可手动 `/account` 选择，但自动启动和故障切换会优先尝试其他可用账号。

### Codex-lb backend

如果本机已经运行 `codex-lb`，bridge 可以继续使用 Codex `app-server` 事件流，同时把上游 Codex API 交给 `codex-lb`：

```bash
CODEX_BACKEND=codex-lb
CODEX_LB_CODEX_BASE_URL=http://127.0.0.1:2455/backend-api/codex
# 如果 codex-lb 启用了 API key：
CODEX_LB_ENV_KEY=CODEX_LB_API_KEY
CODEX_LB_API_KEY=sk-clb-...
```

启用后，bridge 会在同步桌面端 Codex context 之后，把官方 Codex CLI provider block 写入独立的 `CODEX_HOME/config.toml`，不会改桌面端 `~/.codex/config.toml`。

### 上下文占用与手动压缩

- bridge 会记录最近一次 `token_count`；`contextTokens` 使用 Codex 上报的 total usage 计算上下文占用，`lastTurnTokens` 只表示最近一轮输入输出
- `/status` 会显示 `contextUsage / contextTokens / contextWindow / lastTurnTokens`
- 当占用率接近阈值时，`/status` 会标记 `compactionPending`
- 默认只观测，不会自动压缩
- 你可以在空闲时手动执行 `/compact`
- `/compact` 会先让旧 thread 生成 5 段摘要，再切到新 thread
- 老 thread 会保留；新 thread 的第一条真实用户消息会自动带上摘要包继续
- 如果你想启用自动压缩，可以设置：

```bash
AUTO_COMPACT=1
CONTEXT_SOFT_RATIO=0.70
CONTEXT_HARD_RATIO=0.82
CONTEXT_EMERGENCY_RATIO=0.90
```

- `soft` 只标记待压缩
- `hard` 会在当前 turn 结束后优先自动压缩
- `emergency` 会暂停继续接收新任务，优先自动压缩
- 遇到明显的上下文相关失败时，bridge 会尝试“压缩后自动重试一次”，普通错误不会触发这条链路

### 安全档位

这个 bridge 的权限行为，主要由三项决定：

- `CODEX_SANDBOX`
- `CODEX_APPROVAL_POLICY`
- `AUTO_APPROVE`

#### 1. 默认安全档

```bash
CODEX_APPROVAL_POLICY=untrusted
CODEX_SANDBOX=workspace-write
AUTO_APPROVE=0
```

适合第二台电脑或长期常驻环境。Codex 只能在当前 workspace 内操作，而且关键动作需要你在 Telegram 里批准。

#### 2. 高效率项目档

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX=workspace-write
AUTO_APPROVE=1
```

适合你信任 bot，但希望活动范围仍然限制在当前项目目录。

#### 3. 满权限档

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX=danger-full-access
AUTO_APPROVE=1
```

适合你明确要“像坐在电脑前一样”让它接管整机。风险等同于给 Telegram bot 远程 shell。

### 安全提醒

- **务必配置 `TELEGRAM_ALLOWLIST`**
- Telegram bot 对话不是端到端加密
- 开启 `danger-full-access` 前，请确认：
  - 机器是你自己的
  - bot 白名单正确
  - 重要数据已有备份

<a id="english"></a>

## English

### What this is

This project forwards Telegram messages to a local `codex app-server`, then sends Codex progress updates, tool activity, and final answers back to Telegram.

It is designed to feel closer to Codex GUI than a one-shot `codex exec` wrapper:

- persistent conversation
- thread / turn continuity
- visible tool progress
- model / effort / workspace switching
- optional OpenClaw account-pool failover

### `codex-cli` vs `app-server`

- Seeing “`codex-cli 0.x is available`” during installation is expected.
- This bridge launches the `app-server` subcommand from your local `codex` binary:

```bash
codex app-server --listen stdio://
```

- So your local `codex` / `codex-cli` version directly determines whether `app-server` can start correctly and which protocol features are available.

### Common commands

- Send plain text: start a Codex `turn/start`
- `/menu`: open the shortcut button panel
- `/status`: show current `thread / model / effort / cwd` plus the latest context-usage snapshot
- `/truth`: show the current repo / runtime / state / logs source-of-truth profile
- `/refresh`: rebind the current source profile and inject a source-of-truth bootstrap into the next user turn
- `/new`: start a new thread
- `/compact`: compact the current thread into a fresh thread with a summary bootstrap
- `/stop`: interrupt the current turn; in groups it also clears queued follow-up tasks
- `/cwd /abs/path`: switch working directory
- `/projects`: list source-of-truth projects
- `/project <index|id|path>`: switch project and reset the thread
- `/sessions`: list recent Codex sessions for the current cwd
- `/resume <index|threadId>`: bind this Telegram chat to an existing Codex thread
- `/handback`: print a local `codex resume` command for the current thread
- `/continue <message>`: force one natural-language turn when another chat is busy in the same workspace
- `/diff`, `/git status`, `/test`, `/review`, `/rollback`: explicit engineering commands; plain natural-language interaction is unchanged
- `/models`: show recommended models; built-in short aliases are `5.2 / 5.4 / 5.5`
- `/model 5.4`: switch model (stored as `gpt-5.4`)
- `/model 5.5 xhigh`: switch model and reasoning effort together
- `/efforts`: show reasoning-effort options
- `/effort xhigh`: raise reasoning effort
- `/think medium`: alias for `/effort`
- `/autoroute auto`: enable automatic model/effort routing by task difficulty; also supports `off / suggest / lock / unlock`
- `/route <message>`: preview which model and effort a message would use
- `/extensions`: read-only inventory of app-server skills / apps / MCP / plugins
- `/skills`, `/apps`, `/mcp`, `/plugins`: inspect one extension subsystem; commands that accept `refresh` force a fresh read
- `/accounts`: show account pool
- `/account 2`: switch to account #2
- `/authsync`: resync latest auth from account pool and restart the Codex backend (useful after token drift/stream disconnect)
- `/answer <token> ...`: answer an input request

Automatic routing is off by default so upgrades do not change existing chat behavior. Set `CODEX_AUTO_ROUTE=auto` or send `/autoroute auto` to classify each new turn before it starts: simple text tasks use `gpt-5.2 / low`, normal coding tasks use `gpt-5.4 / high`, and live/runtime/auth/deploy/trading/root-cause signals use `gpt-5.5 / xhigh`. `/autoroute suggest` records/previews without overriding; `/autoroute lock` keeps the current manual choice.

Extension commands are read-only by default and never install or enable plugins. When a plain message includes `$app`, `$skill`, or `$plugin` names, the bridge best-effort converts them into precise Codex app-server `mention` input; if the active app-server does not support the matching list method, the text is sent unchanged.

Desktop-parity commands focus on choosing the right project, attaching existing threads, and handing work back to local Codex. `/projects` uses the same source registry so Telegram chats do not stay stuck at `/Users/wukong`; `/sessions` and `/resume` use app-server thread listing/resume; `/handback` is the Telegram-to-local CLI bridge. The bridge stores threads per chat + project and restores the project thread when you switch back. If another chat has an active turn in the same workspace, plain natural-language tasks are blocked by default; `/continue` bypasses that guard for one turn.

Explicit engineering commands are additive and do not change the plain natural-language path. `/diff` and `/git status` are read-only; `/test` runs `npm test` only when the current cwd has `package.json` with `scripts.test`; `/review` asks Codex to review the current working tree diff; `/rollback` prints candidate rollback commands and does not execute destructive operations.

### Group behavior

- In groups, the bot only responds when it is **mentioned** or when someone **replies directly to the bot**
- Normal group chatter is ignored
- If a group turn is already running, new group tasks are queued instead of steering the active turn
- If you want to change direction immediately, send `/stop` first and then send the new task
- Group progress messages are redacted by default:
  - textual progress is kept
  - code, file paths, command output, and diffs are hidden
- Final group answers are shown without redaction by default

### Start and stop with Codex

If you want the bridge to start when Codex opens and stop when Codex closes on macOS:

```bash
npm run install:launch-agent
```

This installs a `launchd` agent and syncs the runtime copy to:

`~/Library/Application Support/telegram-codex-bridge-service`

To uninstall:

```bash
npm run uninstall:launch-agent
```

### Telegram transport / proxy

If Telegram is unstable on your network, you can force bridge-side Telegram requests through a local proxy:

```bash
TELEGRAM_PROXY_URL=http://127.0.0.1:1082
TELEGRAM_POLL_TIMEOUT_SECONDS=5
```

- `TELEGRAM_PROXY_URL` usually points to your local Clash / Mihomo `mixed-port`
- When left empty, the bridge prefers direct access; if it detects a local Clash Verge config, it will also try that `mixed-port`
- If you explicitly want direct mode, set:

```bash
TELEGRAM_PROXY_URL=direct
```

### Codex upstream proxy

Note: `TELEGRAM_PROXY_URL` only affects Telegram. It does not affect Codex (`codex app-server`).

If chatgpt.com is flaky/blocked on your network, set an upstream proxy so the spawned `codex app-server` inherits it:

```bash
HTTPS_PROXY=http://127.0.0.1:1082
# or:
ALL_PROXY=socks5h://127.0.0.1:1082
```

### Source Registry

Telegram should only be the transport. To make bridge behavior closer to the Codex desktop app, the bridge keeps a source-of-truth profile per chat:

- `/project /abs/path` switches `cwd`, resets the thread, and rebinds the project truth profile
- `/truth` shows the active repo, live runtime, service copy, state files, logs, LaunchAgent, and Codex homes
- `/refresh` recomputes the binding and makes the next real user message carry a source-of-truth bootstrap
- when no profile matches, the bridge falls back to `cwd-only` and warns the agent not to treat cwd as live runtime truth
- on startup, the bridge syncs desktop memories / skills / plugins / rules from `DESKTOP_CODEX_HOME` into the bridge's separate `CODEX_HOME`
- the sync preserves the bridge's own `auth.json`, sessions, sqlite state, and logs; `config.toml` is filtered to drop root-level `approval_policy`, `sandbox_mode`, and `notify`

By default, the bridge loads `config/source-registry.json`, which maps local business projects to their repo / runtime / state / log sources. Set `SOURCE_REGISTRY_PATH` only when you want to override that default registry.

The built-in fallback profile covers the bridge itself:

- workspace repo: current checkout or `BRIDGE_WORKSPACE_ROOT`
- installed service copy: `~/Library/Application Support/telegram-codex-bridge-service`
- state: `data/store.json` under the service copy
- logs: `data/logs` under the service copy
- LaunchAgent: `com.sharenla.telegram-codex-bridge`

You can replace the default project truth registry with a JSON file:

```bash
SOURCE_REGISTRY_PATH=/absolute/path/source-registry.json
DESKTOP_CODEX_HOME=~/.codex
CODEX_CONTEXT_SYNC=1
```

Example:

```json
{
  "projects": [
    {
      "id": "telegram-codex-bridge",
      "name": "Telegram Codex Bridge",
      "root": "~/Documents/Playground/telegram-codex-bridge",
      "aliases": [
        "~/Library/Application Support/telegram-codex-bridge-service"
      ],
      "sources": {
        "canonicalRepo": "~/Documents/Playground/telegram-codex-bridge",
        "installedServiceCopy": "~/Library/Application Support/telegram-codex-bridge-service",
        "stateFiles": [
          "~/Library/Application Support/telegram-codex-bridge-service/data/store.json"
        ],
        "logs": [
          "~/Library/Application Support/telegram-codex-bridge-service/data/logs"
        ],
        "launchAgents": [
          "com.sharenla.telegram-codex-bridge"
        ],
        "codexHomes": [
          "~/.codex"
        ]
      },
      "mustCheckBeforeAnswer": [
        "For bridge behavior, verify the installed service copy, store.json, logs, and LaunchAgent before trusting the workspace checkout."
      ],
      "neverAssume": [
        "Do not assume workspace edits are live until the installed service copy is synced or checked."
      ]
    }
  ]
}
```

### Multi-machine note

- The bridge currently uses Telegram `getUpdates` polling
- **A single bot token should only have one active bridge instance at a time**
- If the same token runs on two machines at once, they will race for updates and you will likely see:
  - one machine stops replying
  - duplicate thread creation
  - broken or confusing context continuity

If you need two machines online at the same time:

- use a different bot token per machine
- or keep only one bridge instance active at a time

### Single-account / multi-account

- Single-account setups work fine: leave `CODEX_ACCOUNTS_SOURCE` empty
- For multi-account setups, point `CODEX_ACCOUNTS_SOURCE` to OpenClaw’s `auth-profiles.json`; multiple pools can be comma-separated, and the bridge deduplicates by account while keeping the freshest token
- Recommended:

```bash
CODEX_AUTO_ACCOUNT_FAILOVER=1
# optional: try these accounts only after other usable accounts
CODEX_LAST_RESORT_ACCOUNTS=someone@example.com
```

That allows the bridge to switch to the next account by account-pool priority and retry when it hits account-level failures such as 429, quota, or rate-limit errors. Before each new Codex turn, it also proactively leaves temporarily unhealthy, expired, or last-resort accounts when a better account is available.

`CODEX_LAST_RESORT_ACCOUNTS` accepts emails, profileIds, or accountIds. Matching accounts remain manually selectable with `/account`, but automatic startup and failover prefer other usable accounts first.

### Codex-lb backend

When a local `codex-lb` service is already running, the bridge can keep using Codex `app-server` for streaming events while routing the upstream Codex API through `codex-lb`:

```bash
CODEX_BACKEND=codex-lb
CODEX_LB_CODEX_BASE_URL=http://127.0.0.1:2455/backend-api/codex
# If codex-lb API key auth is enabled:
CODEX_LB_ENV_KEY=CODEX_LB_API_KEY
CODEX_LB_API_KEY=sk-clb-...
```

When enabled, the bridge writes the official Codex CLI provider block into its isolated `CODEX_HOME/config.toml` after desktop context sync. It does not modify the desktop `~/.codex/config.toml`.

### Context Usage And Manual Compaction

- the bridge records the latest `token_count` snapshot; `contextTokens` comes from Codex total usage and drives context occupancy, while `lastTurnTokens` is only the latest turn
- `/status` shows `contextUsage / contextTokens / contextWindow / lastTurnTokens` and whether compaction is pending
- automatic compaction is still off by default
- you can trigger manual compaction with `/compact` only when the chat is idle
- `/compact` asks the old thread for a fixed 5-section summary, then switches the chat to a fresh thread
- the old thread is kept intact, and the first real user message on the new thread automatically carries the summary bootstrap
- to enable automatic compaction, set:

```bash
AUTO_COMPACT=1
CONTEXT_SOFT_RATIO=0.70
CONTEXT_HARD_RATIO=0.82
CONTEXT_EMERGENCY_RATIO=0.90
```

- `soft` only marks the thread as pending compaction
- `hard` auto-compacts after the current turn finishes
- `emergency` stops accepting new work and prioritizes compaction first
- when the failure clearly looks context-related, the bridge attempts one compact-and-retry cycle; ordinary errors do not trigger this path

### Security profiles

The bridge behavior is mainly controlled by:

- `CODEX_SANDBOX`
- `CODEX_APPROVAL_POLICY`
- `AUTO_APPROVE`

#### 1. Safer default

```bash
CODEX_APPROVAL_POLICY=untrusted
CODEX_SANDBOX=workspace-write
AUTO_APPROVE=0
```

Good for a second machine or a long-running remote setup. Codex stays inside the current workspace and asks for approval before risky actions.

#### 2. Fast project mode

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX=workspace-write
AUTO_APPROVE=1
```

Good when you trust the bot and want a near-GUI experience, while still keeping Codex limited to the current project directory.

#### 3. Full-access mode

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX=danger-full-access
AUTO_APPROVE=1
```

Good only when you explicitly want the bot to operate like you are sitting at the machine. This is effectively remote-shell-level access.

### Safety notes

- **Always configure `TELEGRAM_ALLOWLIST`**
- Telegram bot chats are not end-to-end encrypted
- Before enabling `danger-full-access`, make sure:
  - the machine is yours
  - the allowlist is correct
  - important data is backed up

## License

- ISC — see `LICENSE`
