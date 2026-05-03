# Telegram Codex Bridge 命令说明

这份文档记录当前 Telegram 里可用的 bridge 命令。默认用法很简单：直接发自然语言给 bot，它就会把这条消息作为一次 Codex 任务处理。下面这些 slash 命令是额外的控制入口。

## 最常用

- `/help` 或 `/start`：显示命令帮助。
- `/status`：查看当前会话状态。会显示当前 thread、正在跑的 turn、排队任务、cwd、真相源、模型、effort、账号、backend、Telegram polling、上下文占用等信息。
- `/menu`：打开快捷设置面板。
- `/stop`：中断当前正在跑的任务。群聊里还会清掉已经排队的新任务。

## 项目和真相源

这组命令用于避免 Telegram 会话跑错目录、读错项目、接错真相源。

- `/truth`：查看当前 chat 绑定的 source-of-truth 项目，包括项目名、根目录和相关真相源规则。
- `/refresh`：重新加载 source registry，并刷新当前 chat 的真相源绑定。下一次自然语言任务会附带新的 source-of-truth bootstrap。
- `/projects`：列出可选项目。
- `/project <index|id|path>`：切换到某个项目。可以用 `/projects` 里的序号、项目 id，或者绝对路径。
- `/cwd <path>`：手动切换当前工作目录。

说明：bridge 会按 `chat + project` 保存 thread。你切到另一个项目后，再切回来，会优先恢复这个 chat 在该项目之前使用的 thread。

## Thread 和上下文

- `/new`：新开一个 Codex thread。
- `/compact`：把当前 thread 压缩成摘要，并切到一个新 thread。适合上下文太长、接近满的时候。
- `/sessions` 或 `/threads`：列出当前 cwd 下最近的 Codex sessions。
- `/resume <index|threadId>`：接回已有 Codex thread。可以先 `/sessions`，再用序号恢复。
- `/handback`：打印一条本机终端可执行的 `codex resume` 命令，方便从 Telegram 切回本机 Codex。

## 显式工程命令

这些命令是新增控制项，不改变普通自然语言交互。你不使用它们时，原来的聊天方式不变。

- `/diff` 或 `/git diff`：查看当前 git diff。群聊里只显示摘要，私聊里会显示更完整的 diff 预览。
- `/git status` 或 `/status git`：查看当前仓库状态。
- `/test`：运行当前项目的测试。目前只自动识别 `package.json` 里的 `scripts.test`，也就是运行 `npm test`。
- `/review`：让 Codex 以 code review 方式检查当前工作树 diff。它只提问题，不改文件。
- `/rollback`：只打印候选回滚命令，不会真的执行 `git restore`、`git clean` 或删除文件。
- `/continue <message>`：同一个 workspace 如果另一个 chat 正在跑任务，普通自然语言新任务会被挡住；这个命令可以单次强制继续。

## 模型和思考强度

- `/models`：查看推荐模型和短别名。
- `/model`：查看当前模型。
- `/model <5.2|5.4|5.5|model-id> [effort]`：切换模型，也可以顺手切换 effort。例如 `/model 5.5 xhigh`。
- `/efforts`：查看可选 reasoning effort。
- `/effort <none|minimal|low|medium|high|xhigh>`：切换 reasoning effort。
- `/think <...>` 或 `/thinking <...>`：`/effort` 的别名。

## 自动路由

自动路由用于让 bridge 根据任务难度选择模型和 effort。默认关闭，避免升级后改变已有使用习惯。

- `/autoroute`：查看当前自动路由状态。
- `/autoroute off`：关闭自动路由。
- `/autoroute suggest`：只预览推荐路线，不自动改模型。
- `/autoroute auto`：自动应用推荐模型和 effort。
- `/autoroute lock`：锁住当前手动选择的模型和 effort。
- `/autoroute unlock`：解除锁定。
- `/route <message>`：不真正执行任务，只预览这条消息会被分到什么模型和 effort。

## 扩展、插件和 MCP

这些命令默认只读，用来查看当前 Codex app-server 能看到什么能力。

- `/extensions`：查看 skills、apps、MCP、plugins 总览。
- `/extensions refresh`：强制刷新扩展总览。
- `/skills` 或 `/skills refresh`：查看 Codex skills。
- `/apps` 或 `/apps refresh`：查看 apps/connectors。
- `/mcp` 或 `/mcp status`：查看 MCP server 状态。
- `/mcp reload`：让 Codex app-server 重新加载 MCP server 配置。
- `/plugins` 或 `/plugins refresh`：查看插件发现结果。

普通消息里如果写 `$app`、`$skill` 或 `$plugin` 名称，bridge 会尽量转换成 Codex app-server 的精确 mention input；如果当前 app-server 不支持对应列表接口，就按普通文本发送。

## 账号和认证

- `/accounts`：查看可用 Codex 账号池。
- `/account <id|index>`：切换 Codex 账号，不主动丢弃当前 thread。
- `/authsync`：重新同步 Codex auth，并重启 Codex backend。常用于 token 失效、401、断流之后自救。

## 需要输入时

- `/answer <token> <text>`：回答 Codex 主动提出的问题。平时不用主动使用，只有 bot 给了 token 时才需要。

## 群聊规则

- 群聊里只有 `@bot` 或直接回复 bot 的消息才会触发。
- 群聊里当前任务还在跑时，新任务会排队，不会直接改写当前任务。
- 想临时换方向，先发 `/stop`，再发新任务。
- 群聊会自动隐藏代码、路径、命令输出和 diff，只保留更适合公开群聊的进度描述；私聊保持完整。

## 安全边界

- 普通自然语言任务仍然是主路径。
- 显式工程命令是增加项，不是替换项。
- `/diff`、`/git status` 是只读。
- `/review` 只审查，不改文件。
- `/rollback` 只给候选命令，不执行破坏性操作。
- 同 workspace 跨 chat 并发默认会被挡住，除非你明确用 `/continue <message>` 绕过一次。
