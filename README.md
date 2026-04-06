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
- `/status`：查看当前 `thread / model / effort / cwd`
- `/new`：新开线程
- `/stop`：中断当前 turn
- `/cwd /abs/path`：切换工作目录
- `/project /abs/path`：切换项目并重置 thread
- `/models`：查看推荐模型
- `/model gpt-5.4-mini`：切模型
- `/efforts`：查看思考级别
- `/effort xhigh`：切换思考强度
- `/accounts`：查看账号池
- `/account 2`：切到第 2 个账号
- `/answer <token> ...`：回答需要输入的问题

### 群聊行为

- 群里只有 **@bot** 或 **直接回复 bot** 的消息才会触发
- 普通群消息会被忽略
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
- 多账号时，把 `CODEX_ACCOUNTS_SOURCE` 指向 OpenClaw 的 `auth-profiles.json`
- 建议保留：

```bash
CODEX_AUTO_ACCOUNT_FAILOVER=1
```

这样遇到 429 / quota / rate-limit 这类账号层错误时，会自动切到下一个账号再重试

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
- `/status`: show current `thread / model / effort / cwd`
- `/new`: start a new thread
- `/stop`: interrupt the current turn
- `/cwd /abs/path`: switch working directory
- `/project /abs/path`: switch project and reset the thread
- `/models`: show recommended models
- `/model gpt-5.4-mini`: switch model
- `/efforts`: show reasoning-effort options
- `/effort xhigh`: raise reasoning effort
- `/accounts`: show account pool
- `/account 2`: switch to account #2
- `/answer <token> ...`: answer an input request

### Group behavior

- In groups, the bot only responds when it is **mentioned** or when someone **replies directly to the bot**
- Normal group chatter is ignored
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
- For multi-account setups, point `CODEX_ACCOUNTS_SOURCE` to OpenClaw’s `auth-profiles.json`
- Recommended:

```bash
CODEX_AUTO_ACCOUNT_FAILOVER=1
```

That allows the bridge to switch to the next account and retry when it hits account-level failures such as 429, quota, or rate-limit errors.

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
