# Telegram Codex Bridge (Codex GUI-like, via `codex app-server`)

把 Telegram 里的消息转发到本机 `codex app-server`，并把 Codex 的流式输出、命令输出、diff（预览）回传到 Telegram。

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

## 单账号 / 多账号

- 如果另一台电脑现在只有 **1 个账号**，完全没问题：把 `.env` 里的 `CODEX_ACCOUNTS_SOURCE` 留空，bridge 仍然正常工作。
- 如果未来那台机器加了更多账号，再把 `CODEX_ACCOUNTS_SOURCE` 指到本机的 OpenClaw `auth-profiles.json`，轮询/切号机制就会自动生效。
- 建议始终保留 `CODEX_AUTO_ACCOUNT_FAILOVER=1`，这样多账号环境下遇到限流会自动换“电池”。

## 多账号说明

- 建议把 `CODEX_HOME` 指向一个 **bridge 专用目录**，这样 Telegram 侧切账号不会影响本地 Codex GUI。
- `CODEX_ACCOUNTS_SOURCE` 目前支持直接读取 OpenClaw 的 `auth-profiles.json` 里的 `openai-codex` OAuth 账号池。
- 这套切号逻辑保留同一个 `CODEX_HOME` 的 rollout/thread 状态，只替换 `auth.json`，因此可以实现“换电池但不换任务”。
- `CODEX_AUTO_ACCOUNT_FAILOVER=1` 时，如果遇到 429 / quota / rate-limit 这类账号层面的错误，bridge 会按账号池顺序自动换下一个账号再重试。

## 安全建议（强烈）

- **务必配置 `TELEGRAM_ALLOWLIST`**（只允许你的 chat id / 群 id），否则任何人都可能控制你电脑上的 Codex。
- Telegram bot 对话 **不是端到端加密**；不要把密钥/隐私直接发在群里。
- `CODEX_SANDBOX=danger-full-access` 等同“完全权限”，建议在独立账号/隔离目录中运行，并备份重要文件。
