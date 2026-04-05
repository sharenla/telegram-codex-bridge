# Telegram Codex Bridge (Codex GUI-like, via `codex app-server`)

把 Telegram 里的消息转发到本机 `codex app-server`，并把 Codex 的流式输出、命令输出、diff（预览）回传到 Telegram。

## `codex-cli` 和 `app-server` 的关系

- 安装反馈里写“可用 `codex-cli 0.118.0-alpha.2`”是正常的，因为 bridge 并不是绕过 CLI 单独调用别的程序。
- 实际上它启动的是本机 `codex` 二进制里的 `app-server` 子命令，也就是类似：

```bash
codex app-server --listen stdio://
```

- 所以本机 `codex` / `codex-cli` 的版本，直接决定了 `app-server` 能不能正常握手、支持哪些协议能力。

## 快速开始

1. 创建 Telegram bot，拿到 `TELEGRAM_BOT_TOKEN`
2. 安装依赖并配置环境变量：

```bash
git clone <your-private-repo-url>
cd telegram-codex-bridge
cp .env.example .env
nano .env  # 填上 TELEGRAM_BOT_TOKEN 和 TELEGRAM_ALLOWLIST
npm i
npm start
```

> `TELEGRAM_ALLOWLIST` 需要填你的 chat id（私聊是正数；群通常是负数）。  
> 现在最简单的获取方式是：
> `npm run discover-chat`
> 然后给 bot 发一条消息，终端会直接打印可用的 `chat_id`。

3. 在 Telegram 私聊 bot：
   - 直接发文本 = 发起一次 Codex `turn/start`
   - `/new` 新开线程（thread）
   - `/stop` 中断当前 turn
   - `/accounts` 查看可用账号池
   - `/account 2` 切到第 2 个 Codex 账号，保持同一个 thread 继续
   - 如果当前账号碰到额度/限流，bridge 会自动切到下一个本机账号并重试一次
   - `/cwd /abs/path` 切换工作目录
   - `/project /abs/path` 切换项目并重置 thread
   - `/menu` 打开快捷按钮面板
   - `/models` 查看推荐模型
   - `/efforts` 查看思考级别
   - `/model gpt-5.4-mini` 切模型
   - `/effort xhigh` 调高推理强度
   - `/status` 查看 thread/turn 状态
   - 当 Codex 需要你输入时：按按钮或用 `/answer <token> ...`

## 开机 / 跟随 Codex 启动

- **当前默认行为**：如果只是重启电脑然后打开 Codex，bridge **不会**自己起来，除非你手动 `npm start`。
- 如果你想要“打开 Codex 就自动带起 Telegram bridge，关闭 Codex 就停掉 bridge”，运行：

```bash
npm run install:launch-agent
```

- 它会在 macOS 里安装一个 `launchd` agent，常驻监听 `Codex.app` 进程；当 Codex 打开时自动启动 bridge，当 Codex 退出时自动停掉 bridge。
- 为了避开 macOS 对 `Documents` 目录的后台访问限制，安装时会把运行副本同步到 `~/Library/Application Support/telegram-codex-bridge-service`，仓库本身仍然保留在你的开发目录里。
- 卸载自动启动：

```bash
npm run uninstall:launch-agent
```

## 单账号 / 多账号

- 如果另一台电脑现在只有 **1 个账号**，完全没问题：把 `.env` 里的 `CODEX_ACCOUNTS_SOURCE` 留空，bridge 仍然正常工作。
- 如果未来那台机器加了更多账号，再把 `CODEX_ACCOUNTS_SOURCE` 指到本机的 OpenClaw `auth-profiles.json`，轮询/切号机制就会自动生效。
- 建议始终保留 `CODEX_AUTO_ACCOUNT_FAILOVER=1`，这样多账号环境下遇到限流会自动换“电池”。

## 安全档位

- 这个 bridge 里真正影响“危险程度”的，主要是三项：
  - `CODEX_SANDBOX`
  - `CODEX_APPROVAL_POLICY`
  - `AUTO_APPROVE`
- 它们的职责分别是：
  - `CODEX_SANDBOX`：Codex **最多能碰到哪里**
  - `CODEX_APPROVAL_POLICY`：Codex **是否倾向于先发起审批**
  - `AUTO_APPROVE`：bridge 收到审批请求后，**是自动同意还是在 Telegram 里问你**

### 推荐 1：远程默认安全档

```bash
CODEX_APPROVAL_POLICY=untrusted
CODEX_SANDBOX=workspace-write
AUTO_APPROVE=0
```

- 适合：第二台电脑、长期常驻、偶尔远程修项目
- 效果：Codex 只能在你当前工作目录里改东西；命令执行/文件修改需要你在 Telegram 里点批准

### 推荐 2：可信项目高效率档

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX=workspace-write
AUTO_APPROVE=1
```

- 适合：你完全信任这个 bot，只想让它在某个项目目录里快速干活
- 效果：基本不再弹审批，但活动范围仍然被限制在当前 workspace

### 推荐 3：满权限档

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX=danger-full-access
AUTO_APPROVE=1
```

- 适合：你明确要“像坐在电脑前一样”让它接管整机
- 效果：Codex 可以读写整机、跑任意命令、改任意路径；Telegram bot 一旦被拿到，风险等同于远程 shell
- 只建议在：
  - bot 严格白名单
  - 机器是你自己的
  - 重要数据已备份
  - 你清楚这是“全权放行”

## 我建议你怎么选

- **主力电脑**：如果你就是要复现“Codex GUI 原生能力”，用满权限档。
- **另一台只有 1 个账号的电脑**：先用“可信项目高效率档”更稳，通常已经够像 GUI 了。
- 只有当你希望它跨项目、跨家目录、直接动系统脚本时，再切到 `danger-full-access`。

## 多账号说明

- 建议把 `CODEX_HOME` 指向一个 **bridge 专用目录**，这样 Telegram 侧切账号不会影响本地 Codex GUI。
- `CODEX_ACCOUNTS_SOURCE` 目前支持直接读取 OpenClaw 的 `auth-profiles.json` 里的 `openai-codex` OAuth 账号池。
- 这套切号逻辑保留同一个 `CODEX_HOME` 的 rollout/thread 状态，只替换 `auth.json`，因此可以实现“换电池但不换任务”。
- `CODEX_AUTO_ACCOUNT_FAILOVER=1` 时，如果遇到 429 / quota / rate-limit 这类账号层面的错误，bridge 会按账号池顺序自动换下一个账号再重试。

## 安全建议（强烈）

- **务必配置 `TELEGRAM_ALLOWLIST`**（只允许你的 chat id / 群 id），否则任何人都可能控制你电脑上的 Codex。
- Telegram bot 对话 **不是端到端加密**；不要把密钥/隐私直接发在群里。
- `CODEX_SANDBOX=danger-full-access` 等同“完全权限”，建议只在你明确要整机接管时启用，并备份重要文件。
