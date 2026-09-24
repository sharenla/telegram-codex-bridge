# Progress Log

计划 `task_plan.md`，证据 `findings.md`，执行约束 `handoff_codex.md`。
阶段状态只用 `pending` / `in_progress` / `complete`，与 `task_plan.md` 保持一致。
**遇阻立即停止，写入下方 Error Log，不要自行扩大范围。**

## Session: 2026-09-21

### 调查与规划（本会话已完成，不属于 Phase 1–4）

- **Status:** complete
- **执行者：** Claude Code（longxia 机器，经 SSH `remote-mac-wukong` 读取 wukong）
- Actions taken:
  - 核对本机 Codex 提交的故障统计：8 项数字复算一致，3 项报偏，5 类完全漏掉（`findings.md` F2–F4）
  - 统计 W-SVC 的 25,958 行 stderr 与 38 个 rollout，得出 turn 级失败分类与 24 个孤儿 turn（F5）
  - 定位 9 条根因 R1–R9，全部落到具体行号（F6）
  - 查清代码版本考古：四份副本、三个版本，双向 diff 确认工作区为严格超集（F8）
  - 确认最高优先风险：整个多实例功能未提交且无 stash（F10）
  - 采集改动前基线：`tests 99 / pass 99 / fail 0`（F13）
  - 用 `init-session.sh "Bridge Reliability"` 建立本计划目录
- Files created/modified:
  - `.planning/2026-09-21-bridge-reliability/task_plan.md`
  - `.planning/2026-09-21-bridge-reliability/findings.md`
  - `.planning/2026-09-21-bridge-reliability/progress.md`
  - `.planning/2026-09-21-bridge-reliability/handoff_codex.md`
  - `.planning/.active_plan`（由 init 脚本写入）
  - 删除首版 `docs/bridge-reliability/`（迁移到本目录，避免两份真相）
- **未改动任何业务代码**：`git diff --shortstat` 保持 `9 files changed, 510 insertions(+), 27 deletions(-)`

### Phase 1: 基线与版本对齐

- **Status:** complete
- **Started:** 2026-09-21
- Actions taken:
  - T1.1：已完成四份计划阅读；当前分支 main，原业务改动仍为 9 files / +510 / -27；未修改业务代码。
  - 指定检查复跑：node 语法、99/99 单测、四个 zsh 语法检查均通过。
  - 提交前快照如下（在 git add 前记录）。
- Files created/modified:
  - 本 progress.md、task_plan.md、findings.md（按本轮用户明确要求，只追加执行发现，保留原调查）。
- [ ] T1.1：提交前检查遇阻，尚未 commit；T1.2–T4.7 未开始。
- 阻塞详情：
  - 现象：git add -A 后，对暂存新增内容做不输出具体值的扫描，发现 3 行匹配 Telegram 群 ID 格式；两份 config/instances/*.env.example 第 3 行含实际 allowlist 格式的多个标识，tests/multi-instance-launch-agent.test.js 第 43 行亦含该格式的测试值。测试值是否虚构未核实，不据此断言泄密。
  - 已尝试：四份计划、git 状态/差异/stash/log、99 项单测及四脚本语法检查；提交前模式扫描未发现 Telegram token、sk- 格式 key 或私钥头（不代表完整凭据审计）。
  - 卡在哪：handoff §3.3 禁止提交聊天 ID，§3.2 禁止修改任何 .env.*（T1.3 的根 .env.example 另有特定例外），§3.3 禁止改已有测试断言。需要明确允许仅把两份实例 env.example 的 allowlist 改为占位符，并确认测试第 43 行可换为显式虚构值。
  - 影响面：未改业务代码、未提交、未部署、未重启；线上健康未另作验证。git add -A 已暂存原改动，仍含上述待处理值；不得直接提交。没有使用 reset/restore/stash 等禁用操作。
  - 建议：批准上述最小脱敏后继续 T1.1；或由维护者完成模板脱敏并确认测试值。未自行执行任一选项。

`git status --porcelain`
```text
 M .env.example
 M .gitignore
 M README.md
 M index.js
 M package.json
 M scripts/install-launch-agent.sh
 M scripts/uninstall-launch-agent.sh
 M tests/telegram-transport-recovery.test.js
 M tests/truth-profile.test.js
?? .planning/
?? AGENTS.md
?? config/instances/
?? docs/MULTI-INSTANCE.md
?? docs/bridge-reliability.md
?? tests/multi-instance-launch-agent.test.js
```

`git stash list`
```text

```

`git log --oneline -3`
```text
884811e Harden bridge transport recovery and log rotation
9bb7564 Harden bridge routing and turn privacy
cb6c0b2 Auto-run Deribit strategy approval gates
```


### Phase 2: 消除「完全无反馈」

- **Status:** complete
- T2.1–T2.8a 清单逐项核对均已打勾，T2.3a / T2.4a / T2.4b / T2.8a 行均保留；T2.8a 三实例 `/status` 已由维护者人工确认，Phase 2 进入合并与 tag 收口。
- Phase 2 已以 `git merge --no-ff` 并入 main；注解 tag `v0.2.0` 指向合并提交 `021139200a113d5cf1870246ed6a0c9a70abbd59`。三实例随后依序从 main 重装，`DEPLOYED_REF` 均指向该提交与 tag。
- T2.8a（2026-09-23）：跨目录同 token 抢锁缺陷已修复并灰度部署；三实例真实 `/status` 待维护者确认，Phase 2 收口尚未执行。
- T2.5（2026-09-23）：未完成，遇到 inbox 生命周期与重启复用 ack 的契约前提冲突，停止业务修改与部署；详见 Error Log 和末尾记录。
- Actions taken:
  - T2.4b completed and gray-deployed in the mandated order: rv-prediction → default → strategy-observation.
  - All three services are running the same `index.js` SHA-256 `3562402dbada`; each `DEPLOYED_REF` points to `364e0f3` and startup logs contain `Deployed ref`, `Telegram Codex Bridge started`, and `codeVersion=3562402d`.
  - rv-prediction observation round passed; named role files remained instance-specific and the redacted curl check showed one active long-poll child per bot with no stale duplicate.
- Files created/modified:
  - `index.js`, `tests/outbox.test.js`, this `progress.md`, and `task_plan.md`.

### Phase 3: 修重启死循环与失联可见

- **Status:** in_progress
- Actions taken:
  - T3.4c 实现提交 `5598e40`：切号验证成功立即清除 `authFailureUnresolved` 并复位 `codexBackend=ok`；失败切号保持 `auth_failing`。
  - T3.5 实现提交 `657df60`：supervisor 连续 3 次 unhealthy restart 后给 allowlist 正数私聊发一次脱敏告警；30 分钟持久限频；健康恢复发送一次恢复通知并保留发送时间；curl URL 从 stdin config 传入，token 不进 supervisor argv/日志；发送失败不影响重启循环。新增 supervisor 假 curl 测试 3 项。
  - T3.5 rv-prediction 已开始灰度并启动成功；因现网 bridge getUpdates curl 仍有 token argv（后续 T4.8 范围），部署门禁冲突，default/strategy 未安装本轮代码。
  - T3.4b / T3.4a 已灰度部署（2026-09-23）：代码 `adbcca8`、四份 index.js `4e0985bd0bb3`，200/200 通过；rv #023b89 已自然清台账。strategy 为 auth_failing；rv 启动后无新认证错误、仍为 ok，该额外验收未证实，不能当成账号恢复。详见末尾台账与人工验收；Next Step 为 T3.5。
  - T3.4b / T3.4a（2026-09-23）：维护者三份规划更新原样提交 `4eef88f`。认证 turn / stderr 看门狗 / 重跑请求失败统一终态、一次重跑上限、工具调用安全门、auth_failing 与私聊汇总去重已实现；重叠失联原因和本地秒级时间已修。新增 12 项测试，全套 200/200；准备灰度部署。
  - T3.4 灰度完成（2026-09-23）：提交 `8043a59` 按 rv → 观察 → default → strategy 安装；四份 index.js `8fea81fe48e7`，supervisor `2257af0ad696`；启动 1000/1704/1078 ms。三实例均已成功轮询且没有生成失联汇总；T3.4 已勾选，Next Step 为 T3.5。人工验收见末尾。
  - T3.4（2026-09-23）：维护者三份规划文件原样单独提交 `4279e79`。新增恢复汇总、延迟消息 ack 注记、正常关闭记录；网络恢复复用 T3.3 lastOutage，进程恢复使用启动前 lastPollSuccessAt。新增 12 项测试（先复现缺失与接入失败），全套 188/188；准备灰度部署。
  - T3.3 灰度完成（2026-09-23）：代码提交 `32d1202` 按 rv → 观察 → default → strategy 安装；四份 index.js `5334599a2dad`，supervisor 保持 `2257af0ad696`；appServerSpawnedMs 为 1175/1955/1011。检查与人工验收见末尾 T3.3 记录；Next Step 指向 T3.4。
  - T3.3（2026-09-23）：规划更新原样提交 `d36b4d8`。移除 pollingLoop 的卡死时长重启分支；`requestSupervisorRestart` 全仓只有该调用，移除后无其他调用方，故删除函数、私有标志与两项旧阈值。新增 30/90 秒状态迁移、失联起点/恢复时长持久化、2/4/8/16/30 秒退避与 `/status` 三字段；176/176 通过，准备灰度部署。Clash 调用条件、supervisor、现有 restartReason 清理逻辑未改。
  - T3.2 完成（2026-09-23）：代码提交 `6f7c701`；按 rv-prediction → 观察一轮 → default → strategy-observation 灰度部署。三实例新 Supervisor ready 分别为本次 17:20:41 / 17:21:42 / 17:22:18（UTC+8），均带 start_grace=60；脚本哈希 `2257af0ad696`，index.js 仍为 `1eacb1e58346`。详细证据与人工验收见末尾 T3.2 完成记录。
  - T3.2 续做（2026-09-23）：按已裁决的数值执行固定三级 60/120/300，原“翻倍”为规划方笔误；阻塞已解除。新增假 bridge / 假 app-server 的四项进程测试逐项先红后绿，170/170 通过；实现与检查完成，准备按 rv → default → strategy 灰度部署。新参数 START_GRACE_SECONDS 已在 `.env.example` 说明，supervisor 从进程环境读取，不读取 dotenv；测试用短基数按 1/2/5 比例缩短三级时间。
  - T3.2（2026-09-23）：维护者三份规划文件已在 `feat/phase-3-restart-loop` 原样单独提交为 `4838e81`。读取 supervisor 后停在实现前：规格同时要求每轮翻倍和 `60 → 120 → 300`，需要明确是否包含 240 秒这一轮，详见 Error Log。未改脚本、未运行新测试、未部署；T3.2 保持未勾选。
  - T3.1：main 上原样提交维护者的三份规划文件（`ddec91b`），建立 `feat/phase-3-restart-loop`；新增测试先在旧代码上失败，再实现缓存身份优先、后台 getMe 校验、身份变化持久化与实时方向判断。
  - 不移动 `startCodexServer()`；在实际 app-server 子进程创建后打印 `appServerSpawnedMs`。代码提交 `bfb8c79f4785fe848dfca32b41ad50faffb7c73f`，`index.js` SHA-256 前 12 位 `1eacb1e58346`。
  - 按 rv-prediction → 观察一轮 → default → strategy-observation 灰度安装。三实例启动计时分别为 **1854 / 2275 / 1414 ms**，均远小于 15000 ms；部署后三者轮询成功、错误计数 0。四份 `index.js` 哈希一致，三个 bridge 进程与各自锁 PID 对应，命名角色文件哈希与源文件一致；仅有三条由各自 bridge 持有的正常 getUpdates curl，没有残留孤儿进程。
- Files created/modified:
  - `index.js`、新增 `tests/startup-bot-identity.test.js`、本 `progress.md`、`task_plan.md`；`findings.md` 未改。

#### T3.1 启动前 await 审计（至 app-server 子进程创建）

| 等待点 | 可能访问网络 | 处理与边界 |
|--------|--------------|------------|
| `await discoverChatIds(telegram)` | 是，Telegram getMe/getUpdates | 仅显式 `--discover-chat-id` 诊断模式执行，随即退出；正常 LaunchAgent 启动路径不会进入。 |
| `await resolveStartupBotIdentity(...)` | 有缓存时 getMe 在后台访问 Telegram；无缓存时等待 Telegram getMe | 有完整缓存立即返回并并行校验，getMe 永不返回也不挡 app-server；首次安装无缓存仍等待，由 T3.2 启动宽限期兜底。 |
| `await startCodexServer()` 内 `await server.start()` | 否 | 仅本地 spawn；`appServerSpawnedMs` 在子进程创建后立即记录。 |
| `await startCodexServer()` 内 `await server.initialize()` | 可能等待 app-server 的 IPC 响应；此时子进程已创建 | 位于 spawn 之后，不影响 supervisor 的 15 秒子进程检测；未改 Codex 初始化协议。 |

此外，启动前的 `outbox.flush()` 可能访问 Telegram，但以 `void` 后台运行、未被 await；桌面上下文同步、账号资料读取和初始 profile 写入均为本地同步操作。`ensureHealthyStartupAccount()` 在 `startCodexServer()` 返回后后台执行，可能访问 chatgpt.com/codex-lb，不在创建子进程前的等待链上。函数定义内部的其余 `await` 仅在后续消息/恢复事件触发时执行。

维护者人工验收待执行：三个 bot 各发一次 `/status`，应看到 `codeVersion=1eacb1e5`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 与部署前一致。未调用生产 token 的 getUpdates 或模拟用户消息验证真实应答。

### Phase 4: 错误分类与可观测指标

- **Status:** pending
- Actions taken:
  -
- Files created/modified:
  -

---

### Phase 4: 中文反馈补全与收尾

- **Status:** in_progress
- **T4.9 实现：** app-server 非预期退出时，running activeRequests 的 ack 改为「⚠️ Codex 后端意外退出，这条任务已中断，请确认后重发（#id）」并移出台账；queued 条目保留，主动重启后端并继续队列；expected 退出不触发；认证失败退出交由 T3.4b 恢复流程，同时不遗留 running 台账。
- **测试：** 新增 tests/app-server-exit.test.js 四项回归；旧路径先失败，修复后全套 **215/215 pass / fail 0**。
- **部署：** 待提交后按 rv-prediction → 观察一轮 → default → strategy-observation 灰度。

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| T3.4c account switch recovery | 隔离 VM backend health helpers | verified switch clears auth_failing; failed switch remains auth_failing | 新增测试先失败后通过；全套 204/204（含 supervisor tests） | complete |
| T3.5 supervisor fallback alert | 假 bridge、假 curl、临时 .env/store/log；短轮询 | 3 次强杀告警一次、恢复通知、正数 allowlist、30 分钟持久限频、脱敏/token argv | 新增 3 项先失败后通过；全套 204/204；node、四项 zsh、diff check 通过；灰度门禁阻塞 | blocked by scope conflict |
| T3.4b auth terminal + T3.4a recovery | 生产认证函数的隔离 VM、真实临时 Store/ack/outbox、假账号切换；本地 Date | 耗尽终态、最多一次重跑、工具安全门、持续 auth_failing / turn 成功复位、私聊一次汇总、原因优先和本地时间 | 12 项新增先红后绿；200/200 pass / fail 0；node、四项 zsh、diff check 通过；旧断言未改 | complete |
| T3.4 recovery notices | 假 Telegram/假时钟，真实临时 Store/outbox/inbox/ack，生产 pollingLoop VM | ≥120s 私聊汇总、中文原因、同一 ack 注记、graceful/异常停机、重启去重 | 新功能测试先红；接入三项先失败再通过；新增 12 项，全套 188/188 pass / fail 0；node、四项 zsh、diff check 通过 | complete |
| T3.3 polling health | 实际 pollingLoop/状态函数在隔离 VM 中使用假时钟、假 Telegram；真实临时 Store | >180s/6次失败不退出；30/90s迁移去重；恢复时长；指数退避复位；重载持久化；status字段 | 旧退出路径测试先失败；新增 6 项通过；176/176 pass、fail 0，node、四项 zsh 与 diff check 通过 | complete |
| T3.2 supervisor | 假 bridge、短宽限期与轮询间隔；真实假 app-server 子进程 | 宽限期不杀、连续 miss 才重启、三级封顶、健康即复位；清理测试进程 | 四项新增测试逐项先失败再通过；170/170 pass、fail 0；node 与四项 zsh 语法、diff check 通过 | complete |
| T2.5 草稿检查 | ack 管理器、接入层生命周期集成测试 + 全套检查 | 通过后灰度部署 | 旧代码新增测试先失败；实现后 **145/145 pass / fail 0**；node、四项 zsh 语法与 diff check 通过 | complete |
| T2.3a replay 不阻塞 polling | 真实启动尾部 + 永不完成 dispatch | polling 处理新消息 | 修复前失败；修复后 117/117 全部通过 | complete |
| 语法检查（基线） | `node -c index.js` | 无输出即通过 | SYNTAX OK | complete |
| 单测（基线） | `node --test ./tests/*.test.js` | 全通过 | **tests 99 / pass 99 / fail 0**（362ms） | complete |
| 业务代码未被污染 | `git diff --shortstat` | `9 files changed, 510 insertions(+), 27 deletions(-)` | 完全一致 | complete |
| 供应脚本语法 | `zsh -n scripts/*.sh`（4 个） | 无输出 | 2026-09-21 分别复跑指定四个脚本，均退出 0 | complete |
| T1.1 提交完整性 | git status / show / stash | 干净、所需文件入库、stash 空 | be579fd，全部满足；脱敏已完成 | complete |
| T1.3 脏工作树守卫 | isolated installer tests | 被拒绝；允许绕过时写 ref | 104/104 pass，guard/ref tests complete | complete |
| T1.4 默认实例哈希一致 | shasum / DEPLOYED_REF / launchctl / pgrep / startup log | 相同且启动成功 | 相同；ref 记录 bca12d3；进程与日志正常 | complete |
| T1.5 三实例哈希一致 | shasum 四份 index.js / launchctl / pgrep / role heads / startup logs | 四份相同、进程在跑、角色保留 | 全部满足；sha256 前 12 = 889d4bd36bfc | complete |
| T1.5 角色文件未被覆盖 | head -5 named service AGENTS.md | 仍为各自专属角色 | 两个角色头部保持实例专属内容 | complete |
| T1.3 脏工作树守卫 | `BRIDGE_ALLOW_DIRTY=0` + 脏树执行安装 | 被拒绝 | 测试通过，断言 `/working tree is dirty/` | complete |
| T1.4/T1.5 三实例哈希一致 | `shasum -a256` ×3 | 三者相同且等于部署源 | 全部 `889d4bd3` | complete |
| T1.5 角色文件未被覆盖 | `head -5 <svc>/data/codex-home/AGENTS.md` | 仍为专属角色 | 保留 | complete |
| **§4.4 真实应答（人工）** | 三 bot 私聊 `/status` | codeVersion 一致、truthProfile 匹配 | 三者均 `889d4bd3`，truthProfile 全部匹配 | complete |
| 单测（Phase 1 收口） | `node --test ./tests/*.test.js` | 总数只增、fail 0 | **tests 104 / pass 104 / fail 0** | complete |
| T2.1 最终验证 | npm test；发送失败与结构化 429 模拟 | 全通过且不截短 retry_after | 108/108 pass，全部语法检查通过 | complete |
| T2.2 SIGTERM + T2.3 inbox | isolated child/process tests + rv-prediction smoke | store flush、子进程终止、重放护栏 | 116/116 pass；rv 首批 kill/restart 通过 | complete |
| T2.3a deployment | rv → default → strategy install; hash/log/process checks | no replay startup blockage | all 3 running, hash f3226f55, startup logs present | complete |
| T2.4 outbox | isolated store/process tests | failed sends survive restart and notices are durable | 123/123 pass; deployment pending | complete |
| T2.4a outbox guards | overflow/expiry/permanent/giveup/status/disk-save tests | bounded durable queue and visible counters | 129/129 pass; deployed and smoke-checked | complete |
| T2.4b permanent-reject hotfix | structured 429/403/blocked and transport-error regressions | 133/133 pass; all syntax checks pass | complete |
| T2.5 ack + lifecycle | manager + integration lifecycle/restart/steer tests and required checks | **145/145 pass / fail 0**; node/zsh/diff check pass | complete |
| T2.6 upstream transient retry | structured 5xx/stream classification, no-tool same-account retry, tool-aware partial-execution guard, group-safe ack | **151/151 pass / fail 0**; node/zsh/diff check pass | complete |
| T2.8a 跨目录实例锁热修 | 存活持有者跨 serviceRoot 拒绝、不删锁；无关 PID 与退出进程可接管；同目录重复启动拒绝 | 新增测试旧代码先失败；**163/163 pass / fail 0**，node、四项 zsh 与 diff check 通过 | complete |
| T3.1 缓存身份优先启动 | getMe 永不返回、后台身份变化持久化并影响群消息方向、无缓存等待 | 新增 3 项测试旧代码先失败；**166/166 pass / fail 0**，`node -c`、四项 zsh 语法与 `git diff --check` 通过；三实例 app-server 创建于 1854/2275/1414 ms | complete |

| T1.1 执行前复验 | node -c index.js；node --test ./tests/*.test.js | 99/99，fail 0 | 语法通过；tests 99 / pass 99 / fail 0，417ms | complete |
| T1.6 chat 绑定迁移 | node -c/index.js；node --test ./tests/*.test.js | 101/101，无真实 ID | 101/101 pass；grep 未在产品代码/跟踪测试配置中找到旧 ID | complete |

> 基线规则：改动后测试**总数只应增加**，`pass` 必须等于 `tests`，`fail` 必须为 0。

---

### T2.5 完成与灰度部署（2026-09-23）

- 完成收到即确认与单条 ack 状态编辑：受理、排队、处理中、完成/失败、steer、内部重试均复用同一 requestId 与 ack；编辑至少间隔 3 秒，失败不进入 outbox。
- 新增持久化 `telegram.activeRequests` 台账：queued 重启后安全重入队，running 重启不重跑并编辑中断提示；终态清理。outbox 延迟 ack 成功后回填 `ackMessageId`。
- 新增接入层生命周期测试覆盖正常终态、running/queued 重启、内部重试、steer 与延迟补发回填；旧代码新增测试先失败。
- 提交：`04a3c130714b40ce3cea584b6b212ca2544aa824`（`index.js` SHA-256 前 12 位 `e5d5ac5285ff`）。
- 灰度顺序 rv-prediction → 观察一轮 → default → strategy-observation：三实例哈希一致、进程存活、启动日志含 `Deployed ref` / `Bridge started` / `codeVersion`；rv-prediction 完成 SIGTERM/restart smoke，重启后 `activeRequests` 为空且恢复正常轮询。
- 人工验收待维护者执行：
  1. 三个 bot 各发一次 `/status`，确认 `codeVersion=e5d5ac52`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 不变。
  2. 一个群里 @ bot 发真实消息，确认只有一条状态消息从「已收到」变化到「已完成」，正文另发。

### T2.6 完成与灰度部署（2026-09-23）

- 新增 `upstream_transient` 分类：优先读取结构化 HTTP 状态 / `codexErrorInfo`，文本只匹配明确上下文，不使用裸数字；未加入 `ACCOUNT_FAILOVER_PATTERNS`。
- 仅对尚未产生工具调用的 turn 做同账号指数退避，最多两次重试；工具调用后不重跑，ack 显示「上游中断：本次任务可能已部分执行，请确认后重发」。重试耗尽显示「上游服务暂时不可用，请稍后重发」。
- 重试沿用同一 requestId 与同一 ack；群聊失败文案为中文短句，不带上游英文或 URL。
- 测试先在旧代码上失败（新增测试 5 项失败、1 项既有边界行为通过），修复后全套 **151/151 pass / fail 0**；`node -c`、四项 `zsh -n`、`git diff --check` 均通过。
- 实现提交：`859235637e374c41d3cb106a7908b5025a91ce8b`；随后补充工具 item 保守标记提交 `c7fc195b3e36b8d7a8f4376b50d92973515398dc`，最终 `index.js` SHA-256 前 12 位为 `fdae9bcf5cfa`。
- 灰度顺序 rv-prediction → 观察一轮 → default → strategy-observation 完成；最终三实例哈希、ref、进程、启动三标记与角色文件检查通过，未发现残留 curl。
- 人工验收待维护者执行：三个 bot 各发 `/status`，确认新 `codeVersion=fdae9bcf`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 不变。上游 5xx 无法人工制造，重试路径需等待真实上游故障验证。

## 版本与部署台账

> 每次部署追加一行。**这是回滚时唯一可信的对照表** —— prod 目录里没有 `.git`，
> 必须靠 tag + `index.js` sha256 双记录才能确认线上跑的是哪个版本（见 `task_plan.md` Decisions Made）。

| 日期 | 目标实例 | 分支 / tag | commit sha | index.js sha256 前 12 | 结果 |
|---|---|---|---|---|---|
| 09-02 15:30 | telegram-codex-bridge-service | 无（从工作树 rsync） | **无对应 commit** | `13fa361a50d0` | 现状基线，待 T1.4 覆盖 |
| 09-01 13:08 | strategy-observation / rv-prediction | 无（从工作树 rsync） | **无对应 commit** | `52188e37d0ea` | 现状基线，待 T1.5 覆盖 |
| 2026-09-21 | telegram-codex-bridge-service | main / bca12d3 | `bca12d308d23b6b40eebfd62d32de02231b3a9a8` | `889d4bd36bfc` | T1.4 灰度通过 |
| 2026-09-21 | rv-prediction | main / 65a6f34 | `65a6f347bd2975fe2fd8b7a926f60d2a6ad3671e` | `889d4bd36bfc` | T1.5 灰度通过 |
| 2026-09-21 | strategy-observation | main / 65a6f34 | `65a6f347bd2975fe2fd8b7a926f60d2a6ad3671e` | `889d4bd36bfc` | T1.5 灰度通过 |
| 2026-09-21 | Phase 1 tag | `v0.1.1` | `8c8e8b3` | `889d4bd36bfc` | Phase 1 closeout tag |
| — | （尚未部署） | HEAD `952675e` | `952675e` | `fff69755` | 含 T1.3 日志增补，随 Phase 2 首次部署上线 |
| 09-22 21:56 | rv-prediction | `feat/phase-2-no-silent-failure` | `746aab7` | `f3226f55` | ✅ 2026-09-22 `/status` 验收通过 |
| 09-22 21:56 | default / strategy-observation | `feat/phase-2-no-silent-failure` | `d265888` | `f3226f55` | ✅ 2026-09-22 `/status` 验收通过 |
| 09-23 | rv-prediction → default → strategy-observation | `feat/phase-2-no-silent-failure` | `c4d4ef4` | `ec5dd004` | ✅ 2026-09-23 `/status` 验收通过；**含 T2.4b 待修缺陷** |
| 09-23 | rv-prediction → default → strategy-observation | `feat/phase-2-no-silent-failure` | `364e0f3` | `3562402d` | ✅ 2026-09-23 `/status` 验收通过（T2.4b 热修） |
| 09-23 | rv-prediction → default → strategy-observation | `feat/phase-2-no-silent-failure` | `04a3c13` | `e5d5ac52` | ✅ 2026-09-23 三项人工验收通过（T2.5） |

| 2026-09-22 | Phase 2 first deployment | rv-prediction `746aab7`; default/strategy `d265888` | `f3226f5555d4` | `f3226f5555d4` | T2.3a smoke/deploy complete |
| 2026-09-22 | T2.4a rv-prediction | branch / c4d4ef4 | `c4d4ef42d00059e1874eb2c3805fd54797b6fabd` | `ec5dd00482c0` | deploy + SIGTERM/restart smoke passed |
| 2026-09-22 | T2.4a default | branch / c4d4ef4 | `c4d4ef42d00059e1874eb2c3805fd54797b6fabd` | `ec5dd00482c0` | deploy passed |
| 2026-09-22 | T2.4a strategy-observation | branch / c4d4ef4 | `c4d4ef42d00059e1874eb2c3805fd54797b6fabd` | `ec5dd00482c0` | deploy passed |
| 2026-09-23 | T2.4b rv-prediction | `feat/phase-2-no-silent-failure` | `364e0f3afdd889fd2102f3de346b0bc594c95288` | `3562402dbada` | gray deploy + observation passed |
| 2026-09-23 | T2.4b default | `feat/phase-2-no-silent-failure` | `364e0f3afdd889fd2102f3de346b0bc594c95288` | `3562402dbada` | deploy passed |
| 2026-09-23 | T2.4b strategy-observation | `feat/phase-2-no-silent-failure` | `364e0f3afdd889fd2102f3de346b0bc594c95288` | `3562402dbada` | deploy passed |
| 2026-09-23 | T2.5 rv-prediction | `feat/phase-2-no-silent-failure` | `04a3c130714b40ce3cea584b6b212ca2544aa824` | `e5d5ac5285ff` | gray deploy + SIGTERM/restart smoke passed |
| 2026-09-23 | T2.5 default | `feat/phase-2-no-silent-failure` | `04a3c130714b40ce3cea584b6b212ca2544aa824` | `e5d5ac5285ff` | observe-one-round then deploy passed |
| 2026-09-23 | T2.5 strategy-observation | `feat/phase-2-no-silent-failure` | `04a3c130714b40ce3cea584b6b212ca2544aa824` | `e5d5ac5285ff` | deploy passed |
| 2026-09-23 | T2.6 rv-prediction | `feat/phase-2-no-silent-failure` | `859235637e374c41d3cb106a7908b5025a91ce8b` | `97e54a1c6b2f` | gray deploy passed |
| 2026-09-23 | T2.6 default | `feat/phase-2-no-silent-failure` | `859235637e374c41d3cb106a7908b5025a91ce8b` | `97e54a1c6b2f` | observe-one-round then deploy passed |
| 2026-09-23 | T2.6 strategy-observation | `feat/phase-2-no-silent-failure` | `859235637e374c41d3cb106a7908b5025a91ce8b` | `97e54a1c6b2f` | deploy passed |
| 2026-09-23 | T2.6 correction rv-prediction | `feat/phase-2-no-silent-failure` | `c7fc195b3e36b8d7a8f4376b50d92973515398dc` | `fdae9bcf5cfa` | redeploy passed |
| 2026-09-23 | T2.6 correction default | `feat/phase-2-no-silent-failure` | `c7fc195b3e36b8d7a8f4376b50d92973515398dc` | `fdae9bcf5cfa` | redeploy passed |
| 2026-09-23 | T2.6 correction strategy-observation | `feat/phase-2-no-silent-failure` | `c7fc195b3e36b8d7a8f4376b50d92973515398dc` | `fdae9bcf5cfa` | redeploy passed |
| 2026-09-23 | T2.8a rv-prediction | `feat/phase-2-no-silent-failure` | `666dd972513b2d18860375c3c1e6ee0455c1a2d2` | `be7cce0b8ad6` | 灰度与观察一轮通过 |
| 2026-09-23 | T2.8a rv-prediction 重启 | `feat/phase-2-no-silent-failure` | `666dd972513b2d18860375c3c1e6ee0455c1a2d2` | `be7cce0b8ad6` | 成功重新取得原锁 |
| 2026-09-23 | T2.8a default | `feat/phase-2-no-silent-failure` | `666dd972513b2d18860375c3c1e6ee0455c1a2d2` | `be7cce0b8ad6` | 灰度通过 |
| 2026-09-23 | T2.8a strategy-observation | `feat/phase-2-no-silent-failure` | `666dd972513b2d18860375c3c1e6ee0455c1a2d2` | `be7cce0b8ad6` | 灰度通过 |
| 2026-09-23 | Phase 2 tag | `v0.2.0` | `021139200a113d5cf1870246ed6a0c9a70abbd59` | `be7cce0b8ad6` | 注解 tag 指向 main 的 `--no-ff` 合并提交；tag 源码哈希与线上一致 |
| 2026-09-23 | rv-prediction | `main` / `v0.2.0` | `021139200a113d5cf1870246ed6a0c9a70abbd59` | `be7cce0b8ad6` | main 重装、观察一轮通过 |
| 2026-09-23 | default | `main` / `v0.2.0` | `021139200a113d5cf1870246ed6a0c9a70abbd59` | `be7cce0b8ad6` | main 重装通过 |
| 2026-09-23 | strategy-observation | `main` / `v0.2.0` | `021139200a113d5cf1870246ed6a0c9a70abbd59` | `be7cce0b8ad6` | main 重装通过 |
| 2026-09-23 | T3.1 rv-prediction | `feat/phase-3-restart-loop` | `bfb8c79f4785fe848dfca32b41ad50faffb7c73f` | `1eacb1e58346` | 灰度与轮询观察通过；spawn 1854 ms |
| 2026-09-23 | T3.1 default | `feat/phase-3-restart-loop` | `bfb8c79f4785fe848dfca32b41ad50faffb7c73f` | `1eacb1e58346` | 灰度与轮询观察通过；spawn 2275 ms |
| 2026-09-23 | T3.1 strategy-observation | `feat/phase-3-restart-loop` | `bfb8c79f4785fe848dfca32b41ad50faffb7c73f` | `1eacb1e58346` | 灰度与轮询观察通过；spawn 1414 ms |
| 2026-09-23 | T3.2 rv-prediction | `feat/phase-3-restart-loop` | `6f7c70135bea2efaff833625f5fb5fbd33e41fc6` | `1eacb1e58346` | 灰度与观察通过；supervisor `2257af0ad696`，ready 17:20:41 +0800，start_grace=60 |
| 2026-09-23 | T3.2 default | `feat/phase-3-restart-loop` | `6f7c70135bea2efaff833625f5fb5fbd33e41fc6` | `1eacb1e58346` | 灰度通过；supervisor `2257af0ad696`，ready 17:21:42 +0800，start_grace=60 |
| 2026-09-23 | T3.2 strategy-observation | `feat/phase-3-restart-loop` | `6f7c70135bea2efaff833625f5fb5fbd33e41fc6` | `1eacb1e58346` | 灰度通过；supervisor `2257af0ad696`，ready 17:22:18 +0800，start_grace=60 |
| 2026-09-23 | T3.3 rv-prediction | `feat/phase-3-restart-loop` | `32d12021739efd67539697a8b0a8bdadd53e1030` | `5334599a2dad` | 灰度与观察通过；supervisor `2257af0ad696`，ready 17:37:54 +0800，spawn 1175 ms |
| 2026-09-23 | T3.3 default | `feat/phase-3-restart-loop` | `32d12021739efd67539697a8b0a8bdadd53e1030` | `5334599a2dad` | 灰度通过；supervisor `2257af0ad696`，ready 17:38:28 +0800，spawn 1955 ms |
| 2026-09-23 | T3.3 strategy-observation | `feat/phase-3-restart-loop` | `32d12021739efd67539697a8b0a8bdadd53e1030` | `5334599a2dad` | 灰度通过；supervisor `2257af0ad696`，ready 17:39:10 +0800，spawn 1011 ms |
| 2026-09-23 | T3.4 rv-prediction | `feat/phase-3-restart-loop` | `8043a591792a8127c85509893b886536f688cac5` | `8fea81fe48e7` | 灰度通过；ready 18:26:46 +0800、spawn 1000 ms；无恢复汇总；supervisor `2257af0ad696` |
| 2026-09-23 | T3.4 default | `feat/phase-3-restart-loop` | `8043a591792a8127c85509893b886536f688cac5` | `8fea81fe48e7` | 灰度通过；ready 18:27:48 +0800、spawn 1704 ms；无恢复汇总；supervisor `2257af0ad696` |
| 2026-09-23 | T3.4 strategy-observation | `feat/phase-3-restart-loop` | `8043a591792a8127c85509893b886536f688cac5` | `8fea81fe48e7` | 灰度通过；ready 18:28:14 +0800、spawn 1078 ms；无恢复汇总；supervisor `2257af0ad696` |
| 2026-09-23 | T3.4b/T3.4a rv-prediction | `feat/phase-3-restart-loop` | `adbcca86c372b3b1d386acaaf1b97d2e6788be57` | `4e0985bd0bb3` | 安装与常规检查通过；ready 22:57:06 +0800，spawn 5504 ms；台账清空；auth_failing 待证实 |
| 2026-09-23 | T3.4b/T3.4a default | `feat/phase-3-restart-loop` | `adbcca86c372b3b1d386acaaf1b97d2e6788be57` | `4e0985bd0bb3` | 安装与常规检查通过；ready 23:02:23 +0800，spawn 7707 ms；backend=ok |
| 2026-09-23 | T3.4b/T3.4a strategy-observation | `feat/phase-3-restart-loop` | `adbcca86c372b3b1d386acaaf1b97d2e6788be57` | `4e0985bd0bb3` | 安装与常规检查通过；ready 23:03:04 +0800，spawn 2811 ms；backend=auth_failing |

**回滚锚点：`v0.1.1`** → commit `8c8e8b3`，index.js `889d4bd3` —— 经 2026-09-22 线上 `/status` 验收。

> ⚠️ tag 核对方法：注解 tag 必须用 `git rev-list -n1 <tag>` 取所指 commit。
> `git tag -l --format='%(objectname:short)'` 给的是 **tag 对象自身**的 sha（v0.1.1 = `72571de`），不是 commit。
> 2026-09-22 曾因此误判 v0.1.1 为无效锚点并多打了一个 `v0.1.2`（指向 `65a6f34`，代码与 `8c8e8b3` 零差异），
> 该冗余 tag 已删除（本地创建、从未 push）。`v0.1.0` → `3f27ff2` 为早期发布，index.js `b8d50a50`。

灰度顺序不得跳步：**rv-prediction → 默认实例 → strategy-observation**。
每批之间须确认：进程存活、`bridge.stdout.log` 出现 `Telegram Codex Bridge started.`、该实例能正常应答一次。

---

# Progress Log

计划 `task_plan.md`，证据 `findings.md`，执行约束 `handoff_codex.md`。
阶段状态只用 `pending` / `in_progress` / `complete`，与 `task_plan.md` 保持一致。
**遇阻立即停止，写入下方 Error Log，不要自行扩大范围。**

## Session: 2026-09-21

### 调查与规划（本会话已完成，不属于 Phase 1–4）

- **Status:** complete
- **执行者：** Claude Code（longxia 机器，经 SSH `remote-mac-wukong` 读取 wukong）
- Actions taken:
  - 核对本机 Codex 提交的故障统计：8 项数字复算一致，3 项报偏，5 类完全漏掉（`findings.md` F2–F4）
  - 统计 W-SVC 的 25,958 行 stderr 与 38 个 rollout，得出 turn 级失败分类与 24 个孤儿 turn（F5）
  - 定位 9 条根因 R1–R9，全部落到具体行号（F6）
  - 查清代码版本考古：四份副本、三个版本，双向 diff 确认工作区为严格超集（F8）
  - 确认最高优先风险：整个多实例功能未提交且无 stash（F10）
  - 采集改动前基线：`tests 99 / pass 99 / fail 0`（F13）
  - 用 `init-session.sh "Bridge Reliability"` 建立本计划目录
- Files created/modified:
  - `.planning/2026-09-21-bridge-reliability/task_plan.md`
  - `.planning/2026-09-21-bridge-reliability/findings.md`
  - `.planning/2026-09-21-bridge-reliability/progress.md`
  - `.planning/2026-09-21-bridge-reliability/handoff_codex.md`
  - `.planning/.active_plan`（由 init 脚本写入）
  - 删除首版 `docs/bridge-reliability/`（迁移到本目录，避免两份真相）
- **未改动任何业务代码**：`git diff --shortstat` 保持 `9 files changed, 510 insertions(+), 27 deletions(-)`

### Phase 1: 基线与版本对齐

- **Status:** complete
- **Started:** 2026-09-21
- Actions taken:
  - T1.1：已完成四份计划阅读；当前分支 main，原业务改动仍为 9 files / +510 / -27；未修改业务代码。
  - 指定检查复跑：node 语法、99/99 单测、四个 zsh 语法检查均通过。
  - 提交前快照如下（在 git add 前记录）。
- Files created/modified:
  - 本 progress.md、task_plan.md、findings.md（按本轮用户明确要求，只追加执行发现，保留原调查）。
- [ ] T1.1：提交前检查遇阻，尚未 commit；T1.2–T4.7 未开始。
- 阻塞详情：
  - 现象：git add -A 后，对暂存新增内容做不输出具体值的扫描，发现 3 行匹配 Telegram 群 ID 格式；两份 config/instances/*.env.example 第 3 行含实际 allowlist 格式的多个标识，tests/multi-instance-launch-agent.test.js 第 43 行亦含该格式的测试值。测试值是否虚构未核实，不据此断言泄密。
  - 已尝试：四份计划、git 状态/差异/stash/log、99 项单测及四脚本语法检查；提交前模式扫描未发现 Telegram token、sk- 格式 key 或私钥头（不代表完整凭据审计）。
  - 卡在哪：handoff §3.3 禁止提交聊天 ID，§3.2 禁止修改任何 .env.*（T1.3 的根 .env.example 另有特定例外），§3.3 禁止改已有测试断言。需要明确允许仅把两份实例 env.example 的 allowlist 改为占位符，并确认测试第 43 行可换为显式虚构值。
  - 影响面：未改业务代码、未提交、未部署、未重启；线上健康未另作验证。git add -A 已暂存原改动，仍含上述待处理值；不得直接提交。没有使用 reset/restore/stash 等禁用操作。
  - 建议：批准上述最小脱敏后继续 T1.1；或由维护者完成模板脱敏并确认测试值。未自行执行任一选项。

`git status --porcelain`
```text
 M .env.example
 M .gitignore
 M README.md
 M index.js
 M package.json
 M scripts/install-launch-agent.sh
 M scripts/uninstall-launch-agent.sh
 M tests/telegram-transport-recovery.test.js
 M tests/truth-profile.test.js
?? .planning/
?? AGENTS.md
?? config/instances/
?? docs/MULTI-INSTANCE.md
?? docs/bridge-reliability.md
?? tests/multi-instance-launch-agent.test.js
```

`git stash list`
```text

```

`git log --oneline -3`
```text
884811e Harden bridge transport recovery and log rotation
9bb7564 Harden bridge routing and turn privacy
cb6c0b2 Auto-run Deribit strategy approval gates
```


### Phase 2: 消除「完全无反馈」

- **Status:** complete
- T2.1–T2.8a 清单逐项核对均已打勾，T2.3a / T2.4a / T2.4b / T2.8a 行均保留；T2.8a 三实例 `/status` 已由维护者人工确认，Phase 2 进入合并与 tag 收口。
- Phase 2 已以 `git merge --no-ff` 并入 main；注解 tag `v0.2.0` 指向合并提交 `021139200a113d5cf1870246ed6a0c9a70abbd59`。三实例随后依序从 main 重装，`DEPLOYED_REF` 均指向该提交与 tag。
- T2.8a（2026-09-23）：跨目录同 token 抢锁缺陷已修复并灰度部署；三实例真实 `/status` 待维护者确认，Phase 2 收口尚未执行。
- T2.5（2026-09-23）：未完成，遇到 inbox 生命周期与重启复用 ack 的契约前提冲突，停止业务修改与部署；详见 Error Log 和末尾记录。
- Actions taken:
  - T2.4b completed and gray-deployed in the mandated order: rv-prediction → default → strategy-observation.
  - All three services are running the same `index.js` SHA-256 `3562402dbada`; each `DEPLOYED_REF` points to `364e0f3` and startup logs contain `Deployed ref`, `Telegram Codex Bridge started`, and `codeVersion=3562402d`.
  - rv-prediction observation round passed; named role files remained instance-specific and the redacted curl check showed one active long-poll child per bot with no stale duplicate.
- Files created/modified:
  - `index.js`, `tests/outbox.test.js`, this `progress.md`, and `task_plan.md`.

### Phase 3: 修重启死循环与失联可见

- **Status:** in_progress
- Actions taken:
  - T3.4b / T3.4a 已灰度部署（2026-09-23）：代码 `adbcca8`、四份 index.js `4e0985bd0bb3`，200/200 通过；rv #023b89 已自然清台账。strategy 为 auth_failing；rv 启动后无新认证错误、仍为 ok，该额外验收未证实，不能当成账号恢复。详见末尾台账与人工验收；Next Step 为 T3.5。
  - T3.4b / T3.4a（2026-09-23）：维护者三份规划更新原样提交 `4eef88f`。认证 turn / stderr 看门狗 / 重跑请求失败统一终态、一次重跑上限、工具调用安全门、auth_failing 与私聊汇总去重已实现；重叠失联原因和本地秒级时间已修。新增 12 项测试，全套 200/200；准备灰度部署。
  - T3.4 灰度完成（2026-09-23）：提交 `8043a59` 按 rv → 观察 → default → strategy 安装；四份 index.js `8fea81fe48e7`，supervisor `2257af0ad696`；启动 1000/1704/1078 ms。三实例均已成功轮询且没有生成失联汇总；T3.4 已勾选，Next Step 为 T3.5。人工验收见末尾。
  - T3.4（2026-09-23）：维护者三份规划文件原样单独提交 `4279e79`。新增恢复汇总、延迟消息 ack 注记、正常关闭记录；网络恢复复用 T3.3 lastOutage，进程恢复使用启动前 lastPollSuccessAt。新增 12 项测试（先复现缺失与接入失败），全套 188/188；准备灰度部署。
  - T3.3 灰度完成（2026-09-23）：代码提交 `32d1202` 按 rv → 观察 → default → strategy 安装；四份 index.js `5334599a2dad`，supervisor 保持 `2257af0ad696`；appServerSpawnedMs 为 1175/1955/1011。检查与人工验收见末尾 T3.3 记录；Next Step 指向 T3.4。
  - T3.3（2026-09-23）：规划更新原样提交 `d36b4d8`。移除 pollingLoop 的卡死时长重启分支；`requestSupervisorRestart` 全仓只有该调用，移除后无其他调用方，故删除函数、私有标志与两项旧阈值。新增 30/90 秒状态迁移、失联起点/恢复时长持久化、2/4/8/16/30 秒退避与 `/status` 三字段；176/176 通过，准备灰度部署。Clash 调用条件、supervisor、现有 restartReason 清理逻辑未改。
  - T3.2 完成（2026-09-23）：代码提交 `6f7c701`；按 rv-prediction → 观察一轮 → default → strategy-observation 灰度部署。三实例新 Supervisor ready 分别为本次 17:20:41 / 17:21:42 / 17:22:18（UTC+8），均带 start_grace=60；脚本哈希 `2257af0ad696`，index.js 仍为 `1eacb1e58346`。详细证据与人工验收见末尾 T3.2 完成记录。
  - T3.2 续做（2026-09-23）：按已裁决的数值执行固定三级 60/120/300，原“翻倍”为规划方笔误；阻塞已解除。新增假 bridge / 假 app-server 的四项进程测试逐项先红后绿，170/170 通过；实现与检查完成，准备按 rv → default → strategy 灰度部署。新参数 START_GRACE_SECONDS 已在 `.env.example` 说明，supervisor 从进程环境读取，不读取 dotenv；测试用短基数按 1/2/5 比例缩短三级时间。
  - T3.2（2026-09-23）：维护者三份规划文件已在 `feat/phase-3-restart-loop` 原样单独提交为 `4838e81`。读取 supervisor 后停在实现前：规格同时要求每轮翻倍和 `60 → 120 → 300`，需要明确是否包含 240 秒这一轮，详见 Error Log。未改脚本、未运行新测试、未部署；T3.2 保持未勾选。
  - T3.1：main 上原样提交维护者的三份规划文件（`ddec91b`），建立 `feat/phase-3-restart-loop`；新增测试先在旧代码上失败，再实现缓存身份优先、后台 getMe 校验、身份变化持久化与实时方向判断。
  - 不移动 `startCodexServer()`；在实际 app-server 子进程创建后打印 `appServerSpawnedMs`。代码提交 `bfb8c79f4785fe848dfca32b41ad50faffb7c73f`，`index.js` SHA-256 前 12 位 `1eacb1e58346`。
  - 按 rv-prediction → 观察一轮 → default → strategy-observation 灰度安装。三实例启动计时分别为 **1854 / 2275 / 1414 ms**，均远小于 15000 ms；部署后三者轮询成功、错误计数 0。四份 `index.js` 哈希一致，三个 bridge 进程与各自锁 PID 对应，命名角色文件哈希与源文件一致；仅有三条由各自 bridge 持有的正常 getUpdates curl，没有残留孤儿进程。
- Files created/modified:
  - `index.js`、新增 `tests/startup-bot-identity.test.js`、本 `progress.md`、`task_plan.md`；`findings.md` 未改。

#### T3.1 启动前 await 审计（至 app-server 子进程创建）

| 等待点 | 可能访问网络 | 处理与边界 |
|--------|--------------|------------|
| `await discoverChatIds(telegram)` | 是，Telegram getMe/getUpdates | 仅显式 `--discover-chat-id` 诊断模式执行，随即退出；正常 LaunchAgent 启动路径不会进入。 |
| `await resolveStartupBotIdentity(...)` | 有缓存时 getMe 在后台访问 Telegram；无缓存时等待 Telegram getMe | 有完整缓存立即返回并并行校验，getMe 永不返回也不挡 app-server；首次安装无缓存仍等待，由 T3.2 启动宽限期兜底。 |
| `await startCodexServer()` 内 `await server.start()` | 否 | 仅本地 spawn；`appServerSpawnedMs` 在子进程创建后立即记录。 |
| `await startCodexServer()` 内 `await server.initialize()` | 可能等待 app-server 的 IPC 响应；此时子进程已创建 | 位于 spawn 之后，不影响 supervisor 的 15 秒子进程检测；未改 Codex 初始化协议。 |

此外，启动前的 `outbox.flush()` 可能访问 Telegram，但以 `void` 后台运行、未被 await；桌面上下文同步、账号资料读取和初始 profile 写入均为本地同步操作。`ensureHealthyStartupAccount()` 在 `startCodexServer()` 返回后后台执行，可能访问 chatgpt.com/codex-lb，不在创建子进程前的等待链上。函数定义内部的其余 `await` 仅在后续消息/恢复事件触发时执行。

维护者人工验收待执行：三个 bot 各发一次 `/status`，应看到 `codeVersion=1eacb1e5`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 与部署前一致。未调用生产 token 的 getUpdates 或模拟用户消息验证真实应答。

### Phase 4: 错误分类与可观测指标

- **Status:** pending
- Actions taken:
  -
- Files created/modified:
  -

---

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| T3.4b auth terminal + T3.4a recovery | 生产认证函数的隔离 VM、真实临时 Store/ack/outbox、假账号切换；本地 Date | 耗尽终态、最多一次重跑、工具安全门、持续 auth_failing / turn 成功复位、私聊一次汇总、原因优先和本地时间 | 12 项新增先红后绿；200/200 pass / fail 0；node、四项 zsh、diff check 通过；旧断言未改 | complete |
| T3.4 recovery notices | 假 Telegram/假时钟，真实临时 Store/outbox/inbox/ack，生产 pollingLoop VM | ≥120s 私聊汇总、中文原因、同一 ack 注记、graceful/异常停机、重启去重 | 新功能测试先红；接入三项先失败再通过；新增 12 项，全套 188/188 pass / fail 0；node、四项 zsh、diff check 通过 | complete |
| T3.3 polling health | 实际 pollingLoop/状态函数在隔离 VM 中使用假时钟、假 Telegram；真实临时 Store | >180s/6次失败不退出；30/90s迁移去重；恢复时长；指数退避复位；重载持久化；status字段 | 旧退出路径测试先失败；新增 6 项通过；176/176 pass、fail 0，node、四项 zsh 与 diff check 通过 | complete |
| T3.2 supervisor | 假 bridge、短宽限期与轮询间隔；真实假 app-server 子进程 | 宽限期不杀、连续 miss 才重启、三级封顶、健康即复位；清理测试进程 | 四项新增测试逐项先失败再通过；170/170 pass、fail 0；node 与四项 zsh 语法、diff check 通过 | complete |
| T2.5 草稿检查 | ack 管理器、接入层生命周期集成测试 + 全套检查 | 通过后灰度部署 | 旧代码新增测试先失败；实现后 **145/145 pass / fail 0**；node、四项 zsh 语法与 diff check 通过 | complete |
| T2.3a replay 不阻塞 polling | 真实启动尾部 + 永不完成 dispatch | polling 处理新消息 | 修复前失败；修复后 117/117 全部通过 | complete |
| 语法检查（基线） | `node -c index.js` | 无输出即通过 | SYNTAX OK | complete |
| 单测（基线） | `node --test ./tests/*.test.js` | 全通过 | **tests 99 / pass 99 / fail 0**（362ms） | complete |
| 业务代码未被污染 | `git diff --shortstat` | `9 files changed, 510 insertions(+), 27 deletions(-)` | 完全一致 | complete |
| 供应脚本语法 | `zsh -n scripts/*.sh`（4 个） | 无输出 | 2026-09-21 分别复跑指定四个脚本，均退出 0 | complete |
| T1.1 提交完整性 | git status / show / stash | 干净、所需文件入库、stash 空 | be579fd，全部满足；脱敏已完成 | complete |
| T1.3 脏工作树守卫 | isolated installer tests | 被拒绝；允许绕过时写 ref | 104/104 pass，guard/ref tests complete | complete |
| T1.4 默认实例哈希一致 | shasum / DEPLOYED_REF / launchctl / pgrep / startup log | 相同且启动成功 | 相同；ref 记录 bca12d3；进程与日志正常 | complete |
| T1.5 三实例哈希一致 | shasum 四份 index.js / launchctl / pgrep / role heads / startup logs | 四份相同、进程在跑、角色保留 | 全部满足；sha256 前 12 = 889d4bd36bfc | complete |
| T1.5 角色文件未被覆盖 | head -5 named service AGENTS.md | 仍为各自专属角色 | 两个角色头部保持实例专属内容 | complete |
| T1.3 脏工作树守卫 | `BRIDGE_ALLOW_DIRTY=0` + 脏树执行安装 | 被拒绝 | 测试通过，断言 `/working tree is dirty/` | complete |
| T1.4/T1.5 三实例哈希一致 | `shasum -a256` ×3 | 三者相同且等于部署源 | 全部 `889d4bd3` | complete |
| T1.5 角色文件未被覆盖 | `head -5 <svc>/data/codex-home/AGENTS.md` | 仍为专属角色 | 保留 | complete |
| **§4.4 真实应答（人工）** | 三 bot 私聊 `/status` | codeVersion 一致、truthProfile 匹配 | 三者均 `889d4bd3`，truthProfile 全部匹配 | complete |
| 单测（Phase 1 收口） | `node --test ./tests/*.test.js` | 总数只增、fail 0 | **tests 104 / pass 104 / fail 0** | complete |
| T2.1 最终验证 | npm test；发送失败与结构化 429 模拟 | 全通过且不截短 retry_after | 108/108 pass，全部语法检查通过 | complete |
| T2.2 SIGTERM + T2.3 inbox | isolated child/process tests + rv-prediction smoke | store flush、子进程终止、重放护栏 | 116/116 pass；rv 首批 kill/restart 通过 | complete |
| T2.3a deployment | rv → default → strategy install; hash/log/process checks | no replay startup blockage | all 3 running, hash f3226f55, startup logs present | complete |
| T2.4 outbox | isolated store/process tests | failed sends survive restart and notices are durable | 123/123 pass; deployment pending | complete |
| T2.4a outbox guards | overflow/expiry/permanent/giveup/status/disk-save tests | bounded durable queue and visible counters | 129/129 pass; deployed and smoke-checked | complete |
| T2.4b permanent-reject hotfix | structured 429/403/blocked and transport-error regressions | 133/133 pass; all syntax checks pass | complete |
| T2.5 ack + lifecycle | manager + integration lifecycle/restart/steer tests and required checks | **145/145 pass / fail 0**; node/zsh/diff check pass | complete |
| T2.6 upstream transient retry | structured 5xx/stream classification, no-tool same-account retry, tool-aware partial-execution guard, group-safe ack | **151/151 pass / fail 0**; node/zsh/diff check pass | complete |
| T2.8a 跨目录实例锁热修 | 存活持有者跨 serviceRoot 拒绝、不删锁；无关 PID 与退出进程可接管；同目录重复启动拒绝 | 新增测试旧代码先失败；**163/163 pass / fail 0**，node、四项 zsh 与 diff check 通过 | complete |
| T3.1 缓存身份优先启动 | getMe 永不返回、后台身份变化持久化并影响群消息方向、无缓存等待 | 新增 3 项测试旧代码先失败；**166/166 pass / fail 0**，`node -c`、四项 zsh 语法与 `git diff --check` 通过；三实例 app-server 创建于 1854/2275/1414 ms | complete |

| T1.1 执行前复验 | node -c index.js；node --test ./tests/*.test.js | 99/99，fail 0 | 语法通过；tests 99 / pass 99 / fail 0，417ms | complete |
| T1.6 chat 绑定迁移 | node -c/index.js；node --test ./tests/*.test.js | 101/101，无真实 ID | 101/101 pass；grep 未在产品代码/跟踪测试配置中找到旧 ID | complete |

> 基线规则：改动后测试**总数只应增加**，`pass` 必须等于 `tests`，`fail` 必须为 0。

---

### T2.5 完成与灰度部署（2026-09-23）

- 完成收到即确认与单条 ack 状态编辑：受理、排队、处理中、完成/失败、steer、内部重试均复用同一 requestId 与 ack；编辑至少间隔 3 秒，失败不进入 outbox。
- 新增持久化 `telegram.activeRequests` 台账：queued 重启后安全重入队，running 重启不重跑并编辑中断提示；终态清理。outbox 延迟 ack 成功后回填 `ackMessageId`。
- 新增接入层生命周期测试覆盖正常终态、running/queued 重启、内部重试、steer 与延迟补发回填；旧代码新增测试先失败。
- 提交：`04a3c130714b40ce3cea584b6b212ca2544aa824`（`index.js` SHA-256 前 12 位 `e5d5ac5285ff`）。
- 灰度顺序 rv-prediction → 观察一轮 → default → strategy-observation：三实例哈希一致、进程存活、启动日志含 `Deployed ref` / `Bridge started` / `codeVersion`；rv-prediction 完成 SIGTERM/restart smoke，重启后 `activeRequests` 为空且恢复正常轮询。
- 人工验收待维护者执行：
  1. 三个 bot 各发一次 `/status`，确认 `codeVersion=e5d5ac52`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 不变。
  2. 一个群里 @ bot 发真实消息，确认只有一条状态消息从「已收到」变化到「已完成」，正文另发。

### T2.6 完成与灰度部署（2026-09-23）

- 新增 `upstream_transient` 分类：优先读取结构化 HTTP 状态 / `codexErrorInfo`，文本只匹配明确上下文，不使用裸数字；未加入 `ACCOUNT_FAILOVER_PATTERNS`。
- 仅对尚未产生工具调用的 turn 做同账号指数退避，最多两次重试；工具调用后不重跑，ack 显示「上游中断：本次任务可能已部分执行，请确认后重发」。重试耗尽显示「上游服务暂时不可用，请稍后重发」。
- 重试沿用同一 requestId 与同一 ack；群聊失败文案为中文短句，不带上游英文或 URL。
- 测试先在旧代码上失败（新增测试 5 项失败、1 项既有边界行为通过），修复后全套 **151/151 pass / fail 0**；`node -c`、四项 `zsh -n`、`git diff --check` 均通过。
- 实现提交：`859235637e374c41d3cb106a7908b5025a91ce8b`；随后补充工具 item 保守标记提交 `c7fc195b3e36b8d7a8f4376b50d92973515398dc`，最终 `index.js` SHA-256 前 12 位为 `fdae9bcf5cfa`。
- 灰度顺序 rv-prediction → 观察一轮 → default → strategy-observation 完成；最终三实例哈希、ref、进程、启动三标记与角色文件检查通过，未发现残留 curl。
- 人工验收待维护者执行：三个 bot 各发 `/status`，确认新 `codeVersion=fdae9bcf`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 不变。上游 5xx 无法人工制造，重试路径需等待真实上游故障验证。

## 版本与部署台账

> 每次部署追加一行。**这是回滚时唯一可信的对照表** —— prod 目录里没有 `.git`，
> 必须靠 tag + `index.js` sha256 双记录才能确认线上跑的是哪个版本（见 `task_plan.md` Decisions Made）。

| 日期 | 目标实例 | 分支 / tag | commit sha | index.js sha256 前 12 | 结果 |
|---|---|---|---|---|---|
| 09-02 15:30 | telegram-codex-bridge-service | 无（从工作树 rsync） | **无对应 commit** | `13fa361a50d0` | 现状基线，待 T1.4 覆盖 |
| 09-01 13:08 | strategy-observation / rv-prediction | 无（从工作树 rsync） | **无对应 commit** | `52188e37d0ea` | 现状基线，待 T1.5 覆盖 |
| 2026-09-21 | telegram-codex-bridge-service | main / bca12d3 | `bca12d308d23b6b40eebfd62d32de02231b3a9a8` | `889d4bd36bfc` | T1.4 灰度通过 |
| 2026-09-21 | rv-prediction | main / 65a6f34 | `65a6f347bd2975fe2fd8b7a926f60d2a6ad3671e` | `889d4bd36bfc` | T1.5 灰度通过 |
| 2026-09-21 | strategy-observation | main / 65a6f34 | `65a6f347bd2975fe2fd8b7a926f60d2a6ad3671e` | `889d4bd36bfc` | T1.5 灰度通过 |
| 2026-09-21 | Phase 1 tag | `v0.1.1` | `8c8e8b3` | `889d4bd36bfc` | Phase 1 closeout tag |
| — | （尚未部署） | HEAD `952675e` | `952675e` | `fff69755` | 含 T1.3 日志增补，随 Phase 2 首次部署上线 |
| 09-22 21:56 | rv-prediction | `feat/phase-2-no-silent-failure` | `746aab7` | `f3226f55` | ✅ 2026-09-22 `/status` 验收通过 |
| 09-22 21:56 | default / strategy-observation | `feat/phase-2-no-silent-failure` | `d265888` | `f3226f55` | ✅ 2026-09-22 `/status` 验收通过 |
| 09-23 | rv-prediction → default → strategy-observation | `feat/phase-2-no-silent-failure` | `c4d4ef4` | `ec5dd004` | ✅ 2026-09-23 `/status` 验收通过；**含 T2.4b 待修缺陷** |
| 09-23 | rv-prediction → default → strategy-observation | `feat/phase-2-no-silent-failure` | `364e0f3` | `3562402d` | ✅ 2026-09-23 `/status` 验收通过（T2.4b 热修） |
| 09-23 | rv-prediction → default → strategy-observation | `feat/phase-2-no-silent-failure` | `04a3c13` | `e5d5ac52` | ✅ 2026-09-23 三项人工验收通过（T2.5） |

| 2026-09-22 | Phase 2 first deployment | rv-prediction `746aab7`; default/strategy `d265888` | `f3226f5555d4` | `f3226f5555d4` | T2.3a smoke/deploy complete |
| 2026-09-22 | T2.4a rv-prediction | branch / c4d4ef4 | `c4d4ef42d00059e1874eb2c3805fd54797b6fabd` | `ec5dd00482c0` | deploy + SIGTERM/restart smoke passed |
| 2026-09-22 | T2.4a default | branch / c4d4ef4 | `c4d4ef42d00059e1874eb2c3805fd54797b6fabd` | `ec5dd00482c0` | deploy passed |
| 2026-09-22 | T2.4a strategy-observation | branch / c4d4ef4 | `c4d4ef42d00059e1874eb2c3805fd54797b6fabd` | `ec5dd00482c0` | deploy passed |
| 2026-09-23 | T2.4b rv-prediction | `feat/phase-2-no-silent-failure` | `364e0f3afdd889fd2102f3de346b0bc594c95288` | `3562402dbada` | gray deploy + observation passed |
| 2026-09-23 | T2.4b default | `feat/phase-2-no-silent-failure` | `364e0f3afdd889fd2102f3de346b0bc594c95288` | `3562402dbada` | deploy passed |
| 2026-09-23 | T2.4b strategy-observation | `feat/phase-2-no-silent-failure` | `364e0f3afdd889fd2102f3de346b0bc594c95288` | `3562402dbada` | deploy passed |
| 2026-09-23 | T2.5 rv-prediction | `feat/phase-2-no-silent-failure` | `04a3c130714b40ce3cea584b6b212ca2544aa824` | `e5d5ac5285ff` | gray deploy + SIGTERM/restart smoke passed |
| 2026-09-23 | T2.5 default | `feat/phase-2-no-silent-failure` | `04a3c130714b40ce3cea584b6b212ca2544aa824` | `e5d5ac5285ff` | observe-one-round then deploy passed |
| 2026-09-23 | T2.5 strategy-observation | `feat/phase-2-no-silent-failure` | `04a3c130714b40ce3cea584b6b212ca2544aa824` | `e5d5ac5285ff` | deploy passed |
| 2026-09-23 | T2.6 rv-prediction | `feat/phase-2-no-silent-failure` | `859235637e374c41d3cb106a7908b5025a91ce8b` | `97e54a1c6b2f` | gray deploy passed |
| 2026-09-23 | T2.6 default | `feat/phase-2-no-silent-failure` | `859235637e374c41d3cb106a7908b5025a91ce8b` | `97e54a1c6b2f` | observe-one-round then deploy passed |
| 2026-09-23 | T2.6 strategy-observation | `feat/phase-2-no-silent-failure` | `859235637e374c41d3cb106a7908b5025a91ce8b` | `97e54a1c6b2f` | deploy passed |
| 2026-09-23 | T2.6 correction rv-prediction | `feat/phase-2-no-silent-failure` | `c7fc195b3e36b8d7a8f4376b50d92973515398dc` | `fdae9bcf5cfa` | redeploy passed |
| 2026-09-23 | T2.6 correction default | `feat/phase-2-no-silent-failure` | `c7fc195b3e36b8d7a8f4376b50d92973515398dc` | `fdae9bcf5cfa` | redeploy passed |
| 2026-09-23 | T2.6 correction strategy-observation | `feat/phase-2-no-silent-failure` | `c7fc195b3e36b8d7a8f4376b50d92973515398dc` | `fdae9bcf5cfa` | redeploy passed |
| 2026-09-23 | T2.8a rv-prediction | `feat/phase-2-no-silent-failure` | `666dd972513b2d18860375c3c1e6ee0455c1a2d2` | `be7cce0b8ad6` | 灰度与观察一轮通过 |
| 2026-09-23 | T2.8a rv-prediction 重启 | `feat/phase-2-no-silent-failure` | `666dd972513b2d18860375c3c1e6ee0455c1a2d2` | `be7cce0b8ad6` | 成功重新取得原锁 |
| 2026-09-23 | T2.8a default | `feat/phase-2-no-silent-failure` | `666dd972513b2d18860375c3c1e6ee0455c1a2d2` | `be7cce0b8ad6` | 灰度通过 |
| 2026-09-23 | T2.8a strategy-observation | `feat/phase-2-no-silent-failure` | `666dd972513b2d18860375c3c1e6ee0455c1a2d2` | `be7cce0b8ad6` | 灰度通过 |
| 2026-09-23 | Phase 2 tag | `v0.2.0` | `021139200a113d5cf1870246ed6a0c9a70abbd59` | `be7cce0b8ad6` | 注解 tag 指向 main 的 `--no-ff` 合并提交；tag 源码哈希与线上一致 |
| 2026-09-23 | rv-prediction | `main` / `v0.2.0` | `021139200a113d5cf1870246ed6a0c9a70abbd59` | `be7cce0b8ad6` | main 重装、观察一轮通过 |
| 2026-09-23 | default | `main` / `v0.2.0` | `021139200a113d5cf1870246ed6a0c9a70abbd59` | `be7cce0b8ad6` | main 重装通过 |
| 2026-09-23 | strategy-observation | `main` / `v0.2.0` | `021139200a113d5cf1870246ed6a0c9a70abbd59` | `be7cce0b8ad6` | main 重装通过 |
| 2026-09-23 | T3.1 rv-prediction | `feat/phase-3-restart-loop` | `bfb8c79f4785fe848dfca32b41ad50faffb7c73f` | `1eacb1e58346` | 灰度与轮询观察通过；spawn 1854 ms |
| 2026-09-23 | T3.1 default | `feat/phase-3-restart-loop` | `bfb8c79f4785fe848dfca32b41ad50faffb7c73f` | `1eacb1e58346` | 灰度与轮询观察通过；spawn 2275 ms |
| 2026-09-23 | T3.1 strategy-observation | `feat/phase-3-restart-loop` | `bfb8c79f4785fe848dfca32b41ad50faffb7c73f` | `1eacb1e58346` | 灰度与轮询观察通过；spawn 1414 ms |
| 2026-09-23 | T3.2 rv-prediction | `feat/phase-3-restart-loop` | `6f7c70135bea2efaff833625f5fb5fbd33e41fc6` | `1eacb1e58346` | 灰度与观察通过；supervisor `2257af0ad696`，ready 17:20:41 +0800，start_grace=60 |
| 2026-09-23 | T3.2 default | `feat/phase-3-restart-loop` | `6f7c70135bea2efaff833625f5fb5fbd33e41fc6` | `1eacb1e58346` | 灰度通过；supervisor `2257af0ad696`，ready 17:21:42 +0800，start_grace=60 |
| 2026-09-23 | T3.2 strategy-observation | `feat/phase-3-restart-loop` | `6f7c70135bea2efaff833625f5fb5fbd33e41fc6` | `1eacb1e58346` | 灰度通过；supervisor `2257af0ad696`，ready 17:22:18 +0800，start_grace=60 |
| 2026-09-23 | T3.3 rv-prediction | `feat/phase-3-restart-loop` | `32d12021739efd67539697a8b0a8bdadd53e1030` | `5334599a2dad` | 灰度与观察通过；supervisor `2257af0ad696`，ready 17:37:54 +0800，spawn 1175 ms |
| 2026-09-23 | T3.3 default | `feat/phase-3-restart-loop` | `32d12021739efd67539697a8b0a8bdadd53e1030` | `5334599a2dad` | 灰度通过；supervisor `2257af0ad696`，ready 17:38:28 +0800，spawn 1955 ms |
| 2026-09-23 | T3.3 strategy-observation | `feat/phase-3-restart-loop` | `32d12021739efd67539697a8b0a8bdadd53e1030` | `5334599a2dad` | 灰度通过；supervisor `2257af0ad696`，ready 17:39:10 +0800，spawn 1011 ms |
| 2026-09-23 | T3.4 rv-prediction | `feat/phase-3-restart-loop` | `8043a591792a8127c85509893b886536f688cac5` | `8fea81fe48e7` | 灰度通过；ready 18:26:46 +0800、spawn 1000 ms；无恢复汇总；supervisor `2257af0ad696` |
| 2026-09-23 | T3.4 default | `feat/phase-3-restart-loop` | `8043a591792a8127c85509893b886536f688cac5` | `8fea81fe48e7` | 灰度通过；ready 18:27:48 +0800、spawn 1704 ms；无恢复汇总；supervisor `2257af0ad696` |
| 2026-09-23 | T3.4 strategy-observation | `feat/phase-3-restart-loop` | `8043a591792a8127c85509893b886536f688cac5` | `8fea81fe48e7` | 灰度通过；ready 18:28:14 +0800、spawn 1078 ms；无恢复汇总；supervisor `2257af0ad696` |
| 2026-09-23 | T3.4b/T3.4a rv-prediction | `feat/phase-3-restart-loop` | `adbcca86c372b3b1d386acaaf1b97d2e6788be57` | `4e0985bd0bb3` | 安装与常规检查通过；ready 22:57:06 +0800，spawn 5504 ms；台账清空；auth_failing 待证实 |
| 2026-09-23 | T3.4b/T3.4a default | `feat/phase-3-restart-loop` | `adbcca86c372b3b1d386acaaf1b97d2e6788be57` | `4e0985bd0bb3` | 安装与常规检查通过；ready 23:02:23 +0800，spawn 7707 ms；backend=ok |
| 2026-09-23 | T3.4b/T3.4a strategy-observation | `feat/phase-3-restart-loop` | `adbcca86c372b3b1d386acaaf1b97d2e6788be57` | `4e0985bd0bb3` | 安装与常规检查通过；ready 23:03:04 +0800，spawn 2811 ms；backend=auth_failing |

**回滚锚点：`v0.1.1`** → commit `8c8e8b3`，index.js `889d4bd3` —— 经 2026-09-22 线上 `/status` 验收。

> ⚠️ tag 核对方法：注解 tag 必须用 `git rev-list -n1 <tag>` 取所指 commit。
> `git tag -l --format='%(objectname:short)'` 给的是 **tag 对象自身**的 sha（v0.1.1 = `72571de`），不是 commit。
> 2026-09-22 曾因此误判 v0.1.1 为无效锚点并多打了一个 `v0.1.2`（指向 `65a6f34`，代码与 `8c8e8b3` 零差异），
> 该冗余 tag 已删除（本地创建、从未 push）。`v0.1.0` → `3f27ff2` 为早期发布，index.js `b8d50a50`。

灰度顺序不得跳步：**rv-prediction → 默认实例 → strategy-observation**。
每批之间须确认：进程存活、`bridge.stdout.log` 出现 `Telegram Codex Bridge started.`、该实例能正常应答一次。

---

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-09-23 T3.2 | 宽限期递增规则存在数值矛盾：handoff「T3.2 补充」同时写“下一轮宽限期翻倍”和“60 → 120 → 300 秒封顶”；严格翻倍并封顶应为 60 → 120 → 240 → 300 | 已按顺序读取契约、Next Step/Decisions、T3.1 验收和 supervisor 全文；原样提交维护者三份规划文件 `4838e81` | 按用户硬约束停在实现前，请维护者选择严格翻倍含 240 秒，或固定三级 60/120/300。脚本及已有测试未改，没有安装或重启，线上仍为上轮已验收的 T3.1 版本；本轮未另作线上健康检查 |
| 2026-09-23 T2.5 | 重启复用 ack 的 inbox 持久化前提与实际生命周期冲突：dispatch 使用副本，turn/start 返回或进入内存队列即删除 inbox | 读取 TelegramInbox.run、startOrSteerTurn、turn/completed；新增 6 项管理器测试并做初步接入，复核发现缺口 | 停止修改业务代码及部署。需维护者明确 inbox 延迟出队与 turn/排队/steer/重试的完成边界；未勾选 T2.5，未推进 T2.6 |
| 2026-09-21 调查期 | `~/mnt/wukong` 这个 rclone 挂载不含 `Library/`，读不到 wukong 的 service 日志 | 1 | 改用 SSH `remote-mac-wukong` 直接在 wukong 上统计 |
| 2026-09-21 调查期 | SSH 非登录 shell 里 `npm` 与 `timeout` 均不存在 | 1 | 每个新 shell 先 `export PATH=/opt/homebrew/bin:$PATH`，测试直接用 `node --test` 而非 `npm test` |
| 2026-09-21 调查期 | 经 rclone 挂载写文件出现 `.partial` 未 finalize | 1 | 写完回到 wukong 用 `ls` / `wc -l` / `tail -1` 复验完整性，勿假定写入即生效 |
| 2026-09-21 调查期 | `sort \| uniq -c \| head -60` 漏算：得出 32 次，实际 2,866 次 | 1 | cf-ray 使每行唯一，桶被打散到 head 之外。改用 `grep -c` 直接计数 |

| 2026-09-21 T1.1 | 暂存内容含聊天 ID 格式值，与禁止提交标识及禁止修改实例 .env.* 的契约冲突 | 1：扫描并定位两份实例 env.example:3、multi-instance-launch-agent.test.js:43；不记录具体值 | 停在提交前，待最小模板脱敏授权及测试值确认；未 commit/部署 |

| 2026-09-22 T2.2/T2.3 | 仅持久化递增 offset 不能保证未处理消息可恢复；与不丢目标矛盾 | 1：对照 pollingLoop 与 T2.3 规格，确认 handler 异步且无入站重放持久层 | 按 §6 停在联动改动前，待确认 T2.3 inbox 规格 |
| 2026-09-23 T3.4b 灰度验收观察 | rv-prediction 的 auth_failing 预期尚未证实：重启后 backend=ok，未再有新认证 stderr；历史错误最后为 22:53:09，旧版持久化 lastAuthFailureAt 仍是 20:55 | 保持同一 PID 55600 观察超过 4.5 分钟，轮询持续成功、activeRequests=0、无 ack 编辑失败；未发测试 turn、未操作凭证。strategy 重启后新错误已正确标 auth_failing | 该项不记为通过，也不推断 rv 账号已恢复。已向维护者询问是否重新登录，尚无答复；三实例代码部署完成，真实 /status 与 rv 认证状态留待维护者确认。非规格冲突，未扩大修改范围 |

> 执行期新错误请追加在上表，**不要覆盖历史行**。同一错误第二次出现时先换方法再重试。

---

| 2026-09-23 T3.5 灰度门禁 | rv-prediction 安装后，脱敏计数发现 ps 中 3 个现有 bridge getUpdates curl 的 argv 仍包含 bot token；T3.5 要求部署期间任何 curl argv 不含 token，但 handoff 将 bridge TelegramApi.callOnce 改为 stdin config 明确列为 T4.8，且本轮范围不得改 bridge 汇总/发送逻辑 | 只统计数量并脱敏核对，未输出命令行/凭证；确认 supervisor 新增 curl 使用 `curl --config -`，测试覆盖其 argv 无 token；未继续安装 default/strategy | 这是 T3.5 部署门禁与“范围只到 T3.5 / T4.8 后续”之间的真实范围矛盾。停止扩范围，暂停灰度；rv 已安装本轮代码，default/strategy 保持上一版，等待维护者裁决是否单独纳入 T4.8 或放宽该门禁 |
## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 2 complete；main 已合并并标记 `v0.2.0`；Phase 3 尚未开始 |
| Where am I going? | 下一项 T3.1，Phase 3 与 Phase 4 仍按各自分支执行 |
| What's the goal? | 让任何一条被受理的消息在任何故障下都至少收到一条中文状态说明，不再出现零输出 |
| What have I learned? | Phase 2 的 inbox/outbox、ack、上游安全重试和实例锁已上线；T2.8a 修正跨目录同 token 抢锁，三实例 `/status` 经维护者确认。Phase 3 下一步处理重启死循环与失联可见。 |
| What have I done? | Phase 1 与 Phase 2 均完成；`v0.2.0` 指向 main 合并提交 `0211392`，三实例从 main 重新灰度安装；最近完整检查为 163/163 pass。 |

---

## 人工决策记录

| # | 事项 | 决议 | 日期 |
|---|---|---|---|
| 1 | T1.1 的提交信息由谁写 | **由 Codex 自行撰写**，须含多实例支持 + 每实例记忆隔离、须提到 `config/instances/` 角色文件、不得含任何 token/聊天 ID、不许写 `wip`/`update` 这类空信息 | 2026-09-21 |
| 2 | 工作区测试 bot token 由谁提供 | **不需要**。原任务已改写为 T2.8「修实例锁」。理由：wukong 上 3 个 bot 全在线上被轮询、无闲置；Phase 2 有 5 个任务纯单测可覆盖、2 个在线上实例验证即可，工作区不需要起 bridge | 2026-09-21 |
| 3 | 每个 Phase 完成后何时部署 | **立即部署，但必须走分支流程**：分支写码 → 从分支灰度部署到生产验证 → 验证通过再合并 main → main 打 tag | 2026-09-21 |
| 4 | 规划文件放哪 | 改用插件约定 `.planning/<PLAN_ID>/`，`PLAN_ID=2026-09-21-bridge-reliability`。首版 `docs/bridge-reliability/` 已删除，**不保留副本**以免两份真相 | 2026-09-21 |
| 5 | 换设备 / 换 agent 如何发现这份计划 | `.planning/` 在仓库根、未被 gitignore，随项目走。但隐藏目录无法被 Codex 自动发现 → 新建仓库根 `AGENTS.md` 作**跨 agent 入口**（Codex 自动读取），另加 `docs/bridge-reliability.md` 作**人类入口指针**（不是副本）。两个入口，一份真相 | 2026-09-21 |
| 6 | 过程文件 vs 长期工程文档 | 按生命周期分：`task_plan.md` / `progress.md` / `handoff_codex.md` 是过程产物，Phase 全 complete 后过期，留在 `.planning/`；`findings.md` 的根因结论是长期资产 → 新增 **T4.7** 在收口时提炼成 `docs/reliability-postmortem.md` | 2026-09-21 |

| 7 | T1.1 阻塞：模板含真实聊天 ID，与「禁止改 .env.*」死锁 | **批准脱敏 + 修正契约**。①两份 `config/instances/*.env.example:3` 的 allowlist 换占位符（`123456789,-1001234567890`）②`tests/multi-instance-launch-agent.test.js:43` **已核实为虚构值，不要动** ③契约新增 §3.2.1 把模板文件从「禁止触碰 .env.*」里拆出 —— 原规则过宽是我的错，Codex 照 §6 停下是正确的 | 2026-09-21 |
| 8 | 两个真实群 ID 已在公开仓库 | **不重写历史、不 force push**。`[REDACTED_CHAT_ID]` 与 `[REDACTED_CHAT_ID]` 已随 `index.js:58-59` push 到公开 repo（见 `findings.md` F15）。理由：force push 删不掉 fork 与 GitHub 缓存；chat ID 非凭据（不能借此加入/读取/发送）。改为立 **T1.6** 把硬编码 ID 挪出产品代码，阻止继续泄露。是否更换群属运营决定，不在计划范围 | 2026-09-21 |


### T1.1 续行（用户批准脱敏）

- 两份实例 env.example 的 allowlist 已换为显式占位符；已核实虚构的测试夹具保持不变。
- 新增人工调查记录也含真实 ID，已仅将具体值脱敏，保留结论及历史记录；未修改真实 env 或业务代码。
- 本轮提交前快照：

`git status --porcelain`
```text
M  .env.example
M  .gitignore
A  .planning/.active_plan
AM .planning/2026-09-21-bridge-reliability/findings.md
AM .planning/2026-09-21-bridge-reliability/handoff_codex.md
AM .planning/2026-09-21-bridge-reliability/progress.md
AM .planning/2026-09-21-bridge-reliability/task_plan.md
A  AGENTS.md
M  README.md
A  config/instances/rv-prediction.AGENTS.md
AM config/instances/rv-prediction.env.example
A  config/instances/strategy-observation.AGENTS.md
AM config/instances/strategy-observation.env.example
A  docs/MULTI-INSTANCE.md
A  docs/bridge-reliability.md
M  index.js
M  package.json
M  scripts/install-launch-agent.sh
M  scripts/uninstall-launch-agent.sh
A  tests/multi-instance-launch-agent.test.js
M  tests/telegram-transport-recovery.test.js
M  tests/truth-profile.test.js
```

`git stash list`
```text

```

`git log --oneline -3`
```text
884811e Harden bridge transport recovery and log rotation
9bb7564 Harden bridge routing and turn privacy
cb6c0b2 Auto-run Deribit strategy approval gates
```

### T1.1 complete

- 完成提交 `be579fd662d65359f0cd3813726a2b9839fe0d69`（main）。提交后 `git status --porcelain` 为空，`git stash list` 仍为空；git show --stat 含两个角色文件、MULTI-INSTANCE 文档与多实例测试。
- 指定检查再次全部通过：99/99，fail 0；node 语法与四个 zsh 脚本语法通过。
- 修改：两份实例 env.example（allowlist 占位符）、planning 三文件（记录与新添记录的标识脱敏）；未修改测试夹具或业务代码。
- 原始 index.js 中已公开的默认绑定按契约留到下一任务 T1.6 处理。

### T1.6 complete

- Removed hardcoded default chat bindings from `index.js`.
- Added startup loading of private `data/chat-project-bindings.json`; installer migrates legacy bindings before rsync and preserves an existing file. External `SOURCE_REGISTRY_PATH` bindings override local values.
- Added malformed-binding validation, migration tests, and documentation. Tests: 101/101 pass; node and all four zsh syntax checks pass.
- Real runtime env files were not modified. No real chat IDs remain in product code or tracked test/config/docs content; legacy IDs remain only in ignored `config/instances/*.env` runtime files.

### T1.2 complete

- Commit `1fff4df`: startup and `/status` expose full `index.js` SHA-256 plus 8-character version.
- Validation: 102/102 tests pass; node and four zsh syntax checks pass.

### T1.3 complete

- Commit `d61cd51`: installer rejects dirty worktrees unless `BRIDGE_ALLOW_DIRTY=1`, writes `DEPLOYED_REF` with commit/ref, and excludes `.planning/` from rsync.
- Added tests for refusal, ref file, and planning exclusion. Validation: 104/104 tests pass; syntax checks pass.
- `BRIDGE_ALLOW_DIRTY=1` is used only by isolated dry-run tests; production install will require a clean tree.

### T1.4 complete

- Installed default W-SVC via `npm run install:launch-agent`.
- Workspace and installed `index.js` SHA-256 match (`889d4bd36bfc...`); `DEPLOYED_REF` records commit `bca12d3...` and ref `v0.1.0-22-gbca12d3`.
- LaunchAgent, all three bridge processes, startup log, version line, and private migrated bindings verified. No manual service-directory edits.

### T1.5 complete

- Gray deployed rv-prediction first, then strategy-observation through their install scripts.
- All four `index.js` copies match SHA-256 `889d4bd36bfc743eb2c0d8f28364de84667221764514678809d748378e897cb3`.
- Both named LaunchAgents are running; startup logs show `codeVersion=889d4bd3`; role files retain their instance-specific first five lines; each private bindings file is mode 600.
- Deployment refs: default `bca12d3` (installed T1.4), named instances `65a6f34` (installed T1.5). The source hash is identical; the later named ref includes planning-only commits after the default install.
- No real user message was sent; live response confirmation remains the manual smoke limitation.

### Phase 1 closeout

- T1.1, T1.6, T1.2, T1.3, T1.4, T1.5 complete. Tag `v0.1.1` points to Phase 1 closeout commit `8c8e8b3`. No Phase 2 code started.

### 收口更正（以本条为准，保留以上历史）

- Phase 1 不能标 complete：部署与哈希验证已完成，但三实例正常应答、/status truthProfile 前后比对尚无证据。T1.6/T1.4/T1.5 线上验收待完成。
- 此次默认 → rv-prediction → strategy-observation 已执行，且 rv 安装与 strategy 安装之间未取得正常应答证据；不满足 handoff §4.4 的逐批验证要求。停止继续部署及 Phase 2 工作。
- T1.3 DEPLOYED_REF 已写入，但尚未在启动日志打印；待补。
- v0.1.1 已创建，但验收不足，不能作为已验证发布锚点；不删除或重写 tag。
- 脏工作树测试已恢复动态断言，改用独立临时 Git 仓库制造未跟踪文件，验证拒绝且未创建服务目录；不会依赖当前仓库是否干净。
- 下一步补齐上述实现与线上验收后才能收口；前文 complete/灰度通过指实现或部署检查，不能替代完整验收。

- T1.3 补齐：启动时打印 DEPLOYED_REF；根 .env.example 记录安装时 BRIDGE_ALLOW_DIRTY 的 shell 用法。该补丁尚未部署，线上 index.js 与最新工作区哈希因此暂不一致；不以旧部署哈希替代当前源码验收。
- 最终本地 npm test：104/104，通过 node 及四脚本语法检查；等待三实例实际应答后再继续部署此补丁。

---

## Session: 2026-09-22 — Phase 1 线上验收通过

### Phase 1 验收证据（§4.4 真实应答）

人工在三个 bot 私聊各发一次 `/status`，回复核对结果：

| bot | codeVersion | truthProfile | 结论 |
|---|---|---|---|
| `@Codex_Bz01_bot`（default） | `889d4bd3` | 与基线一致 | ✅ |
| `@Codex_OBS_bot` | `889d4bd3` | 与基线一致 | ✅ |
| `@Codex_RV_bot` | `889d4bd3` | 与基线一致 | ✅ |

> 说明：`/status` **无法由 Claude 或 Codex 代发** —— Telegram Bot API 没有「以用户身份给 bot 发消息」的接口；
> 而用生产 token 调 `getUpdates` 会抢走运行中 bridge 的更新，正是 R6/R7 的丢消息路径，故禁止。
> 此项验收只能人工执行，已于 2026-09-22 由维护者完成。**后续每个 Phase 收口同样适用。**

### 两个部署源的等价性核验

三实例部署自不同 commit，但代码层面等价，因此可用单一 tag 作锚点：

| commit | 用于 | index.js sha256 前 8 |
|---|---|---|
| `bca12d3`（`v0.1.0-22`） | default 实例 | `889d4bd3` |
| `65a6f34`（`v0.1.0-23`） | strategy-observation / rv-prediction | `889d4bd3` |

`git diff bca12d3 65a6f34` 排除 `.planning` 与 `docs` 后 → **零差异**（差异只在规划文件）。

### T1.3 守卫落地核验

- `scripts/install-launch-agent.sh:6-12` —— `BRIDGE_ALLOW_DIRTY != 1` 且工作树脏时拒绝安装，显式绕过时打警告
- `tests/multi-instance-launch-agent.test.js:100` —— `installer refuses dirty working trees unless explicitly allowed`，断言 `/working tree is dirty/`
- 三实例 `DEPLOYED_REF` 均已写入，内容为 `commit=<sha>` + `ref=<describe>`

**残留**：HEAD `952675e` 含「启动日志打印 DEPLOYED_REF」增补，尚未部署（线上启动日志已有 `codeVersion=`，无 `DEPLOYED_REF=`）。
判定为**不阻塞收口** —— T1.3 的两个核心交付（守卫 + `DEPLOYED_REF` 文件）均已部署且有测试覆盖；
该增补随 Phase 2 首次部署一并上线，避免为一行日志再占用一轮人工 `/status` 验收。

### 验收标准的一处措辞修正

原 T1.3 验收写「`DEPLOYED_REF` 等于 `git rev-parse HEAD`」—— 该等式只在**部署当刻**成立。
HEAD 此后前进属正常，不应据此判失败。正确表述：**`DEPLOYED_REF` 等于部署当刻的 HEAD，并在台账留痕**。


## Session: 2026-09-22 — Phase 2

### T2.1 complete

- `sendMessage` is now in the Telegram retry whitelist.
- Telegram transient detection includes HTTP 429 / `Too Many Requests`; `parameters.retry_after` controls millisecond backoff without shortening the server delay, with linear fallback for transport errors.
- Added focused tests for send retry success and 429 retry-after calculation.
- Validation: `node -c index.js`, **106/106 tests pass**, and all four zsh syntax checks pass.
- Files: `index.js`, `tests/context-compaction.test.js`.

### T2.1 补充验证与 T2.2/T2.3 阻塞（2026-09-22）

- T2.1：识别结构化 error_code=429；不把 retry_after 截短到 120s；长延迟分片等待避免 Node timer 溢出；空值回退到 500 × attempt 毫秒。新增实际 retry loop 的 180s 退避测试（注入 sleep、不真实等待）、永久失败不重试及最多四次请求测试。
- 指定完整验证 `npm test`：108/108 pass，fail 0，node 与四项 zsh 语法检查通过。
- 原 `sendMessage at-most-once=false` 断言随 T2.1 明确要求改变发送语义而改为 true；这是与契约“已有断言不可改”的冲突，已发生且在此显式记录，未通过条件分支伪装兼容旧语义。
- T2.2/T2.3 未写代码、未部署。读取 pollingLoop 后发现 T2.3 规格与“不丢消息”目标矛盾：当前先推进 offset，再异步启动 handler；强制落盘递增 offset 只会使崩溃后跳过已取回但未处理消息的行为持久化。
- 具体路径：取回 update_id=N → 持久化 offset=N+1 → handler 尚未完成即崩溃 → 重启请求 N+1；没有持久化 update 内容就无从重放。SIGTERM 只 flush offset 也不能补齐这一点。T2.4 出站 outbox 对尚未产生回复的入站消息无帮助。
- 建议修正规格为持久化 inbox：入站 update 与 offset 原子写入；恢复时重放未完成项；定义成功处理/可恢复交接后再移除，并通过崩溃恢复测试验证。需要确认允许在 T2.3 内加入这项持久层，不自行扩展。
- 影响：线上仍为已验收 Phase 1；本分支仅 T2.1，未合并 main、未部署、未使用生产 token 测试。

### T2.3 规格矛盾的裁决（2026-09-22）

**Codex 的判断正确，规格是我写错的。** 原 T2.3 写「取得 update → 立即强制写盘 offset → 再处理」，
忽略了 Telegram 的 `offset` 同时是「这些我收到了，你可以删」的回执语义：

```
1. 收到 5 条，offset 推到 6，存盘 ✅
2. 处理第 1 条时进程被杀
3. 重启读到 offset=6，向 Telegram 要第 6 条以后
4. Telegram：前 5 条你早确认过了，已删 → 5 条消息永久消失且无记录
```

与 T2.2 的 `store.save({ force: true })` 叠加后，该损失从偶发变为**每次优雅关闭必然发生** ——
与「宁可重复，不要丢」的既定取舍完全相反。

**裁决：批准修正为「offset 与消息内容原子同写 + 重启重放未完成消息」**，并强制实现四条护栏：
重放次数 ≤2（超限发中文放弃通知并出队）、年龄 ≤24h、条数 ≤200 + 单条长度上限、重放条目带 `isReplay`。
其中**重放上限最关键** —— 本机历史 274 次强杀、一次连续 13h44m 重启风暴，无上限即死循环。

**范围说明**：T2.3 由「调换两行顺序」变成「实现入站日志」，属**规格纠错**而非执行方扩大范围。
T2.2 与 T2.3 须在同一个 commit 落地，分开会留下比现状更糟的中间态。


### T2.2 + T2.3 complete

- Implemented `installGracefulShutdown`: force-saves the store, marks Telegram transport closing, terminates tracked curl children, stops app-server, then exits with the signal code. Lock cleanup remains attached to process exit.
- Implemented durable in-store Telegram inbox: accepted updates persist minimal message/callback metadata and the advanced offset in one atomic store save before dispatch; successful handlers dequeue and save.
- Startup replays inbox items in ascending update order with `isReplay`; safeguards enforce max two replays, 24-hour age, 200 entries, and 16,384-character text. Exhausted items are removed and receive a Chinese abandonment notice; expired/overflow items emit error classes.
- Added isolated tests for atomic persistence, replay ordering/counters, exhaustion, expiry, capacity/text limits, rollback on save failure, callback metadata, SIGTERM flush, curl/app-server child termination, and secret-field omission.
- Validation: **116/116 tests pass**, `node -c index.js`, and all four zsh syntax checks pass.
- Files: `index.js`, `tests/inbox-shutdown.test.js`.
- Deployment remains pending; this branch has not used production tokens or restarted installed services.

### T2.2 + T2.3 验收（2026-09-22）—— 通过，但部署前需修一个回归

**核心不变量逐条核验通过**（读代码，非依据总结）：

| 检查项 | 位置 | 结果 |
|---|---|---|
| offset 与 inbox 原子同写 | `TelegramInbox.accept()` | ✅ 快照 old → 改副本 → **一次** `save({force:true})` → 失败回滚；两者同在一个 store 对象，共用同一次 `atomicWriteJson` |
| `replayCount` 递增并持久化**在 dispatch 之前** | `TelegramInbox.run()` | ✅ `item.replayCount++` + `save({force:true})` 先于 `await this.dispatch(...)`，崩溃时盘上已有递增值，上限真实生效 |
| 重放上限语义 | `run()` | ✅ 允许 2 次重放，第 3 次放弃并出队 |
| SIGTERM 三件事 | `installGracefulShutdown()` | ✅ `store.save({force:true})` → `telegram.close()` + `server.stopAndWait()` → exit |
| curl 子进程追踪与终止 | `TelegramApi.children` / `terminateChild()` | ✅ `add` + `once("close")` 清理；SIGTERM 后 1 秒 SIGKILL |
| 四条护栏 | — | ✅ 200 条 / 16384 字符 / 24 小时 / `isReplay` 全部落地 |
| 测试 | `tests/inbox-shutdown.test.js` | ✅ 8 个用例，覆盖要求的 6 项 + 2 项额外（原子写失败回滚、callback 路由元数据）。**116/116** |

**三处实现优于规格，记录备查**：
1. 容量超限时 `break` 在 `state.offset = update.update_id + 1` **之前** —— 存不下的 update 不予确认，交由 Telegram 重投。规格未要求
2. 放弃通知**先 `remove` 再 `notify`** —— 否则 notify 抛异常会导致永久重放。规格未要求
3. `this.closing = true` 且 `callOnce` 在 closing 时直接抛错 —— 关闭期间不再发起新请求。规格未要求

**发现一个回归 → 立 T2.3a，部署前必修**：

启动尾部为 `await inbox.replay();` 然后 `await pollingLoop();`。`replay()` 内部串行 `await run()` →
`dispatch()` → `handleMessage()` → 完整 Codex turn（可能数分钟）。
一条卡住的重放 turn 会让 `pollingLoop` **永不启动** → bot 对新消息完全无反应。
`findings.md` F5 已证明 turn 确会卡死（6 次 `stream disconnected`、24 个孤儿 turn），
且与 08-30 重启风暴叠加会更严重。**这是本计划要消灭的症状被本次修复自身引入。**

改法：`void inbox.replay().catch(...)` + 立即 `await pollingLoop()`。
`replay()` 内部串行顺序不变；`active` Set 已防同一 `update_id` 重复 dispatch，与新轮询并发安全。

**两项非阻塞后续，已并入 T2.4 规格**：
1. 放弃通知目前直发 `notify`，失败即零输出 → 改走 outbox
2. inbox 满 200 时 offset 冻结、新消息全不处理，但群里无任何提示 → 应发中文说明并设最小间隔

### T2.3a 实现与本地验收（2026-09-22）

- 修复前：新增测试直接执行 index.js 的真实启动尾部，注入永不 resolve 的 replay dispatch，100ms 内 pollingLoop 未启动，断言 blocked != done 失败，复现启动失联。
- 修复：仅将启动尾部 await inbox.replay() 改为后台启动并捕获异常，pollingLoop 随即启动；保留内部串行 replay 和 active Set。
- 修复后：同测试验证新 update 被处理、旧 pending update 仍持久化；npm test 117/117 pass，node 与四项 zsh 语法全部通过。
- 文件：index.js、tests/inbox-shutdown.test.js；本轮维护者更新的 handoff/task_plan/progress 一起入库，避免部署脏树。
- T2.3a 本地 complete，首次灰度与 kill/restart smoke 接下来执行。只从 rv-prediction 开始，未通过真实应答不推第二批。


### T2.3a 首次部署 + rv-prediction kill/restart smoke（2026-09-22）

- 部署目标：仅 `rv-prediction`，通过 `npm run install:rv-prediction`；工作区与服务 index.js SHA-256 均为 `f3226f5555d4...`，DEPLOYED_REF commit `746aab7`。
- 启动日志确认 `Deployed ref`、`Telegram Codex Bridge started`、`codeVersion=f3226f55`；启动后 store inbox 为空，随后轮询状态持续更新。
- 对旧 bridge PID 发送 SIGTERM；supervisor 记录 stop/start 并拉起新 PID，新的启动日志完整出现。旧 rv bridge 的 curl 未残留；观测到的 curl 为三个当前实例各自新的长轮询子进程。
- 这批 smoke 通过。日志同时有既存 Codex 上游 401 refresh/auth 错误和 Telegram proxy SSL 重试，属于上游/环境现象，不归因 T2.3a，未改范围。
- T2.3a 已可标记 complete；其他实例尚未部署本分支。


### T2.3a Phase 2 first deployment closeout

- Default and strategy-observation deployed after rv smoke; all three installed copies match workspace SHA-256 `f3226f5555d4...`.
- All three LaunchAgents are running; logs show `Telegram Codex Bridge started`, `codeVersion=f3226f55`, and deployed refs. Named role files remain instance-specific.
- Current runtime curl list contains one active long-poll child per bot; no stale duplicate from the rv restart was observed.
- Phase 2 first deployment is complete for T2.2/T2.3/T2.3a. Next task is T2.4 outbox; no T2.4 code has started.

### T2.3a + Phase 2 首批部署验收（2026-09-22 22:08）

**逐项核实通过**（读代码与线上状态，非依据总结）：

| 检查项 | 结果 |
|---|---|
| T2.3a 改动在代码里 | ✅ `void inbox.replay().catch(...)` + 立即 `await pollingLoop()` |
| 回归测试存在 | ✅ `tests/inbox-shutdown.test.js:129` —— `a pending replay must not block polling startup` |
| 测试 | ✅ **117 / 117 / fail 0** |
| 分支与工作树 | ✅ `feat/phase-2-no-silent-failure`，工作树干净 |
| 四份 index.js 哈希一致 | ✅ workspace 与三实例均 `f3226f55` |
| `DEPLOYED_REF` | ✅ rv-prediction `746aab77`（T2.3a commit）；default / strategy-observation `d2658888`（两者 index.js 同为 f3226f55） |
| 启动日志三标记 | ✅ `Deployed ref: commit=… ref=v0.1.1-N-g…` / `Telegram Codex Bridge started.` / `codeVersion=f3226f55` |
| inbox 状态 | ✅ 三实例均 `inbox=0`（无积压残留） |
| 灰度顺序 | ✅ rv-prediction → default → strategy-observation |
| curl 孤儿 | ✅ 仅 3 个正在进行的 getUpdates 长轮询，每实例 1 个，无残留 |

**尚缺：§4.4 真实应答证据。** 部署于 21:56，至今（22:08）三实例**均无任何 rollout 活动**，
说明没有任何真实对话发生过。Codex 报告的「重启后正常恢复」来自日志与轮询恢复，不等于真实应答。
T2.3a 修复的恰是「日志正常但 bot 是聋的」这一类故障，因此本次真实应答验证比平时更关键。
→ 需人工在三个 bot 各发一次 `/status`，确认 `codeVersion=f3226f55`。

### ⚠️ 事故记录：验收过程中 bot token 被带入会话记录（2026-09-22）

**经过**：核对 curl 孤儿进程时执行了未脱敏的 `pgrep -fl curl`，输出包含三个实例完整的
`https://api.telegram.org/bot<id>:<token>/getUpdates` 命令行，三个 bot token 因此进入本次会话记录。

**责任在规划方（Claude），不在 Codex。** `handoff_codex.md` §3.3 明确禁止把 token 写进日志/文档/提交，
但该约束未覆盖「诊断命令的输出」，且执行时未先脱敏。

**根因（既有设计，非本次改动引入）**：Telegram Bot API 把 token 放在 URL 路径里，
`TelegramApi.callOnce()` 用 `execFile("curl", [... url ...])`，于是完整 token 出现在进程 argv 中。
经 `ps -Ao args` 核实：本机有 3 个进程含完整 token，均以 `wukong` 身份运行。
macOS 通常不允许非 root 的其它用户读取他人进程 argv，故**机器层面的暴露面有限**；
真正的暴露是**任何以 `wukong` 身份运行的进程（含各类 agent）都能直接读到**，本次即属此类。

**处置**：
1. → 新增 **T4.8**：改用 `curl --config -` 从 stdin 传含 token 的 URL，使 argv 不再出现 token
2. 仓库内所有诊断类命令一律先脱敏再输出（例：`sed -E 's|bot[0-9]+:[A-Za-z0-9_-]+|bot<REDACTED>|g'`）
3. **是否轮换这三个 token 由维护者决定** —— 凭据已进入一份会话记录，按惯例建议轮换；
   轮换需同步更新三份 service `.env` 并重启。不轮换亦可，但应知悉该记录含凭据


### T2.4 complete

- Added persistent Telegram outbox inside `store.data.telegram.outbox`, using the same atomic store boundary as inbox.
- Failed sends remain queued with replay count and next-attempt time; startup and successful polls trigger non-blocking flush. Successful sends are removed only after the API result is received.
- Replay-abandon notices now enqueue before removing the inbox item, so failed notification delivery remains durable. Full inbox emits a Chinese notice through outbox with a 60-second per-chat minimum interval.
- Added six isolated outbox tests: failure persistence/reload, result preservation and de-duplication, durable abandon notice, capacity notice throttling, disk failure/retry deadline, and fresh-process replay.
- Validation: **123/123 tests pass**, `node -c index.js`, all four zsh syntax checks, and `git diff --check` pass.
- Files: `index.js`, `tests/outbox.test.js`.
- Deployment of T2.4 is pending; current installed services remain the T2.3a build until this task is reviewed for deployment.

### T2.4 验收（2026-09-22）—— 通过，但部署前需补两个缺口

**核实通过**（读代码，非依据总结）：

| 检查项 | 结果 |
|---|---|
| outbox 与 inbox 共用 store 原子保存 | ✅ 同在 `store.data.telegram`，`enqueue` / 成功出队 / 失败退避均 `save({force:true})` 且带回滚 |
| 失败保留 + 启动与轮询补发 | ✅ `deliver()` 失败时持久化 `replayCount` 与 `nextAttemptAt`；`flush()` 在启动（`:4473`）与轮询（`:8927`）各调一次 |
| **flush 不阻塞轮询** | ✅ 两处均为 `void outbox.flush().catch(...)`，并注明 `without allowing a stalled send to block polling` —— **T2.3a 的教训已被主动应用** |
| 放弃通知与 inbox 满提示经 outbox | ✅ 两者都走 `outbox.enqueue` + `void deliver`，不再直发 |
| inbox 满提示 60 秒/chat 间隔 | ✅ `capacityNotices` Map，`now - last >= 60000`；且仍 `break`，不确认存不下的 update |
| 并发去重 | ✅ `active` Map 按 id 去重；`flushing` 保证同时只有一次 flush |
| 底层串行未被破坏 | ✅ `send` 仍走 `telegram.call("sendMessage", …, { serialize: true })` |
| 测试 | ✅ 新增 6 组，选题到位（并发 flush 不重复发、入队磁盘失败绝不发送、被杀进程重启自动补发）。**123 / 123 / fail 0** |

**发现两个缺口 → 立 T2.4a，部署前必修**：

1. **outbox 无任何容量与年龄上限。** inbox 有 200 条 / 16384 字符 / 24 小时三道闸，outbox 一道都没有。
   Telegram 长时间不可用时（08-30 那种 13h44m）队列无界增长，而 `save({force:true})` 是全量重写
   `store.json`，越长越慢，最终拖垮 bridge。**inbox 有闸、outbox 没有，这个不对称本身就是信号。**
2. **永久错误无限重试。** `deliver()` 的 catch 不区分错误类型：403 `bot was blocked by the user`、
   400 `chat not found` 这类永久拒绝会每 30 秒重试一次、永远留在队列里，与第 1 点叠加后队列永不排空。
   inbox 有 `replayCount >= 2` 放弃机制，outbox 没有任何放弃条件。

**一处已知取舍，记录备查（不修）**：失败重试会造成 per-chat 乱序 —— 第 1 条失败排到 30 秒后、
第 2 条立即成功，用户先看到第 2 条。**不做** head-of-line blocking：若为保序而阻塞该 chat 后续回复，
一条卡住的消息会让整个会话静默，那比乱序更糟且正是本计划要消灭的症状。
改为靠 T2.4a 的放弃条件把「一条能卡多久」限定在有界范围内。

**一处次要问题（可并入 T2.4a）**：`deliver()` 失败分支里的 `this.store.save({ force: true })` 无 try/catch。
磁盘满时（findings F3 记录过 157 次 `no space left`）该异常会覆盖原始发送错误，导致错误归因错乱。

### `f3226f55` 的 §4.4 真实应答验收（2026-09-22，账已清）

人工在三个 bot 各发一次 `/status`，三者均返回 `codeVersion=f3226f55`。
T2.2 / T2.3 / T2.3a 的线上验收至此完整闭合：代码一致（哈希）＋ 启动标记（日志）＋ **真实应答（人工）** 三项齐备。

意义不只是走完流程：T2.3a 修的正是「日志一切正常但 bot 是聋的」，
这类故障只有真实应答能证伪，哈希与启动日志都证明不了。

**下一次部署（outbox）必须重复同样三项**，且不要与本次叠在一起 —— 否则出问题无法定位到具体哪一批。


### T2.4a complete

- Added outbox capacity 500 with `priority`; overflow removes oldest non-notice first, preserves notice items, increments `bridge_outbox_overflow` and cumulative discard count.
- Added 24-hour expiry with `bridge_outbox_expired`.
- Added permanent Telegram rejection classification for 400/403 chat/member/block/kick forms; removes immediately with `telegram_permanent_reject`.
- Added retryable failure ceiling of 10 attempts; exhausted items are removed with `bridge_outbox_giveup`.
- Added `/status` fields `outboxQueued` and `outboxDiscarded`.
- Guarded failure-state persistence so a disk-save error is logged separately and cannot replace the original send error.
- Added six T2.4a tests. Validation: `node -c index.js`, **129/129 tests pass**, all four zsh syntax checks, and diff check pass.
- Files: `index.js`, `tests/outbox.test.js`.
- T2.4a is complete; deployment can proceed in the mandated order. No `findings.md` changes made.


### T2.4a deployment closeout (2026-09-22)

- Gray order completed: rv-prediction → default → strategy-observation.
- All four `index.js` copies match SHA-256 `ec5dd00482c0...`; all three LaunchAgents and bridge processes are running.
- Each startup log contains `Deployed ref`, `Telegram Codex Bridge started`, and `codeVersion=ec5dd004`; both named AGENTS.md role headers remain intact.
- rv-prediction SIGTERM/restart smoke passed before the other two deployments. After restart, store showed inbox 0, outbox 0, discarded 0. No stale curl was observed; final process inspection shows exactly one redacted getUpdates curl per bot.
- T2.4a deployed. No source or runtime directories were manually edited.
- Manual `/status` evidence is still required for this outbox build. Expected values for each bot: `codeVersion: ec5dd004`, `outboxQueued: 0`, `outboxDiscarded: 0`; verify `truthProfile` remains the instance baseline. Do not use Bot API/getUpdates for this check.

### T2.4a 验收（2026-09-23）—— 五项全部落地，但发现一个已上线的丢消息缺陷

**核实通过**（读代码 + 实跑验证，非依据总结）：

| 检查项 | 结果 |
|---|---|
| 三项上限常量 | ✅ `MAX_ITEMS=500` / `MAX_AGE_MS=24h` / `MAX_RETRIES=10` |
| 溢出优先丢非通知类 | ✅ `_trimOverflow()` 用 `findIndex(e => e.priority !== "notice")`，全为通知时才退回 index 0 |
| 通知类正确标记 | ✅ inbox 满提示与重放放弃通知均以 `{ priority: "notice" }` 入队 |
| 丢弃计数跨重启持久化 | ✅ `_stats()` 落在 `store.data.telegram.outboxStats`，`_remove` 失败时回滚计数 |
| `/status` 新字段 | ✅ `outboxQueued` / `outboxDiscarded` |
| 失败分支 save 不覆盖原始错误 | ✅ 独立 try/catch，记 `bridge_outbox_state_save_failed` 后仍 `throw error`（原始错误）—— 上轮要求的修复已正确落地 |
| 测试 | ✅ **129 / 129 / fail 0** |
| 四份哈希一致 | ✅ workspace 与三实例均 `ec5dd004`，三份 `DEPLOYED_REF` 同为 `c4d4ef4` |
| §4.4 真实应答 | ✅ 2026-09-23 人工确认三个 bot |

**缺陷（已上线）→ 立 T2.4b 热修**：

`_isPermanentReject()` 除结构化的 `error_code === 403` 外，还对**整条错误消息**做
自由文本 `/(?:^|\D)403(?:\D|$)/` 匹配。把该函数抽出实跑验证：

| 输入 | 实测判定 |
|---|---|
| 429 限流，description `Too Many Requests: retry after 403` | ❌ 判为永久 → **回复被永久丢弃** |
| 传输层 `curl: (28) Operation timed out after 403 milliseconds` | ❌ 判为永久 → **丢弃** |
| 真实 `403 Forbidden: bot was blocked by the user` | ✅ 正确 |

**该分支只会制造假阳性、不可能带来真阳性**：`callOnce` 对所有 API 层错误都设了
`err.body = parsed`，真实拒绝必然走得通结构化判断；`body` 缺失只发生在传输层错误，
而传输层错误永远不是永久拒绝。所以自由文本匹配零收益、纯风险。

**与前几轮的区别**：T2.3a / T2.4a 都是部署前拦下的，**这次已经在线上三个实例跑着**。
单次触发概率低（需错误文本中恰好出现被非数字包围的 403），但后果是静默永久丢一条回复。

**不回滚**：回滚会一并失去 T2.4a 的 outbox 有界化，而无界增长拖垮 bridge 的后果更重。
按热修处理，排在 T2.5 之前。

**一个仍未被真实验证的点**：`/status` 显示 `outboxQueued: 0 / outboxDiscarded: 0`，
说明线上**尚未发生过真实的失败投递**，T2.4/T2.4a 的核心路径（失败 → 持久化 → 补发）
目前只有单测覆盖。真正的验证要等一次真实网络抖动，或在 Phase 3 完成后主动制造一次。


### T2.4b hotfix implementation and pre-deployment validation (2026-09-23)

- Committed planning updates unchanged first as `8dda00e` so the installer dirty-tree guard remains meaningful.
- Added four regression tests before the fix; old code failed 3/4 as expected (429 text, transport text, and body-only blocked description).
- Changed `TelegramOutbox._isPermanentReject` to require a structured `error.body`, recognize `error_code === 403`, and inspect only permanent-rejection descriptions; the compatibility path preserves the existing chat-not-found test when a structured body omits `description` without restoring numeric `403` text matching.
- Validation: `node -c index.js`, **133/133 tests pass**, all four required `zsh -n` checks, and `git diff --check`.
- Code commit: `af00a9b` (`Fix Telegram outbox permanent reject classification`), workspace `index.js` SHA-256 prefix `3562402dbada`.
- Files: `index.js`, `tests/outbox.test.js`; `findings.md` unchanged.
- Deployment pending; next step is gray deployment rv-prediction → default → strategy-observation, then manual `/status` confirmation by the maintainer.


### T2.4b 灰度部署收口（2026-09-23）

- 灰度顺序严格为 rv-prediction → 观察一轮 → default → strategy-observation；三批安装脚本均成功。
- 最终四份 `index.js`（工作区 + 三服务目录）哈希一致：`3562402dbada`；三份 `DEPLOYED_REF` 均为 commit `364e0f3`。
- 三个 LaunchAgent/bridge 进程存活；三份启动日志均有 `Deployed ref`、`Telegram Codex Bridge started`、`codeVersion=3562402d`；两个命名实例角色文件未被覆盖。
- 脱敏 curl 检查显示每个 bot 一个活动的 `getUpdates` 长轮询，无残留旧进程。
- 人工 `/status` 仍需维护者执行：预期 `codeVersion=3562402d`、`outboxQueued=0`、`outboxDiscarded=0`，且各实例 `truthProfile` 与既有基线不变；不要调用 Bot API `getUpdates` 验收。

### T2.4b 验收（2026-09-23）—— 通过，线上已确认

| 检查项 | 结果 |
|---|---|
| 误判用例实跑 | ✅ 429「retry after 403」→ 可重试；传输层「after 403 ms」→ 可重试；真 403 → 永久；chat not found → 永久 |
| 测试先失败后通过 | ✅ 旧代码上 4 个新测试失败 3 个，符合预期 |
| 测试 | ✅ **133 / 133 / fail 0** |
| 四份哈希 | ✅ `3562402dbada`，三份 `DEPLOYED_REF` 均 `364e0f3` |
| 清单 | ✅ T2.4a 行保留，T2.4b 已勾，未删行 |
| §4.4 真实应答 | ✅ 2026-09-23 人工确认：`codeVersion=3562402d`、`outboxQueued=0`、`outboxDiscarded=0`、truthProfile 不变 |

与规格的一处出入（可接受）：`body` 存在但无 `description` 时回退到整条消息做描述匹配。
只在 `body` 存在时可达，传输层错误碰不到；为保留既有 chat-not-found 测试而加，无需返工。


### T2.5 未完成：生命周期前提冲突（2026-09-23）

- 维护者三份规划文件已原样单独提交为 `2d60d73`（Record T2.4b acceptance and refine T2.5 spec）。
- 草稿文件：`index.js`、新增 `tests/ack.test.js`；均未提交、未部署。`findings.md` 保持只读；task_plan 的 T2.5 保持未勾选，Next Step 仍为 T2.5。
- 现象：`TelegramInbox.run()` 调用 `dispatch({ ...item, isReplay })`，dispatch 收到副本；完成 dispatch 后直接 `remove(item)`。实际 `handleMessage` 等待的是 `startOrSteerTurn`，它在 `turn/start` RPC 返回或入内存队列时结束，不等待 `turn/completed`。所以 ack ID 写副本不会持久化，改写原条目也会很快被删除，无法实现处理中重启后编辑原 ack。
- 需要明确的最小规格补充：Codex 消息是否必须保留 inbox 到 turn 终态；明确排队、private steer、多次内部恢复重试的 inbox/ack 归属与出队条件。T2.5 规格当前没有定义这些，既有文档将 dispatch 完成当成 turn 完成；本轮不擅自改出队架构。
- 已尝试：6 项新增测试先在旧代码失败（缺少 TelegramAckManager），草稿实现后 6/6 通过；全套 **139/139 pass / fail 0**，`node -c index.js`、指定四项 `zsh -n`、`git diff --check` 通过。测试只覆盖管理器，不证明生产接入正确，因此 T2.5 不算完成。
- 草稿复核还需修正：`/continue` 与 `/review` 未接 ack；排队旧提示仍单独发；首发 outbox 延迟补发结果尚未关联 ack；失败更新使用 force 可绕过 3 秒间隔；requestId 未持久化且无正常状态日志；首次创建 thread 会清空 pendingInputMeta；这些都不能以管理器单测全绿替代验收。
- 影响面：本轮未调用安装脚本、未重启服务、未读取真实 env 或使用生产 token 发请求。线上保持上轮已验收部署，本轮未另作运行健康检查。没有本轮部署台账行。
- 建议：维护者明确上述最小生命周期修正属于 T2.5 后，继续在当前草稿补集成测试和修复，再跑全套检查及灰度；不要部署当前草稿。
- 部署成功后仍需人工验收（新 codeVersion 待实际构建产生）：三个 bot 各 `/status` 核对新版本、outboxQueued=0、outboxDiscarded=0、truthProfile 不变；一个群 @ bot 发真实消息，确认只有一条状态消息从已收到变化到已完成，正文另发。当前尚未到此步骤。

### T2.5 阻塞裁决（2026-09-23）

**Codex 判断正确，规格遗漏**（这是第三次在规格矛盾处正确停下）。inbox 在 dispatch 返回时出队，
而 dispatch 返回于 turn 启动或入队、非终态；dispatch 还收到副本 —— `ackMessageId` 无处持久化。

**由此推出的更大缺口**：T2.3 的重放只覆盖「已收到、未开始」窗口。turn 执行中被杀时 inbox 已空，
不重放也不提示。findings F5 的 24 个孤儿 turn，T2.3 并未修掉。

**裁决**：
- **不**把 inbox 保留到终态 —— 会重跑执行到一半的 turn，而本 bot 以 danger-full-access 执行有副作用的命令
- inbox 保持现状；新增持久化「进行中任务台账」，终态才出队
- 重启：`queued` 重新入队（安全，未执行过）；`running` 不重跑，原 ack 改为中断提示后出台账
- steer 跟随所属 turn；内部重试沿用同一 requestId 与 ack
- Codex 草稿复核列出的 6 项问题一并在 T2.5 内修掉
- 必须有接入层集成测试；管理器单测全绿不算完成

规格见 `handoff_codex.md`「T2.5 补充：任务生命周期」。当前草稿（`index.js`、`tests/ack.test.js`）在此基础上续做，未提交、未部署。

### T2.5 验收（2026-09-23）—— 通过，线上三项人工验收全部正常

| 检查项 | 结果 |
|---|---|
| running 重启不重跑 | ✅ `recoverActiveRequests()` 对 running 只 `interrupt` + 出台账，不调 `startOrSteerTurn` |
| queued 重启重放 | ✅ 沿用 replayCount ≤ 2，超限发「服务重启次数过多，请重发」 |
| 3 秒节流未被绕过 | ✅ `minEditIntervalMs = 3000`；全仓库无 ack 更新带 `force: true` |
| 接入层集成测试 | ✅ 6 个 integration 测试（生命周期 / running 恢复 / queued 恢复 / 内部重试 / steer / outbox 延迟回填 ackMessageId） |
| 测试 | ✅ **145 / 145 / fail 0** |
| 四份哈希 | ✅ `e5d5ac5285ff`，三份 `DEPLOYED_REF` 均 `04a3c13` |
| 三实例 store | ✅ inbox / outbox / activeRequests 均为 0 |
| 人工①：三 bot `/status` | ✅ `codeVersion=e5d5ac52`、`outboxQueued=0`、`outboxDiscarded=0`、truthProfile 不变 |
| 人工②：群内真实消息 | ✅ 只有一条状态消息，已收到 → 已完成，正文另发 |
| 人工③：rv-prediction 执行中重启 | ✅ 同一条 ack 变为「⚠️ 服务重启，这条任务已中断，请确认后重发」，turn 未被自动重跑 |

**第③项的意义**：这是 findings F5 那 24 个孤儿 turn（执行中被杀、零输出）第一次在线上被真实兜住。
此前只有集成测试覆盖。

### T2.6 验收（2026-09-23）—— 通过

| 检查项 | 结果 |
|---|---|
| 结构化优先 | ✅ 有结构化状态码时只认 500–599；否则才走文本 |
| 文本兜底无裸数字 | ✅ 502/503 须紧跟 `http` / `status` / `error` 等词 |
| 工具调用判定 | ✅ 排除法：只有 agentMessage / reasoning / plan / userMessage 算无副作用，其余（含未知类型）一律视为执行过操作 → 出错偏向「不重试」，安全方向 |
| 重试上限 | ✅ `MAX_UPSTREAM_RETRIES = 2`，退避 3s / 6s |
| 不触发切号 | ✅ `ACCOUNT_FAILOVER_PATTERNS` 未改；上游重试处理排在切号之前 |
| 测试 | ✅ **151 / 151** |
| 四份哈希 | ✅ `fdae9bcf5cfa`，三份 `DEPLOYED_REF` 均 `c7fc195` |
| 自查修正 | ✅ `c7fc195` 为 Codex 部署后自己发现工具调用记录不全、修正并重新部署 |
| §4.4 真实应答 | ✅ 2026-09-23 人工确认三个 bot 均 `codeVersion=fdae9bcf` |

上游 5xx 的重试路径仅有测试覆盖，线上效果待真实故障发生时验证。

### T2.7 验收（2026-09-23）—— 代码检查与灰度部署通过

| 检查项 | 结果 |
|---|---|
| 满载分类 | ✅ 结构化 `codexErrorInfo=server_overloaded` 优先；无结构化字段时仅以 `Selected model is at capacity` 兜底 |
| 切号边界 | ✅ `ACCOUNT_FAILOVER_PATTERNS` 已移除 `/capacity/i`、`/overloaded/i`；`usageLimitExceeded`、429、quota、usage limit、billing 仍保留 |
| 重试安全 | ✅ 复用 T2.6 的 `turnHasToolActivity`；无工具调用同号最多重试 2 次，有工具调用不重试并提示可能已部分执行 |
| 重试用尽 | ✅ ack 改为建议稍后重发或使用 `/model`，不自动换模型、不修改 session model |
| 测试 | ✅ **158 / 158 / fail 0**；新增 `tests/model-overloaded.test.js`，旧代码先失败后通过 |
| 指定检查 | ✅ `node -c`、四项 `zsh -n`、`git diff --check` 全部通过 |
| 四份哈希 | ✅ 工作区与三实例均为 `84ba00725886` |
| 三实例进程 | ✅ LaunchAgent 存活；启动日志均有 `Deployed ref`、`Telegram Codex Bridge started`、`codeVersion=84ba0072` |
| 角色文件 | ✅ rv-prediction 与 strategy-observation 的实例角色文件未被覆盖 |
| curl | ✅ 仅每个 bridge 进程各自一个 `getUpdates` 长轮询子进程，无孤儿残留（输出已脱敏） |

模型满载无法安全人为制造，线上重试与建议换模型的真实路径待维护者遇到实际 `server_overloaded` 故障时观察。

### T2.7 灰度部署台账（2026-09-23）

| 日期 | 目标实例 | 分支 / tag | commit sha | index.js sha256 前 12 | 结果 |
|---|---|---|---|---|---|
| 2026-09-23 | rv-prediction | `feat/phase-2-no-silent-failure` | `7b5045d9db0edda38bd6c8c2ef21e33f9a31e9c3` | `84ba00725886` | ✅ 安装成功，观察一轮通过 |
| 2026-09-23 | default | `feat/phase-2-no-silent-failure` | `7b5045d9db0edda38bd6c8c2ef21e33f9a31e9c3` | `84ba00725886` | ✅ 安装成功，进程与三标记通过 |
| 2026-09-23 | strategy-observation | `feat/phase-2-no-silent-failure` | `7b5045d9db0edda38bd6c8c2ef21e33f9a31e9c3` | `84ba00725886` | ✅ 安装成功，进程与三标记通过 |

维护者部署后人工验收：

1. 三个 bot 各发一次 `/status`，确认 `codeVersion=84ba0072`、`outboxQueued=0`、`outboxDiscarded=0`，且 `truthProfile` 不变。
2. 模型满载无法人为制造；发生真实 `server_overloaded` 时确认同账号最多重试 2 次、不会切号，最终 ack 给出 `/model` 建议。

### T2.7 验收（2026-09-23）—— 通过

| 检查项 | 结果 |
|---|---|
| 切号表 | ✅ 已移除 `/capacity/i`、`/overloaded/i`；429 / quota / usage limit / billing 保留并补 `usageLimitExceeded` |
| 满载判定 | ✅ `classifyServerOverloadedError`：有结构化字段只认 `server_overloaded`，无则看文本 |
| 处理顺序 | ✅ 满载 → 上游 → 认证 → 切号 → 上下文；R5 原问题修复 |
| 复用工具调用判定 | ✅ 复用 T2.6 的 `turnHasToolActivity` |
| 测试 | ✅ **158 / 158** |
| 四份哈希 | ✅ `84ba00725886`，三份 `DEPLOYED_REF` 均 `7b5045d` |
| 清单 | ✅ T2.1–T2.7 全部打勾，无删行 |
| §4.4 真实应答 | ✅ 2026-09-23 人工确认三个 bot 均 `codeVersion=84ba0072` |

### T2.8 验收（2026-09-23）—— 锁迁移与灰度部署通过，等待人工 `/status`

| 检查项 | 结果 |
|---|---|
| 持久锁目录 | ✅ `~/Library/Application Support/telegram-codex-bridge-locks/`，权限 700；旧 `os.tmpdir()` 锁未触碰 |
| 锁身份 | ✅ 锁记录 pid、startedAt、随机 nonce、serviceRoot、indexPath；持有判断校验实际进程命令行，PID 复用不会误占 |
| 陈旧锁测试 | ✅ 无关存活进程视为陈旧并接管；持有者退出后可接管；同实例存活时拒绝并报告 pid/serviceRoot |
| 测试 | ✅ **162 / 162 / fail 0**；新增 `tests/instance-lock.test.js`，旧代码先失败后通过 |
| 指定检查 | ✅ `node -c`、四项 `zsh -n`、`git diff --check` 全部通过 |
| 四份哈希 | ✅ 工作区与三实例均为 `8c9687dfc1d5` |
| 三实例进程 | ✅ LaunchAgent 与 node bridge 进程均存活；启动日志有 `Deployed ref`、`Telegram Codex Bridge started`、`codeVersion=8c9687df` |
| 角色文件 | ✅ rv-prediction 与 strategy-observation 角色文件未覆盖 |
| 锁数量 | ✅ 灰度完成后持久目录正好 3 把锁，分别对应三个 serviceRoot |
| rv 重启 smoke | ✅ rv-prediction 重装/重启后仍成功获取同一锁名，目录无重复锁 |
| curl | ✅ 仅三个 bridge 各自一个 `getUpdates` 长轮询子进程，无孤儿残留（输出已脱敏） |

### T2.8 灰度部署台账（2026-09-23）

| 日期 | 目标实例 | 分支 / tag | commit sha | index.js sha256 前 12 | 结果 |
|---|---|---|---|---|---|
| 2026-09-23 | rv-prediction | `feat/phase-2-no-silent-failure` | `75cbedc265ce63f8e0cfa45cb187d3b772223aa2` | `8c9687dfc1d5` | ✅ 安装、锁创建与重启 smoke 通过 |
| 2026-09-23 | rv-prediction（重启） | `feat/phase-2-no-silent-failure` | `75cbedc265ce63f8e0cfa45cb187d3b772223aa2` | `8c9687dfc1d5` | ✅ 同一锁名重新获取，单锁保持 |
| 2026-09-23 | default | `feat/phase-2-no-silent-failure` | `75cbedc265ce63f8e0cfa45cb187d3b772223aa2` | `8c9687dfc1d5` | ✅ 安装成功，进程与三标记通过 |
| 2026-09-23 | strategy-observation | `feat/phase-2-no-silent-failure` | `75cbedc265ce63f8e0cfa45cb187d3b772223aa2` | `8c9687dfc1d5` | ✅ 安装成功，进程与三标记通过 |

维护者确认后再做 Phase 2 收口。人工验收预期：三个 bot 各发一次 `/status`，确认 `codeVersion=8c9687df`、`outboxQueued=0`、`outboxDiscarded=0`，且 `truthProfile` 与既有基线不变。

### T2.8 验收（2026-09-23）—— 迁移与 PID 复用防护落地，但发现已上线的抢锁缺陷

**核实通过**：锁目录 `~/Library/Application Support/telegram-codex-bridge-locks/` 权限 `drwx------`；
3 把锁，字段含 `pid / nonce / serviceRoot / indexPath / startedAt`，三个 pid 均对应各自 service 的 `index.js` 进程；
**162 / 162**；四份哈希 `8c9687dfc1d5`，三份 `DEPLOYED_REF` 均 `75cbedc`。

**缺陷（已上线）→ T2.8a**：`lockBelongsToThisInstance` 先比较 `existing.serviceRoot === 自己的 serviceRoot`。
抽出函数实跑：同一 service 重复启动 → 正确拒绝；**工作区用同一 token 启动 → 判为陈旧，删掉线上锁并接管**。
工作区 `.env` 与默认实例共用 token（R7），因此在工作区跑一次 `npm start` 即会触发两进程抢轮询。
改动前的 tmpdir 锁反而能拦住此场景 —— T2.8 让 R7 更糟。

**成因主要在规格措辞**：「确认那个进程确实是同一个 bridge 实例」被理解为「与我是同一实例」，
本意是「确实是一个 bridge 进程，而非 PID 被复用」。

**Phase 2 收口推迟**到 T2.8a 部署并经人工 `/status` 确认之后。本轮 `8c9687df` 的 `/status` 不再单独验收。

### T2.8a 热修与灰度部署（2026-09-23）—— 等待人工 `/status`

- 维护者更新的 `handoff_codex.md`、`task_plan.md`、`progress.md` 已先原样单独提交为 `1dd3633`。只改 `index.js` 锁持有判断及新增 `tests/instance-lock.test.js` 回归；`findings.md` 未改。
- 新增跨 serviceRoot 竞争测试先在旧代码失败：工作区竞争者会接管存活服务的锁。修复后只用锁里记录的 `indexPath` 校验持有者命令行，不再比较竞争者的 serviceRoot；无关 PID 与退出持有者仍可接管，同目录重复启动仍拒绝。
- 代码提交 `666dd972513b2d18860375c3c1e6ee0455c1a2d2`；`node -c index.js`、**163/163 tests pass / fail 0**、四项 `zsh -n`、`git diff --check` 通过。
- 灰度严格按 rv-prediction → 观察一轮 → default → strategy-observation。rv-prediction 额外经安装脚本重启一次后成功重新取得锁。四份 `index.js` SHA-256 相同，前 12 位 `be7cce0b8ad6`；三个 `DEPLOYED_REF` 均为代码提交 `666dd97`，启动日志均有 Deployed ref、Bridge started、`codeVersion=be7cce0b`。
- 三个 LaunchAgent 与 node bridge 进程存活；持久锁目录权限 700、正好 3 把锁，锁内 pid 均对应各自 serviceRoot 的 index.js 进程。两个命名角色文件未覆盖；curl 仅三个正常轮询子进程，无孤儿（诊断输出只打印 pid/ppid，未暴露 token）。
- **待维护者人工验收**：三个 bot 各发 `/status`，确认 `codeVersion=be7cce0b`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 不变。Bot API 不能代用户发送，也不能用生产 token 抢 `getUpdates`。确认前保持 Phase 2 `in_progress`，不合并 main、不打 tag、不从 main 重装。

### T2.8a 人工验收与 Phase 2 收口准入（2026-09-23）

- 维护者已在三个 bot 各发 `/status` 并确认：`codeVersion=be7cce0b`、`outboxQueued=0`、`outboxDiscarded=0`，`truthProfile` 均不变。
- Phase 2 清单全部打勾，含 T2.3a、T2.4a、T2.4b、T2.8a；允许按 handoff 执行 main 的 `--no-ff` 合并、`v0.2.0` tag 与 main 灰度重装。

### Phase 2 收口完成（2026-09-23）

- `git merge --no-ff feat/phase-2-no-silent-failure` 在 main 生成提交 `021139200a113d5cf1870246ed6a0c9a70abbd59`；注解 tag `v0.2.0` 由 `git rev-list -n1 v0.2.0` 确认指向同一提交。
- `git show v0.2.0:index.js | shasum -a256`、工作区及三实例 `index.js` 均为 `be7cce0b8ad60ca926e2f19634a4b5886bd55fb9d68e1184a80cef809e78b7fc`。
- 从 main 按 rv-prediction → 观察一轮 → default → strategy-observation 重装三实例；三个 `DEPLOYED_REF` 均为 `commit=021139200a113d5cf1870246ed6a0c9a70abbd59`、`ref=v0.2.0`。三个 LaunchAgent 与 bridge 进程存活、启动日志三标记齐全；角色文件保持专属，3 把锁均对应正确进程，curl 仅有正常轮询子进程。
- 此次重装代码内容与人工验收的 `be7cce0b` 完全相同；未 push。Phase 2 状态为 `complete`，Current Phase 指向 Phase 3，下一项 T3.1。

### Phase 2 收口验收（2026-09-23）—— 通过

- main 上 `v0.2.0` → `0211392`（`rev-list` 核实），tag 内 `index.js` 与三实例同为 `be7cce0b8ad6`
- 三实例 `DEPLOYED_REF` 均为 `commit=0211392 ref=v0.2.0`；163/163；未 push（本地领先 origin/main 51 个提交）
- 仍未经线上真实故障验证的路径：上游 5xx 重试（T2.6）、模型满载（T2.7）

### Phase 3 开始前的根因复核（2026-09-23，基于 v0.2.0）

R3 仍原样存在：`await resolveBotIdentity()`（约 `:5007`）先于 `await startCodexServer()`（约 `:8092`）；
supervisor 仍为 `POLL_INTERVAL=5` × `APP_SERVER_MISS_LIMIT=3` = 15 秒。
Phase 2 让重启「不丢消息、有提示」，但没有让重启循环不再发生。

### T3.1 验收（2026-09-23）—— 通过

| 检查项 | 结果 |
|---|---|
| app-server 创建耗时 | ✅ rv 1854 / default 2275 / strategy 1414 ms（supervisor 底线 15000） |
| 启动 await 审计 | ✅ 有缓存时 getMe 后台；`ensureHealthyStartupAccount()` 在 app-server 之后且后台；outbox flush 为 void。无遗漏阻塞点 |
| 残留风险 | 首次安装无缓存身份时仍等待 getMe → 由 T3.2 启动宽限期兜底 |
| 测试 | ✅ **166 / 166** |
| 四份哈希 | ✅ `1eacb1e58346`，三份 `DEPLOYED_REF` 均 `bfb8c79` |
| §4.4 真实应答 | ✅ 2026-09-23 人工确认三个 bot 均 `codeVersion=1eacb1e5` |

断网启动路径仅测试覆盖，未在线上实际断网验证。

### T3.2 阻塞裁决（2026-09-23）

规格写「翻倍 60 → 120 → 300 封顶」，文字与数值不一致（120 翻倍为 240）。**裁决：固定三级 60 → 120 → 300 秒**，以明确写出的数值为准；「翻倍」为规划方笔误。
Codex 照 §6 停下是合规的。同时在 handoff §6.1.1 增补：文字与完整数值不一致时以数值为准并记录，不必停下。

### T3.2 完成与灰度部署（2026-09-23）

- 裁决已落实：按数值执行 60 → 120 → 300 秒三级宽限期，300 后保持；原“翻倍”为笔误。首次强制重启后下一轮为 120 秒，再次为 300 秒；见到健康 app-server 时立刻清零 miss/连续重启计数并恢复 60 秒。强制重启后仅等待旧进程结束（复用既有有界退出等待），随即启动新进程，不按宽限期停机等待。
- 宽限期跳过、计入 miss、强制重启（连续次数/下一轮宽限期）、健康复位均写时间戳日志；Supervisor ready 增加 start_grace。自定义 START_GRACE_SECONDS 用 1/2/5 比例缩放三级，供短时间行为测试；默认仍是裁决的完整数值。
- 新增 `tests/supervisor-grace.test.js` 四项真实进程测试，逐项观察红灯后实现至绿灯；临时目录 fake index.js 不访问 Telegram，fake-codex 仅提供可识别的子进程。每项有超时、独立进程组并清理整个组；全套检查后复验测试残留进程为 0。
- 检查：`node -c index.js`、`node --test ./tests/*.test.js` **170/170 pass，fail 0**、四项 `zsh -n`、`git diff --check` 全通过。已有测试断言未改。
- 部署严格按 rv-prediction → 观察一轮 → default → strategy-observation；安装脚本已执行 bootout/bootstrap/kickstart。三个 supervisor 的新 ready 时间均晚于各批安装开始时间且带 start_grace=60；LaunchAgent/supervisor/bridge/app-server 父子关系均核实，确认常驻循环已换新。appServerSpawnedMs：rv **1517**、default **2412**、strategy **1497**，均远小于 15000。
- 工作区和三实例的两种文件分别哈希一致：index.js `1eacb1e58346`，supervisor `2257af0ad696`；DEPLOYED_REF 均指向 `6f7c70135bea2efaff833625f5fb5fbd33e41fc6`。命名角色文件哈希与各自源文件一致；3 把锁的 pid/indexPath 对应各自 service 进程；最终 curl 仅三条正常 getUpdates 子进程，没有孤儿。诊断先脱敏，未输出 token。
- 本轮修改：`scripts/codex-launch-supervisor.sh`、新增 `tests/supervisor-grace.test.js`、`.env.example` 的 supervisor 参数注释、`progress.md`、`task_plan.md`。维护者的契约修訂单独提交为 `a3e41b7`。没有修改 index.js、findings.md 或真实 env，也未推进 T3.3/T3.5；未 push。
- **待维护者人工验收**：三个 bot 各发一次 `/status`，预期 `codeVersion=1eacb1e5`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 不变。本轮只改 supervisor，codeVersion 由 index.js 哈希计算，因此保持 T3.1 的值；新部署身份由 DEPLOYED_REF 与 supervisor 哈希/ready 日志共同确认。三级重启行为已有假进程测试覆盖，未在线上主动制造连续强杀。

### T3.2 验收（2026-09-23）—— 通过

| 检查项 | 结果 |
|---|---|
| 宽限期序列 | ✅ 60 → 120（×2）→ 300（×5）封顶，健康即复位 |
| 时间模块 | ✅ 脚本第 3 行 `zmodload zsh/datetime`，`EPOCHREALTIME` 有值（未加载时为空，会使宽限期判断永远成立、永不强杀） |
| supervisor 已换新 | ✅ 三实例 `Supervisor ready` 时间 17:20:41 / 17:21:42 / 17:22:18，均带 `start_grace=60` |
| 两个文件四份哈希 | ✅ `index.js` `1eacb1e583`；supervisor 脚本 `2257af0ad6` |
| 测试 | ✅ **170 / 170** |
| §4.4 真实应答 | ✅ 2026-09-23 人工确认，`codeVersion=1eacb1e5`（本轮未改 index.js） |

R3 死循环至此两端均已处理：bridge 侧启动不再被 getMe 阻塞（T3.1），supervisor 侧给出 60/120/300 秒宽限（T3.2）。

### T3.3 完成与灰度部署（2026-09-23）

- 维护者三份规划文件先原样提交为 `d36b4d8`；实现提交为 `32d12021739efd67539697a8b0a8bdadd53e1030`。改动文件：`index.js`、新增 `tests/polling-health.test.js`、`progress.md`、`task_plan.md`；findings.md 与 supervisor 未改。
- pollingLoop 不再按 180 秒/6 次错误请求进程退出。`requestSupervisorRestart` 的唯一调用方就是该分支，移除后其他调用方为 **0**，因此函数、restartRequested 私有标志和两个旧阈值一并删除。现有 restartReason 的清理代码保留原样，供 T3.4 后续处理。
- 按最近成功轮询计算失联时长，30 秒进入 degraded，90 秒进入 unreachable；只在状态变化时打印含 ts/errorClass/telegramState 的日志。进入失联状态时强制保存 offlineSince，恢复时强制保存 lastOutage（startedAt/endedAt/durationMs）、清空 offlineSince 并记一条恢复日志。重试间隔为 2/4/8/16/30/30 秒，成功清零错误计数后复位；Clash maybeRecover 的调用与原条件均未改。尚未实现恢复播报。
- 新增 6 项测试：直接执行生产 pollingLoop/健康函数的隔离 VM，使用假时钟和假 Telegram，真实临时 Store 验证落盘与重载。旧代码的 >180 秒、>6 次失败测试先触发重启而失败；修复后持续到成功。覆盖 30/90 秒边界与日志去重、恢复时长与单次恢复日志、退避复位、跨重启失联起点保留、实际 /status 字段表达式。
- 检查全部通过：`node -c index.js`，**176/176 pass / fail 0**，四项 `zsh -n`，`git diff --check`。既有测试断言未改。
- 灰度按 rv-prediction → 观察一轮 → default → strategy-observation 完成。各批安装后新 Supervisor ready 均带 start_grace=60，Deployed ref/Bridge started/codeVersion 三标记齐全；appServerSpawnedMs 为 **1175 / 1955 / 1011**。工作区与三实例 index.js 全部 `5334599a2dad`，supervisor 全部 `2257af0ad696`；DEPLOYED_REF 全部指向 `32d1202`。三个 bridge 与其 supervisor/app-server 父子关系正确，3 把锁对应各自 PID/indexPath，两个命名角色哈希与源文件匹配；最终只有三个正常 getUpdates curl 子进程，无孤儿。诊断输出先脱敏。
- 三实例本地 store 已见部署后的成功轮询时间，telegramState=ok、offlineSince=0，outboxQueued/outboxDiscarded 均为 0；这不是人工 /status 应答验收的替代。**请维护者对三个 bot 各发一次 /status**，确认 `codeVersion=5334599a`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 不变，并且 `telegramState=ok`。
- 真实断网验证留待下一次网络故障，未主动中断生产网络。T3.3 已勾选，Next Step 指向 T3.4，所有任务行保留；未 push。

### T3.3 验收（2026-09-23）—— 通过

| 检查项 | 结果 |
|---|---|
| 不再自杀 | ✅ pollingLoop 无 `process.exit`；`requestSupervisorRestart` 函数已整体删除，全仓库无调用方 |
| 状态划分 | ✅ `offlineMs >= 90_000` → unreachable，`>= 30_000` → degraded |
| 退避 | ✅ `min(30s, 2s × 2^min(n−1,4))` → 2/4/8/16/30 |
| Clash 切换 | ✅ `maybeRecover` 原样保留 |
| 测试 | ✅ **176 / 176** |
| 四份哈希 | ✅ `5334599a2d` |
| §4.4 真实应答 | ✅ 2026-09-23 人工确认 `codeVersion=5334599a`、`telegramState=ok` |

**连带影响**：`requestSupervisorRestart` 删除后 `restartReason` 永不再写入，T3.4 原规格「读回 restartReason」失去意义，
T3.4 已改为基于 `offlineSince` / `lastOutage`（网络失联）与 `lastPollSuccessAt` / 关机记录（进程停机）两类数据源。
真实断网验证待下一次网络故障。


### T3.4 实现与检查（2026-09-23）

- 维护者规划更新原样提交 `4279e79`；只修改 index.js、新增 tests/recovery-notice.test.js 和本轮进度/计划文档。findings.md、supervisor、T3.3 的状态阈值/退避/Clash 条件、restartReason 残留行为保持原样。
- 网络恢复在成功轮询清空错误前保存最后错误快照，复用 T3.3 生成的 lastOutage；进程启动首次轮询按启动前持久化 lastPollSuccessAt 计算。SIGTERM/SIGINT 保存 lastShutdown（at/signal/graceful），首次成功轮询消费后清除；缺失或早于上次成功轮询视为异常退出/强杀。
- ≥120 秒才告知。仅给 allowlist 正数私聊发送一条 notice 优先级 outbox 汇总，含 bot 名、时长、中文原因、ISO 起止时间（UTC）。N 为恢复首个成功 getUpdates 批次中、allowlist 内且 date 落在失联区间的 message 数；后续批次仍会按 date 给受影响 ack 加注，但不另发或修改汇总。群聊不广播。
- date 与 recoveryNote 跟随 inbox、activeRequests 持久化，ack 初次发送和后续编辑均保留注记，沿用原 3 秒节流。汇总准备记录、确定性的 outbox requestId 与完成入队记录防止重启后重复排队；实际发送成功后写 lastOutageNotifiedAt 及该 outbox 条目的已送达标记；若随后在出队前退出，重启后只清理条目、不再次发送（新增测试先失败后修复）。部分私聊入队后保存失败，也可从准备记录继续，测试覆盖已送达收件人不重复。
- 测试红阶段：首项因缺少恢复管理器失败；接入三项分别因 date 丢失、关机记录缺失、生产 pollingLoop 未调用汇总失败。之后新增边界、错误映射、部分入队恢复测试；全套 188/188，旧测试文件与断言均未修改。检查：node -c index.js；node --test ./tests/*.test.js；四项 zsh -n；git diff --check。
- 灰度与人工验收记录待部署后补齐。网络类 A 的真实验证留待下一次网络故障；不主动断生产网络。


### T3.4 灰度部署与待人工验收（2026-09-23）

- 实现提交 `8043a591792a8127c85509893b886536f688cac5`。先 rv-prediction，观察约一轮成功轮询（PID 76735 未变，lastPollSuccessAt 从 1790159191612 推进到 1790159249564），再 default、strategy-observation。三个安装命令均成功；代码在 feat/phase-3-restart-loop，未 push。
- 四份 index.js SHA-256：`8fea81fe48e733e6d89532ea94faed00bee617ea17f7b8dda61acc09974d21e5`，codeVersion=`8fea81fe`。四份 supervisor SHA-256：`2257af0ad696d0690572737e0875d5d326339fcb4acacb1a0c7e9959f7d41ee2`。
- 本次 Supervisor ready 分别为 **18:26:46 / 18:27:48 / 18:28:14（UTC+8）**，均含 start_grace=60；Deployed ref 指向上述提交，Bridge started/codeVersion 齐全，appServerSpawnedMs 为 **1000 / 1704 / 1078**。三个 bridge 的 supervisor 父进程与 app-server 子进程正常；3 把锁对应各自 PID/indexPath，命名实例角色文件与源文件哈希相同。最终只有三个正常 getUpdates curl 子进程，无残留孤儿或测试进程，诊断先脱敏。
- 最终三实例 lastPollSuccessAt 均晚于本次启动；本地 store 显示 telegramState=ok、offlineSince=0、outboxQueued=0、outboxDiscarded=0。lastShutdown 已消费清除，恢复汇总队列为空；对照部署前快照，lastOutageNotifiedAt/lastRecoveryNotice 未变化（均未设置），本次启动日志没有 telegram_recovery_notice_queued。由此确认本次短部署没有生成或发送恢复汇总。这不替代真实聊天验收。
- 已逐项核对 Phase 1/2 完成项与 T3.1–T3.4 均勾选、T3.5/T3.6 未勾选，全部任务行和顺序保留；Next Step 指向 T3.5。

**人工验收 1：三个 bot 各发 `/status`**

确认 `codeVersion=8fea81fe`、`telegramState=ok`、`outboxQueued=0`、`outboxDiscarded=0`，`truthProfile` 与上次验收一致。这里只核对了本地 store/日志，未代替维护者发消息或调用 getUpdates。

**人工验收 2：维护者在 wukong 演练进程停机 B 类**

```sh
launchctl bootout gui/$(id -u)/com.sharenla.telegram-codex-bridge.rv-prediction
# 等约 3 分钟；期间可给 @Codex_RV_bot 私聊发一条消息。
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sharenla.telegram-codex-bridge.rv-prediction.plist
```

预期：allowlist 私聊收到一条 rv-prediction 的失联汇总，时长约 3 分钟，原因为「服务进程停止运行（正常关闭）」；停机期间那条消息的原 ack 带「服务刚恢复，这条消息在 X 分钟前发出」，之后编辑仍在同一条 ack 上；群聊不收到独立汇总。该演练未由 Codex 执行。A 类网络恢复等待下一次真实断网。

剩余边界：Telegram 已接收发送请求、但成功响应或本地送达标记尚未落盘就崩溃时，沿用既有 outbox 的至少一次投递语义，仍可能重复；送达标记已落盘后的重启已覆盖去重测试，不扩大为全局 exactly-once 协议。汇总中的 N 仅为首个恢复批次，后续批次受影响消息仍有 ack 注记。

### T3.4 线上验收 + 意外的真实断网实战（2026-09-23 20:29–20:55）

维护者 20:33 按计划停掉 rv-prediction 做 3 分钟停机演练，但 wukong 到 Telegram 的网络在 **20:29 已经真实中断**
（经代理 `127.0.0.1:1082` 与直连均 `SSL_ERROR_SYSCALL`），于 **20:55 恢复**。演练因此同时覆盖了 A 类（网络）与 B 类（进程停机）。

**生效的部分（T3.3 / T3.4 首次真实验证）**：
| 实例 | 失联区间 | 时长 | 汇总 |
|---|---|---|---|
| rv-prediction | 20:29:30 – 20:55:31 | 26m00s | ✅ 20:55:31 入队并送达（outbox 清零） |
| default | 20:29:29 – 20:55:20 | 25m51s | ✅ 20:55:20 |
| strategy-observation | 20:29:26 – 20:55:22 | 25m56s | ✅ 20:55:22 |
- 26 分钟内无一次自杀、无重启循环（按历史中位数 183s，改造前约自杀 8 次）；rv 重启后 app-server 1113ms 起来
- 状态日志：degraded（20:30:33）→ unreachable（20:31:26）→ telegram_recovered，各一行
- 停机期间发出的消息被补收，ack 附「（服务刚恢复，这条消息在 22 分钟前发出）」✅

**暴露的问题**：
1. **【零输出】认证恢复耗尽后请求永不收尾** —— 请求 `#023b89` 在 20:55:53 最后一次 turn 以
   `refresh token was revoked` 失败后，无任何消息，ack 停在「⚙️ 正在处理」，activeRequests 中保持 `running`（22:23 仍如此）。
   认证恢复（Phase 1 前既有逻辑）接管请求并排队「恢复后重跑」，但全部账号恢复失败时无人将其置为终态 → **T3.4b**
2. **【运维，需维护者】** strategy-observation 与 rv-prediction 的 Codex 账号 refresh token 已被吊销，
   app-server 持续 `Failed to refresh token`（近 400 行分别 115 / 160 条）；default 走 codex-lb 不受影响。
   同时两实例 `codexBackend.state` 仍显示 `ok`、`lastRecoveryResult=success:*` —— **健康状态与事实不符** → 并入 T3.4b
3. **汇总原因选错** —— rv 汇总写「服务进程停止运行（正常关闭）」，但网络 20:29 先断、进程 20:33 才停（停机仅占 8/26 分钟）。
   应取**最早发生**的原因；时间显示为 UTC ISO（`2026-09-23T12:29:30.635Z`），应为本地时间 → **T3.4a**
4. **消息太吵 / 上下文丢失** —— 一条请求额外刷出 6 条：认证恢复提示 ×2、`Started new thread: <id>` ×3（英文、暴露内部 id）、
   thread 失效提示 ×1。均为 Phase 1 前既有通知，绕过 T2.5 ack 直发。连续新建 3 个 thread 意味着对话上下文丢失 → **T4.4 扩展**（见 task_plan）
5. **Clash 节点自动切换失效** —— `connect ENOENT .../verge-mihomo.sock`，控制 socket 不在代码探测的路径上，本次断网自动换节点未生效 → **T3.7**


### T3.4b / T3.4a 实现与检查（2026-09-23）

- 三份维护者规划文件先原样单独提交为 `4eef88f`。仅修改 index.js，新增 tests/auth-terminal.test.js 与 tests/recovery-local-time.test.js，更新进度/计划；findings.md、supervisor、真实 env 与凭证文件未改，未在工作区启动 bridge。
- T3.4b：turn/completed 认证失败、stderr 看门狗捕获任务、恢复后同步 turn/start 失败共用终态收尾，清理该请求的自动重跑/排队任务、更新原 ack 并移除 activeRequests；认证已重跑一次或 turnHasToolActivity 为真时不再自动重跑。保留 ack/acks 穿过认证恢复任务及新 turn（含同一 turn 的追加请求），成功恢复后再次认证失败也逐条收尾；持续 stderr 认证错误独立更新健康状态，不受一次性看门狗限制。
- 近 5 分钟未被成功 turn 解除的认证错误及未解决的认证故障显示 auth_failing；初始化/切号健康检查不会覆盖，有成功 turn 才解除并开始新故障周期。codex-lb 既有“忽略本地登录刷新噪声”规则保留。失败汇总仅给 allowlist 正数私聊，notice outbox 与收件人去重记录原子保存，跨重启不重复入队，同故障不重复通知。
- 测试进一步复现并修复两个同源边界：无 401 前缀的 refresh token was revoked 未匹配；认证重跑在 turn/start 再失败会进入自己的恢复 promise（有自等待风险）。既有生命周期通知文字不做中文化/合并，留给 T4.4。
- T3.4a：启动前已持久化 offlineSince 早于 lastShutdown.at（或没有关闭记录）时保留网络原因为主，并补“期间服务进程也曾重启”；否则按进程停机。汇总显示系统本地 HH:MM:SS，跨本地日增加 MM-DD，保留秒，不再输出 ISO/UTC 时间串。
- 12 项新增测试先复现失败再实现，覆盖实际认证函数与假 stderr 入口；全套 **200/200 pass、fail 0**。node -c、四项 zsh -n、git diff --check 通过。已有测试文件/断言未改；没有真实账号切换/凭证探测。
- 部署前只读核实：rv 的 activeRequests 为 #023b89 / running / ackMessageId=27；rv 与 strategy 后台都仍标记 ok，但 stderr 最近 400 行分别有 176 / 118 行认证失败，default 为 0。符合本轮修复前的现象。部署后应由 T2.5 自然中断和清台账，不手改 store。
- 代码检查完成，部署与人工验收台账待下方补齐。


### T3.4b / T3.4a 灰度部署与待人工验收（2026-09-23）

- 实现提交 `adbcca86c372b3b1d386acaaf1b97d2e6788be57`；灰度顺序 rv-prediction → 观察（超过一轮成功轮询，额外覆盖历史约 4.5 分钟认证刷新周期）→ default → strategy-observation。未 push。
- 四份 index.js 完整 SHA-256：`4e0985bd0bb32e877ed523f2c0d2bb5721b7f62d00f1a2326790a0a164f12507`，codeVersion=`4e0985bd`；四份 supervisor 仍为 `2257af0ad696d0690572737e0875d5d326339fcb4acacb1a0c7e9959f7d41ee2`。
- 三实例本次 Supervisor ready 时间（UTC+8）为 **22:57:06 / 23:02:23 / 23:03:04**，均带 start_grace=60；Deployed ref/Bridge started/codeVersion 齐全，appServerSpawnedMs 为 **5504 / 7707 / 2811**。rv 启动期间观察到一次宽限期 skip，之后正常；未改 supervisor。
- 三个 bridge、supervisor 父进程和 app-server 子进程均存活；两个命名角色文件与源哈希匹配；3 把锁的 pid/indexPath 对应正确。最终新进程均有成功轮询，telegramState=ok、offlineSince=0，outboxQueued=0、outboxDiscarded=0。一次检查遇到短暂非 bridge curl，随后自行结束；最终只剩三条由各自 bridge 持有的正常 getUpdates curl，无残留/测试进程，未执行额外 kill。全部诊断输出先脱敏。
- rv 部署前 activeRequests 含 `#023b89`、running、ackMessageId=27，部署后为空，未手工改 store。按现有 T2.5 恢复流程会编辑原 ack 为中断并移除台账，本次未见 telegram_ack_edit_failed。**台账清空已直接验证；Telegram 客户端中原消息 27 是否显示中断仍请维护者目视确认**，不把本地无错误当作已读回 Telegram 消息。
- backend 实测：**strategy-observation=auth_failing**（新 lastAuthFailureAt=`1790175798101`、authFailureUnresolved=true），default=ok；rv=ok，但没有部署后成功 turn 或重新登录证据，且启动后没有新的认证错误。rv 的 auth_failing 额外验收尚未证实，见 Error Log。没有主动制造认证错误或操作任何凭证。
- 两任务的代码/检查/部署项已打勾，所有原有任务行与顺序保留，Next Step 指向 T3.5；人工验收尚未完成。

**请维护者对三个 bot 各发 `/status`，逐实例记录：**

| 实例 | 应核对共同字段 | codexBackend 状态记录 |
|---|---|---|
| rv-prediction | codeVersion=4e0985bd、telegramState=ok、outboxQueued=0、outboxDiscarded=0、truthProfile 不变 | 当前本地 ok；请确认是否已重新登录，并记录真实 /status，不能据此认定账号可用 |
| default | 同上 | 当前本地 ok；记录真实 /status |
| strategy-observation | 同上 | 当前本地 auth_failing；重新登录且成功 turn 后应复位 ok |

另请核对 rv 原 #023b89 的 ack 已变为「服务重启，这条任务已中断」。后续若认证失败再次发生，应在一次安全重跑耗尽后显示「Codex 账号登录已失效，需要维护者重新登录」并清台账；已有工具调用则提示「可能已部分执行」。本轮未代替用户发真实任务。

剩余边界：凭证失效仍需要维护者处理；rv 额外健康状态观察未满足预期，待人工确认。汇总投递仍沿用现有 outbox 的至少一次语义（发送成功但回执未持久化时可能重复）；本轮去重防的是同一故障反复入队。旧认证恢复/新 thread/失效 thread 通知的冗余与英文保留给 T4.4。

### T3.4a / T3.4b 人工验收（2026-09-23）—— 通过

| 项 | 结果 |
|---|---|
| 三 bot `/status` | ✅ `codeVersion=4e0985bd`、telegramState=ok、outbox 两项 0、truthProfile 不变 |
| rv 原 `#023b89` ack | ✅ 维护者确认已变为「服务重启，这条任务已中断」 |
| rv backend=ok | ✅ 属实：rv 启动时账号健康检查已切到仍有效的账号 `33d1df3f…`，重启后无认证错误。原 Error Log 中「rv 未证实」一项关闭 |
| OBS 失效 → 恢复全流程 | ✅ `auth_failing`（ae4ed98c…，每约 4.5 分钟一次 refresh 失败）→ 维护者用 `/accounts` 切到 `33d1df3f…`（23:21:47 验证成功，此后不再报错）→ 跑通一个任务 → `/status` 复位 `ok` |

**发现（→ T3.4c）**：复位条件只认「turn 成功」，切号时 bridge 已实际验证新账号可用（`lastOkAt` 23:21:47），
但 `authFailureUnresolved` 未清，状态仍显示 `auth_failing` 直到下一个 turn 成功。切号验证成功应同样视为恢复。

**遗留（不在本计划范围，交维护者择机处理）**：账号池 `~/.openclaw/agents/main/agent/auth-profiles.json`
（OpenClaw 与 bridge 共用）中 `ae4ed98c…`、`28a48728…` 的 refresh token 已吊销，需在 wukong 本机终端
`openclaw models auth login --provider openai-codex` 重新登录（OAuth 需本人在浏览器操作）；
OpenClaw 自身配置 `~/.openclaw/openclaw.json` 当前有 9 项无法识别的配置键，登录命令可能受影响，建议单独立项。


### T3.4c / T3.5 实现检查与灰度阻塞（2026-09-23）

- T3.4c 单独提交 `5598e40`；T3.5 单独提交 `657df60`。工作树代码提交保持分开，findings.md 未改。
- T3.4c 与 T3.5 新测试均先在旧代码失败；实现后全套 **204/204 pass、fail 0**。`node -c index.js`、四项 `zsh -n`、`git diff --check` 通过。
- T3.5 supervisor 逻辑：读取本实例 `.env` 的 token/allowlist（只读），只向正数 chat id 发送；告警文件保存 alertedAt/failureCount/active，30 分钟内跨 supervisor 重启不重复；恢复通知成功后 active=false 但保留最后发送时间；最新 stderr 行先去 token 与 URL 查询串再截断 120 字；curl URL 通过 stdin config，参数不含 token，发送失败只记录一行。
- rv-prediction 已安装提交 `657df607`（index.js 哈希待完整日志核对）；新 Supervisor ready/Bridge startup 已出现。安装后脱敏计数显示 3 个现有 bridge getUpdates curl 的 argv 含 token；这些是 bridge 既有 T4.8 缺陷，不是 supervisor 新 curl。按硬约束暂停 default/strategy，未伪造“任何 curl argv 无 token”通过。
- **阻塞**：T3.5 部署门禁要求任何 curl argv 无 token；handoff 又明确 T4.8 才改 `TelegramApi.callOnce()` 为 stdin config，并要求本轮范围不改 bridge 汇总/发送逻辑。已写入 Error Log，等待维护者裁决后再继续灰度或单独开 T4.8。

### T3.5 部署门禁裁决（2026-09-23）

门禁「任何 curl 命令行都不含 token」范围写错：bridge 自身的 getUpdates curl 本就含 token（既有问题，归 T4.8）。
**裁决：门禁只针对 supervisor 发起的 curl；T4.8 保持原位，不提前。** Codex 按 §6 停下合规。rv-prediction 已先行部署新版本，继续 default、strategy-observation。

### T3.4c / T3.5 灰度部署完成（2026-09-24）

- 维护者更正后的 T3.5 门禁原样提交为 `0695eba5071d5640db4a1383145480dc1b04c5c6`。rv-prediction 按修正范围复核通过：父进程为该实例 supervisor 的 curl 数量 **0**，其中 token 匹配 **0**；bridge curl 仅报告数量 **1**，未输出命令行。
- 随后按 `rv-prediction → 观察一轮 → default → strategy-observation` 完成安装。三实例 index.js SHA-256 前 12 为 `29cd2ee8711a`，supervisor SHA-256 前 12 为 `7a7878924997`；三实例进程均存活，启动日志均含 `Supervisor ready`、`Deployed ref`、`Bridge started`、`codeVersion`，且 `start_grace=60`。`appServerSpawnedMs`：rv-prediction **1941**、default **5773**、strategy-observation **3321**。
- 本轮 Supervisor ready 时间（UTC+8）：rv-prediction **2026-09-23 23:42:17**，default **2026-09-24 00:02:07**，strategy-observation **2026-09-24 00:03:23**。父进程为各自 supervisor 的 curl 数量分别为 **0 / 0 / 0**，token 匹配均为 **0**；bridge curl 数量分别为 **1 / 1 / 1**，仅计数不打印命令行。3 把锁均存在，pid 与各自 `index.js` 命令行匹配；无残留测试进程。
- 三个实例的 `DEPLOYED_REF` 已指向本轮代码（rv 保留先行部署的 `657df60`，default/strategy 指向仅含规划文档提交的 `0695eba`；运行代码哈希一致）。未修改真实 `.env`、凭证、service/store 文件，未 push。

**部署台账追加：**

| 日期 | 目标实例 | 分支 / tag | commit sha | index.js sha256 前 12 | 结果 |
|---|---|---|---|---|---|
| 2026-09-23 23:42 (UTC+8) | rv-prediction | `feat/phase-3-restart-loop` | `657df6003caa5ae920dea81980d0c8c3160b8457` | `29cd2ee8711a` | ✅ 修正门禁复核通过，Supervisor ready / 进程 / 锁正常 |
| 2026-09-24 00:02 (UTC+8) | default | `feat/phase-3-restart-loop` | `0695eba5071d5640db4a1383145480dc1b04c5c6` | `29cd2ee8711a` | ✅ 灰度部署与观察通过 |
| 2026-09-24 00:03 (UTC+8) | strategy-observation | `feat/phase-3-restart-loop` | `0695eba5071d5640db4a1383145480dc1b04c5c6` | `29cd2ee8711a` | ✅ 灰度部署与观察通过 |

**人工验收：请维护者对三个 bot 各发一次 `/status`，逐项记录：**

| 实例 | 预期核对项 | codexBackend |
|---|---|---|
| rv-prediction | `codeVersion=29cd2ee8`、`telegramState=ok`、`outboxQueued=0`、`outboxDiscarded=0`、`truthProfile` 不变 | 待维护者确认 `ok` |
| default | 同上 | 待维护者确认 `ok` |
| strategy-observation | 同上 | 待维护者确认 `ok` |

T3.5 告警路径未在线上主动制造，已由新增 supervisor 假 curl 测试覆盖；T4.8 的 bridge 自身 curl token 命令行问题保持原位。

### T3.6 / T3.7 实现、检查与灰度部署（2026-09-24）

- 维护者规划文件原样提交为 `81278ce`。T3.6 分开提交：`e961e52`（结构化 409 归类、冲突窗口/限频/私聊通知）与 `42743f0`（健康轮询后按 10 分钟无新 409 恢复）；T3.7 分开提交：`69d7ac6`（运行时 Clash 配置优先、后台 `/version` 可达性探测、状态展示与不可用时单次跳过日志）。findings.md、真实 `.env`、凭证和 Clash 配置未改。
- 新增测试均先在旧代码上失败后修复；全套 **211 / 211 pass、fail 0**。`node -c index.js`、四项 `zsh -n`、`git diff --check` 全部通过。
- T3.6：只认结构化 `error.body.error_code === 409`，记录 `telegram_poll_conflict`；5 分钟内达到 3 次进入 `conflict`，通知只发 allowlist 正数私聊且 30 分钟限频；10 分钟无新 409 后恢复，不退出进程。
- T3.7：控制器候选优先读取运行时 `config.yaml`，支持 TCP / unix socket；后台 `/version` 使用 Node HTTP、3 秒超时；secret 不进入日志、状态文本或进程命令行；不可用时自动换节点跳过并只记录一次。

**T3.6 / T3.7 灰度部署台账：**

| 日期 | 目标实例 | 分支 / tag | commit sha | index.js sha256 前 12 | supervisor sha256 前 12 | 结果 |
|---|---|---|---|---|---|---|
| 2026-09-24 01:09 (UTC+8) | rv-prediction | `feat/phase-3-restart-loop` | `69d7ac68b82ba65affae0c6d4523a6a7841f6c52` | `15f553e60ccb` | `7a7878924997` | ✅ 观察通过；`appServerSpawnedMs=1296` |
| 2026-09-24 01:10 (UTC+8) | default | `feat/phase-3-restart-loop` | `69d7ac68b82ba65affae0c6d4523a6a7841f6c52` | `15f553e60ccb` | `7a7878924997` | ✅ 观察通过；`appServerSpawnedMs=1857` |
| 2026-09-24 01:11 (UTC+8) | strategy-observation | `feat/phase-3-restart-loop` | `69d7ac68b82ba65affae0c6d4523a6a7841f6c52` | `15f553e60ccb` | `7a7878924997` | ✅ 观察通过；`appServerSpawnedMs=1168` |

三实例本地 store 当前均为 `telegramState=ok`、`clashFailover: unavailable（找不到 Clash 控制器）`，`outboxQueued=0`、`outboxDiscarded=0`；Supervisor ready 均含 `start_grace=60`，3 把锁的 pid 与对应 service 的 `index.js` 命令行匹配。supervisor 发起 curl 数量为 **0 / 0 / 0** 且 token 匹配为 **0 / 0 / 0**；bridge curl 只报告数量，未打印命令行。

**人工验收待维护者确认：**

请对三个 bot 各发一次 `/status`，记录 `codeVersion=15f553e6`、`telegramState=ok`、`outboxQueued=0`、`outboxDiscarded=0`、`codexBackend=ok`、`truthProfile` 不变，并核对 `clashFailover: unavailable（找不到 Clash 控制器）`。维护者确认前，T3.6/T3.7 任务行保持未勾选，不进入 Phase 3 收口。

### T3.6 / T3.7 人工验收（2026-09-24）—— 通过

维护者确认三个 bot 的 `/status`：`codeVersion=15f553e6`、`telegramState=ok`、`outboxQueued=0`、`outboxDiscarded=0`、`codexBackend=ok`、`clashFailover=unavailable（找不到 Clash 控制器）`，`truthProfile` 不变。Phase 3 全部任务已核对完成。

### Phase 3 收口准备（2026-09-24）

- T3.6/T3.7 已在 `feat/phase-3-restart-loop` 完成人工验收；task_plan 的 Phase 3 状态改为 `complete`，Current Phase 改为 Phase 4，Next Step 指向 T4.1。
- 下一步按 handoff 执行：合并 `main`、创建 `v0.3.0`、用 tag 指向 commit 核对两份运行文件哈希，再从 main 灰度重装三实例。未 push。

### Phase 3 收口完成（2026-09-24）

- `feat/phase-3-restart-loop` 已以 `--no-ff` 合并到 `main`，合并 commit：`13118847b577a51fa935d4f464430fd28f21f83c`。
- 已创建 annotated tag `v0.3.0`（`Phase 3: restart loop and outage visibility`）。`git rev-list -n1 v0.3.0` 指向上述 commit；tag 内 index.js SHA-256 为 `15f553e60ccb4d8f342058f51ffafd8ff90bf2348a608747a3c2dbcc591ed069`，supervisor SHA-256 为 `7a787892499762daf01b9d78a572bdc7ac3c65ce3273572cd44ca3e5f54843ff`。
- 从 `main` 按 `rv-prediction → 观察一轮 → default → strategy-observation` 重装完成。三实例 `DEPLOYED_REF` 均为 `v0.3.0`，运行哈希与 tag 一致；`appServerSpawnedMs` 分别为 **1323 / 2117 / 1326**，Supervisor ready 均含 `start_grace=60`，三把锁均由对应实例持有。
- 三实例收口后本地健康核对：`telegramState=ok`、`outboxQueued=0`、`outboxDiscarded=0`、`clashFailover=unavailable（找不到 Clash 控制器）`；supervisor 发起 curl 数量为 **0 / 0 / 0**，token 匹配为 **0 / 0 / 0**；bridge curl 只报告数量，未打印命令行。

**Phase 3 收口部署台账：**

| 日期 | 目标实例 | 分支 / tag | commit sha | index.js sha256 前 12 | 结果 |
|---|---|---|---|---|---|
| 2026-09-24 09:42 (UTC+8) | rv-prediction | `v0.3.0` | `13118847b577a51fa935d4f464430fd28f21f83c` | `15f553e60ccb` | ✅ main/tag 重装，进程与锁正常 |
| 2026-09-24 09:43 (UTC+8) | default | `v0.3.0` | `13118847b577a51fa935d4f464430fd28f21f83c` | `15f553e60ccb` | ✅ main/tag 重装，进程与锁正常 |
| 2026-09-24 09:43 (UTC+8) | strategy-observation | `v0.3.0` | `13118847b577a51fa935d4f464430fd28f21f83c` | `15f553e60ccb` | ✅ main/tag 重装，进程与锁正常 |
| 2026-09-24 | tag | `v0.3.0` | `13118847b577a51fa935d4f464430fd28f21f83c` | `15f553e60ccb` | ✅ Phase 3 收口 tag；未 push |

### T3.4c / T3.5 验收（2026-09-23）—— 通过

- 四份哈希一致：`index.js` `29cd2ee871`、supervisor `7a78789249`；**204 / 204**
- supervisor 发起的 curl 数量为 0、含 token 数为 0（门禁已按更正后的范围执行）
- §4.4：维护者确认三个 bot `codeVersion=29cd2ee8`、telegramState=ok、outbox 两项 0、codexBackend=ok、truthProfile 不变
- supervisor 告警路径线上无法安全制造，仅测试覆盖

### T3.7 现状勘查（2026-09-23）

Clash Verge 有两份配置，bridge 读错了：
| 文件 | 控制器 | 实测 |
|---|---|---|
| `…/clash-verge-rev/clash-verge.yaml`（Verge 应用设置，`CLASH_CONFIG_CANDIDATES` 第一项） | unix `/var/folders/…/verge-mihomo.sock` | ❌ 文件不存在 |
| `…/clash-verge-rev/config.yaml`（运行时内核配置） | unix `/tmp/verge/verge-mihomo.sock`；TCP `127.0.0.1:9097` | ❌ `/tmp/verge/` 为空；9097 无监听，连接被拒 |

Clash Verge 以**服务模式**运行（内核在 `/Library/Application Support/clash-verge-service/`，root 身份），控制器未对当前用户开放。
**结论：本机当前不存在 bridge 可访问的 Clash 控制器，自动换节点功能很可能自改用服务模式起就一直未生效。**
代码侧能做的是：正确探测、启动时实测可达性、不可用时如实展示；真正启用需维护者在 Clash Verge 中打开外部控制器（可选）。

### T3.6 现状勘查（2026-09-23）

代码中无 Telegram 409 专门处理（`Conflict` 命中的均为无关的 workspace 冲突逻辑）。
T2.8a 后本机已不可能出现同 token 第二进程；T2.2 后重启也不再留孤儿长轮询。**此后再出现 409，基本可判定为其他机器上有进程在用同一 bot token。**

## Session: 2026-09-24 — Phase 3 收口验收 + Phase 4 重排

### Phase 3 收口验收 —— 通过
- main 上 `v0.3.0` → `1311884`（rev-list 核实）；tag 内 index.js `15f553e60c`、supervisor `7a78789249` 与三实例一致
- 三实例 `DEPLOYED_REF` 均 `commit=1311884 ref=v0.3.0`；211/211；未 push（领先 origin/main 82 个提交）

### 目标更正与 Phase 4 重排
维护者更正：目标是「任何原因断联都有明确中文反馈」，统计不是需求。
按消息生命周期逐段核对代码与线上（见 findings F16），结论：
- 已完成的 Phase 1–3 逻辑覆盖到位；T2.6 / T2.7 / T3.5 / T3.6 四条路径仅测试验证，待真实故障
- **4 处未覆盖**：app-server 单独崩溃（零输出）、任务卡住无进展、模型提问时状态误导、回复因 403 永久丢弃且维护者不知情
- Phase 4 删去 T4.1 / T4.2 / T4.3 / T4.5（划线保留），新增 T4.9–T4.12
