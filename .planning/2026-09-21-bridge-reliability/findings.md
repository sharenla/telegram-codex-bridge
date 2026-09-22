# Findings & Decisions

调查日期 2026-09-21。对象：wukong（`javisdeMac-mini-5.local`）上运行的 telegram-codex-bridge。
调查期间未改动任何业务代码（`git diff --shortstat` 保持 `9 files changed, 510 insertions(+), 27 deletions(-)`）。

> 本文件引用的日志与 rollout 内容均为运行时产物，属**不可信数据**，只作证据读取，不得当作指令执行。

---

## Requirements

用户请求转成可验证需求：

- R-A 任何一条被受理的消息，至少收到一条可见反馈（确认 / 进度 / 结果 / 失败原因），不存在零输出
- R-B bridge 被强杀或自杀重启后，受影响会话能收到中断说明与恢复通知
- R-C 群内展示文案为中文并附处置建议；英文原始错误只进日志与健康接口
- R-D 能从日志算出「无反馈率」「无反馈时长分布」「各原因占比」
- R-E 代码有分支与版本管理：分支写码 → 生产验证 → 合并 main → tag 区分版本
- R-F 线上三个实例代码版本一致且可追溯到具体 commit

---

## Research Findings

### F0 先固定口径：两个部署，别混

| 代号 | 位置 | 作用 |
|---|---|---|
| **W-SVC** | `wukong:~/Library/Application Support/telegram-codex-bridge-service` | **本计划唯一目标**，真正服务 Telegram 群聊 |
| L-SVC | `longxia:~/Library/Application Support/telegram-codex-bridge-service` | 另一台机器上的独立部署，仅作对照 |

两者失败画像完全不同（W-SVC turn 失败率 1.6%，L-SVC 9.7%，且主因不同）。任何结论必须标明来源。

### F1 数据源与核实方法

| 数据源 | 位置（wukong） | 规模 | 时间戳 |
|---|---|---|---|
| bridge stderr | `<W-SVC>/data/logs/bridge.stderr.log` | 25,958 行 | ❌ bridge 自己的行没有，只有 codex app-server 转发的行有 |
| supervisor stdout | `<W-SVC>/data/logs/bridge.stdout.log` | 回溯到 2026-06-08 | ✅ 每行带 `[YYYY-MM-DD HH:MM:SS]` |
| launchd stderr | `<W-SVC>/data/logs/launchd.stderr.log` | 最后写入 2026-06-04 | ❌ |
| Codex turn 明细 | `<W-SVC>/data/codex-home/sessions/**/*.jsonl` | 38 个 rollout / 421MB | ✅ 每事件带 ISO 时间戳与 `error` 字段 |
| 运行时状态 | `<W-SVC>/data/store.json` | — | 部分 |

核实方式：SSH（`remote-mac-wukong`）直接在 wukong 上 grep / 统计，无中间缓存。

### F2 与本机 Codex 报告的核对 —— 报对的部分

| Codex 的数字 | 实测 | |
|---|---|---|
| getUpdates 重试 18,578 | 18,609 | ✅ 复算时日志又增长 |
| 轮询错误 2,054 | 2,054 | ✅ 精确 |
| Bad Gateway 35 | 35 | ✅ |
| 409 Conflict 5 | 5 | ✅ |
| 429 限流 5 | 5 | ✅ |
| handleMessage failed 2 | 2 | ✅ |
| Failed to notify chat 2 | 2 | ✅ |
| refresh_token_invalidated 1 | 1 | ✅ |
| 工作区与安装目录 index.js 不一致 | 320,359 vs 318,245 字节 | ✅ |

其提出的三条体验缺陷（错误提示本身发不出去 / 失联期间无用户可见状态 / 无消息级闭环统计）判断正确。

### F3 与本机 Codex 报告的核对 —— 报偏的三处

1. **`no space left on device` 157 次不在它声明的窗口内**。全部位于 `launchd.stderr.log`，该文件最后写入 **2026-06-04 02:09**。磁盘写满确实历史上打死过 bridge 157 次（写 `data/bridge.pid` 失败），但那是 6 月前的事。当前磁盘 228Gi / 已用 175Gi / 剩 29Gi（86%），**不是当前风险**
2. **「日志覆盖 2026-08-27 至 09-21」只对 stderr 成立**。`bridge.stdout.log` 回溯到 6 月 8 日，最关键证据恰在其中
3. **表格存在重复计数**。「TLS 失败约 11,839 行」+「连接超时约 11,090 行」= 22,929 行，超过 stderr 中 getUpdates 重试的全部 18,609 行。应只保留「轮询错误次数」列（1,303 + 706 ≈ 2,009，可对上 2,054 总数）

### F4 与本机 Codex 报告的核对 —— 完全漏掉的（体验最差的一类）

1. **88 次进程自杀 + 274 次 supervisor 强杀**，报告中无任何一行
2. **2026-08-30 03:15:59 → 16:59:35，连续 13 小时 44 分钟重启风暴**：272 次强杀集中于这一天，634 条启停记录，全程 Telegram 侧零输出。整段历史中最差的一次事故
3. **触发条件几乎必然命中**：88 次自杀的卡死时长 min=181s / 中位=183s / max=306s，阈值是 180s
4. **`sendMessage` 永久失败 18 次** —— 答案已算完但发不出去
5. **完全没有 turn 级失败分类**（见 F5）

### F5 W-SVC turn 级实测（38 个 rollout）

| 指标 | 数量 |
|---|---:|
| user_message | 1,690 |
| task_started | 1,683 |
| task_complete | 1,630 |
| turn_aborted（用户 `/stop`） | 29 |
| **孤儿 turn（开始后无任何终结事件）** | **24** |
| 明确失败（带 error 字段） | 27 |

失败率 27 / 1,683 = **1.6%**。孤儿 turn 24 个即真正的「零输出失联」，分布 2026-04 ~ 2026-08（08-13 有 2 个，当天有 51 条 supervisor 启停）。
08-30 那 14 小时**没有孤儿 turn**，因为 bridge 从未健康到能启动 turn —— 那天的损失 100% 发生在 Telegram 入站层。

27 个失败的原因分布：

| 次数 | codex_error_info | 原文要点 |
|---:|---|---|
| 6 | other | `stream disconnected before completion`（上游未确认 response.create / websocket 提前关闭 / SSE idle timeout） |
| 5 | other | `503 Hard affinity owner account is unavailable` |
| 4 | server_overloaded | `Selected model is at capacity` |
| 3 | other | `502 Previous response owner account is unavailable` |
| 2 | other | `503 No available accounts` |
| 2 | other | `502 proxy rejected connection: HTTP 503, url: http://127.0.0.1:...` |
| 1 | other | `502 Codex upstream stream failed via proxy endpoint codex-lb` |
| 4 | other | `400 invalid_request` 等 |

**关键结论**：W-SVC 走 `CODEX_BACKEND=codex-lb`（`http://127.0.0.1:2455`）。27 个失败中 **13 个是 codex-lb / 上游的 5xx 与流中断**，只有 4 个是真正的模型满载。而这 13 个全部无法命中 `ACCOUNT_FAILOVER_PATTERNS`（该表只认 429/quota/capacity/overloaded/billing），因此既不重试也不切号，直接把英文原文投递给群用户。

> ⚠️ 这条**纠正了一个早期错误判断**。在 L-SVC 上 71% 的失败是 `server_overloaded`，据此曾断定「模型满载被误判成额度问题」是头号问题 —— 在 W-SVC 上不成立。W-SVC 的头号问题是**上游 5xx / 流中断完全没有任何自动重试**。只按一台机器排优先级会排错。

### F6 根因清单（全部定位到行，基于工作区 `index.js`，8,862 行）

| 编号 | 根因 | 位置 | 置信度 |
|---|---|---|---|
| **R1** | `sendMessage` 不在重试白名单；429 不算临时错误 | `index.js:161`（白名单只含 getUpdates/getMe/sendChatAction/editMessageText/answerCallbackQuery）、`:1857`（`isTransient` 只匹配 transport failed / SSL_ERROR_SYSCALL / timed out / Connect Timeout） | 已证实（实测 18 次） |
| **R2** | 进程自杀不播报，`restartReason` 写了从来没人读 | `:5128` `requestSupervisorRestart()` → `:5134` 写入 → `process.exit(1)`；`:4319` `recordTelegramPollSuccess()` 无条件清空；`/status` 不含该字段 | 已证实 |
| **R3** | 启动顺序导致重启死循环（最严重） | `:4291` `await resolveBotIdentity()`（getMe 最多 4 次 × 10s ≈ 40s+）远早于 `:5532` `startCodexServer()`；`codex-launch-supervisor.sh:12` `APP_SERVER_MISS_LIMIT=3` × `:11` `POLL_INTERVAL=5` = 15s 即 `stop_bridge`（`:157-158`） | 已证实（08-30 持续 13h44m，期间日志只有 getMe 重试、无 app-server 启动） |
| **R4** | 卡死阈值对着抖动中位值，等于必中 | `:155` `TELEGRAM_POLLING_STALL_THRESHOLD_MS=180000`、`:156` 连续错误阈值 6；实测中位 183s | 已证实 |
| **R5** | `server_overloaded` 被误判为账号额度问题 | `:104` `ACCOUNT_FAILOVER_PATTERNS` 含 `/capacity/i`、`/overloaded/i` → `isUsageLimitTurn()` 为真 → 轮着切号 → `All configured Codex accounts appear to be limited right now.` | 已证实 |
| **R6** | 重启时新旧实例轮询重叠，可能真的吃掉消息 | `:1877` getUpdates 的 curl `--max-time` = 45s；`supervisor:158` 只对 node 发 SIGTERM；`:1017` 唯一的 SIGTERM 处理只删锁文件 + `process.exit(143)`，**不 flush store、不 kill 在飞 curl、不停 app-server** → curl 成孤儿并可挂长轮询 45s，而 supervisor 5s 内拉起新实例；`:1821` `saveThrottled()` 1 秒节流 → 最后 1 秒 offset 推进可能未落盘；`:8671` 先推进内存 offset 再节流写盘 | **机制已证实**（锁文件创建于 `2026-09-20T05:30:56.852Z`，4 条连续 409 紧邻 `2026-09-20T05:31:05Z`，差 9 秒，符合重启重叠而非手动抢占）；**但未捕获某条具体消息丢失的实证** —— 因为入站消息完全没有日志，这本身就是问题 |
| **R7** | 工作区与线上共用同一个 bot token | 工作区 `.env` 与 W-SVC `.env` 的 token 尾号相同；store 中 botIdentity 相同（`Codex_Bz01_bot`, id 8752179867），offset 仅差 2,939。实例锁按 token 哈希建在 `os.tmpdir()`（`:954`），launchd 与 SSH 的 `TMPDIR` 已确认相同（`/var/folders/n5/.../T/`），锁**理论上能拦住**，但全盘只存在 1 个锁文件 —— macOS 会定期清理 `/var/folders/*/T/` | token 共用已证实；「实际发生过手动抢占」未证实（R6 是更好的 409 解释） |
| **R8** | 群内静默丢弃 | `:1566` `evaluateTelegramMessageDirection()`：群消息仅当文本字面含 `@botusername` 或 reply 到当前 bot id 才处理，否则 `group_text_not_directed` 静默丢；用户无任何提示 | 已证实 |
| **R9** | 观测性缺口（「原因未知」的本质） | ①bridge 自己的日志行无时间戳 → 算不出失联时长 ②无入站消息日志 → 分母未知，无法算无反馈率 ③错误行不带 chatId → 无法按群归因 ④`restartReason` 写了不读（R2）⑤日志保留 14 天 / 7 份，且 `launchd.stderr.log` **未纳入轮转**（6 月那 157 行能留到今天就是这个原因） | 已证实 |

### F7 R6 的损失路径（需要理解才能正确修 T2.2 / T2.3）

1. 进程读取 updates U1..U5，内存 offset 推进到 6，`saveThrottled()` 因节流跳过写盘
2. 进程被 SIGTERM；store 里 offset 仍是旧值
3. 孤儿 curl 携带 offset=6 抵达 Telegram → Telegram 视 U1..U5 为已送达并删除
4. 新实例从 store 读到旧 offset 再请求 → 已无数据 → **U1..U5 永久消失**

日志中仅 5 次 409 **严重低估**：409 返给「输的一方」，而输方常是已死的旧进程，无人记录。

### F8 代码版本考古（四份副本、三个版本）

| 副本 | sha256 前 12 | 大小 | 时间 | memories 特性 | Clash 故障转移 |
|---|---|---:|---|:---:|---|
| **工作区** `~/Documents/Playground/telegram-codex-bridge` | `de9c6ab6823a` | 320,359 | 09-02 15:26:18 | ✅ | 新版 |
| W-SVC（默认，线上） | `13fa361a50d0` | 318,245 | 09-02 15:30:56 | ❌ | 新版 |
| strategy-observation-service | `52188e37d0ea` | 317,092 | 09-01 13:08:49 | ✅ | 旧版 |
| rv-prediction-service | `52188e37d0ea` | 317,092 | 09-01 13:08:49 | ✅ | 旧版 |
| git HEAD `884811e` | — | 314,978 | — | ❌ | 旧版 |

**差异内容**是一个连贯功能 —— 让命名实例保住自己的角色与记忆：
1. 新增 `configureCodexMemoriesFeature()`，向 `CODEX_HOME/config.toml` 写 `[features] memories = true/false`，由 `CODEX_MEMORIES_ENABLED` 控制
2. 桌面上下文同步新增 `CODEX_CONTEXT_SYNC_MEMORIES` / `CODEX_CONTEXT_SYNC_AGENTS` 开关。原为硬编码，每次启动都用桌面的 `memories/` 与 `AGENTS.md` 覆盖运行目录 —— 对命名实例等于每次重启擦掉专属角色
3. 导出新函数供测试

**合并方向（已双向 diff 验证）**：
- W-SVC「独有」的 2 行，正是工作区改掉那两行的旧版本（`syncDirs` 一行式、`AGENTS.md` 无条件复制）→ W-SVC 无任何独有内容
- 命名实例「独有」的 12 行，全是 `listClashFailoverCandidates` / `recoverTelegramTransport` 的早期写法；工作区在该区域多出 102 行更完善实现 → 命名实例无任何独有内容
- **工作区是两者的严格超集，合并方向无歧义**

### F9 一个解释不了的疑点（需保留警觉）

`install-launch-agent.sh:122` 用 `rsync -a`（`-a` 含 `-t`，保留源时间戳）。若 W-SVC 是从工作区安装，其 mtime 应等于工作区的 15:26:18，但实际是 **15:30:56**；而全盘只有一个检出，无第二份代码。

最可能的经过：09-02 15:30 那次安装时工作区正处于「memories 特性被临时摘掉」的状态，之后工作区又被换回了一个保留旧 mtime 的副本。**无法确证。**
→ 因此**安装后必须用哈希复验**，不能只看「装完了」（T1.4 / T1.5 验收标准）。

### F10 最高优先风险：整个多实例功能未提交

```
git HEAD = 884811e，index.js 314,978 字节，不含 memories 特性
工作区未提交：9 个文件，+510 行 / -27 行（index.js 独占 +183）
未跟踪：config/instances/、docs/MULTI-INSTANCE.md、tests/multi-instance-launch-agent.test.js
git stash list：空
```

`config/instances/` 内两个命名实例赖以运行的角色文件（`strategy-observation.AGENTS.md`、`rv-prediction.AGENTS.md`）**连 git 都没进**。一次 `git checkout .` 或 `git clean -fd` 即不可恢复。

### F11 一处需纠正的早期判断

早期曾推测「命名实例的 AGENTS.md 正被默认同步逻辑静默覆盖」—— **错误，没有这回事**：

```
strategy-observation / rv-prediction 的 .env：
  CODEX_CONTEXT_SYNC=1
  CODEX_CONTEXT_SYNC_AGENTS=0
  CODEX_CONTEXT_SYNC_MEMORIES=0
  CODEX_MEMORIES_ENABLED=1
```

两者的代码**有**该特性、配置也正确启用，是自洽的、未损坏。只有默认实例 W-SVC 版本落后。

### F12 三实例 token 互不相同（好消息），但无闲置 bot

| 实例 | bot | id |
|---|---|---|
| telegram-codex-bridge-service | `@Codex_Bz01_bot` | 8752179867（**工作区 `.env` 也是这个** → R7） |
| telegram-codex-bridge-strategy-observation-service | `@Codex_OBS_bot` | 8761743285 |
| telegram-codex-bridge-rv-prediction-service | `@Codex_RV_bot` | 8941599234 |

多实例并存本身干净，**不是 409 的原因**（409 归因 R6 重启重叠）。但**三个 bot 全部正在被线上服务轮询，无闲置可用于测试** —— Telegram 硬限制：一个 token 只允许一个 `getUpdates` 消费者。

### F13 工作区当前可信度（改动前基线）

在 wukong 工作区实测 2026-09-21：

```
node -c index.js                  → SYNTAX OK
node --test ./tests/*.test.js     → tests 99 / pass 99 / fail 0（duration 362ms）
```

其中三项直接覆盖那 67 行未提交功能：
`desktop context sync preserves auth while copying memories and safe config` /
`desktop context sync can preserve instance-specific role and memories` /
`isolated Codex home can enable memories after shared config sync`

**工作区状态良好，可作为推平基准。**

### F14 环境备注（执行时会踩）

- wukong 时区 **UTC+7**；codex app-server 日志用 UTC，supervisor 用本地时间，比对需换算
- SSH 非登录 shell 的 PATH 里**没有 `npm`、没有 `timeout`**；node 在 `/opt/homebrew/bin/node`，执行前需 `export PATH=/opt/homebrew/bin:$PATH`
- W-SVC 走本地代理 `http://127.0.0.1:1082`（`TELEGRAM_PROXY_URL` 留空 + `TELEGRAM_PROXY_AUTO=1` 自动探测 Clash），失败形态以 `LibreSSL SSL_*` 与 `Operation timed out` 为主 —— 与 L-SVC 的 direct + `Connection reset by peer` 不同
- W-SVC 当前模型 `CODEX_MODEL=gpt-6-astra`，allowlist 含 1 个私聊 + 3 个群

---

## Technical Decisions

架构与实施选择的完整清单见 `task_plan.md` 的 Decisions Made。下表只记**由证据直接推出**的技术判断：

| Decision | Rationale |
|----------|-----------|
| 以工作区为唯一上游，单向推平 | F8 双向 diff：两个线上副本均无独有内容，工作区是严格超集 |
| 先修「部署认 git ref」再谈分支策略 | F9 + `install-launch-agent.sh:122` 从工作树 rsync，不看 git。这是版本漂移的制度性成因；不修它，分支与 tag 都是装饰 |
| 回滚锚点用 tag + sha256 双记录 | 部署是 rsync，prod 目录无 `.git`，光有 tag 无法确认线上版本 |
| 上游 5xx / 流中断另建分类，不并入切号表 | F5：这 13 个失败与账号额度无关，切号无效；并入会重演 R5 |
| offset 改 write-ahead，接受重复投递 | F7 的损失路径：不写盘在前，消息会被 Telegram 判为已送达而删除。重复可理解，消失不可理解 |
| T2.8 修实例锁而非换 token | F12 无闲置 bot；R7 的真因是 `os.tmpdir()` 被系统清理，修锁才是根治 |
| 不做定时进度推送 | F2：现网已有 5 次 429 + 88 次 editMessageText 失败，定时推送会加剧限流 |
| 先出 rollout 基线数字再做埋点（T4.1） | F5 证明 `data/codex-home/sessions/**/*.jsonl` 已含 turn 生命周期与 error，无需等新埋点 |

---

## Issues Encountered

调查与文档编写过程中遇到的问题：

| Issue | Resolution |
|-------|------------|
| 早期把 L-SVC 与 W-SVC 的数字混在一起，导致「模型满载是头号问题」的错误结论 | 建立 F0 口径表，所有数字标注来源；F5 重新按 W-SVC 统计并明确纠正 |
| `~/mnt/wukong` 这个 rclone 挂载**不含 `Library/`**，读不到 wukong 的 service 日志 | 改用 SSH `remote-mac-wukong` 直接在 wukong 上统计 |
| 早期用 `find .` 扫描工作区超时（项目在网络挂载上） | 改用定向 `ls` / `grep`，避免全盘递归 |
| 早期统计用 `sort \| uniq -c \| head -60` 得出「models refresh 失败 32 次」，实际 2,866 次 | cf-ray 使每行唯一，桶被打散到 head 之外。改用 `grep -c` 直接计数 |
| 用 `git diff --stat -- index.js scripts/ tests/` 判断「是否改了业务代码」是错的 —— 那些改动本来就在工作区 | 改为与基线全量对比 `git diff --shortstat`，要求逐字节等于 `9 files changed, 510 insertions(+), 27 deletions(-)` |
| 通过 rclone 挂载写文件时出现 `.partial` 临时文件，未 finalize | 等待 rclone 上传完成后回到 wukong 用 `ls` / `wc -l` / `tail -1` 复验完整性 |
| 首版规划文件放在 `docs/bridge-reliability/`，不符合插件约定 | 用 `init-session.sh "Bridge Reliability"` 生成 `.planning/2026-09-21-bridge-reliability/`，按模板重写，迁移而非复制（避免两份真相） |

---

## Resources

### 仓库与部署
- 仓库根：`/Users/wukong/Documents/Playground/telegram-codex-bridge`
- 计划目录：`.planning/2026-09-21-bridge-reliability/`（`PLAN_ID=2026-09-21-bridge-reliability`）
- 三个线上实例：`~/Library/Application Support/telegram-codex-bridge{,-strategy-observation,-rv-prediction}-service/`
- LaunchAgent：`~/Library/LaunchAgents/com.sharenla.telegram-codex-bridge*.plist`

### 关键代码位置（工作区 `index.js`，8,862 行）
| 位置 | 内容 |
|---|---|
| `:104` | `ACCOUNT_FAILOVER_PATTERNS` |
| `:155-156` | 轮询卡死阈值 180s / 连续错误 6 |
| `:161` | `TELEGRAM_RETRYABLE_METHODS` |
| `:954` / `:969` / `:1017` | 实例锁路径 / 获取 / SIGTERM 处理 |
| `:1814-1826` | `Store.save()` / `saveThrottled()` |
| `:1857` / `:1877` | `isTransient` 判定 / curl `--max-time` |
| `:1566` | `evaluateTelegramMessageDirection()` |
| `:4291` / `:5532` | `resolveBotIdentity()` / `startCodexServer()` |
| `:4319` | `recordTelegramPollSuccess()`（清空 restartReason） |
| `:5128-5134` | `requestSupervisorRestart()` |
| `:8661-8700` | `pollingLoop()`（offset 推进） |
| `scripts/codex-launch-supervisor.sh:11-12,157-158` | `POLL_INTERVAL` / `APP_SERVER_MISS_LIMIT` / 强杀 |
| `scripts/install-launch-agent.sh:122` | `rsync -a --delete`（从工作树拷贝） |

### 常用命令
```sh
export PATH=/opt/homebrew/bin:$PATH
cd /Users/wukong/Documents/Playground/telegram-codex-bridge
node -c index.js && node --test ./tests/*.test.js
zsh -n ./scripts/codex-launch-supervisor.sh
```

### 相关文档
- `docs/MULTI-INSTANCE.md`（未跟踪，随 T1.1 进入 git）
- `docs/COMMANDS.md`

---

## Visual/Browser Findings

本次调查未涉及图片、PDF、图表或浏览器结果。全部证据来自文本日志、JSONL rollout 与源码，已在上方 Research Findings 中转为文字。


## 执行期追加发现（2026-09-21，Codex）

本节按本轮用户“变化写 findings.md”的明确要求追加，原调查快照未修改。

- T1.1 执行前：main / HEAD 884811e，业务差异仍为 9 files / +510 / -27，stash 为空；新增规划与入口文件是调查后产物。
- 指定检查复验通过：node 语法、tests 99 / pass 99 / fail 0，四个 zsh 脚本语法检查均通过。
- 提交前扫描发现两份 config/instances/*.env.example:3 含聊天 ID 格式的 allowlist，tests/multi-instance-launch-agent.test.js:43 含同格式测试值（是否虚构未核实）。未记录具体值。git add -A 已执行，但未提交；需先解决 handoff 对标识提交与模板修改的限制冲突，不能直接提交当前暂存区。
- 未修改业务代码、未部署或重启，T1.1 尚未完成；完整阻塞记录见 progress.md。

---

### F15 公开仓库里已泄露两个真实群 ID（2026-09-21 T1.1 阻塞时查出）

`origin` = `https://github.com/sharenla/telegram-codex-bridge.git`（**公开仓库**），
本地 `HEAD == origin/main`、领先 0 个提交 → 已 push。

| ID | 状态 | 位置 |
|---|---|---|
| `[REDACTED_CHAT_ID]` | ⚠️ **已公开** | `index.js:58`、`tests/truth-profile.test.js:110`；历史中 3 个提交（`9bb7564` / `fe5ccb3` / `935f3d1`） |
| `[REDACTED_CHAT_ID]` | ⚠️ **已公开** | `index.js:59`、`tests/truth-profile.test.js:146`；历史中 1 个提交（`884811e`，即当前 HEAD） |
| `[REDACTED_CHAT_ID]`（私聊 ID） | 未泄露 | 仅在未提交的 `config/instances/*.env.example:3` |
| `[REDACTED_CHAT_ID]` | 未泄露 | 仅在未提交的 `config/instances/*.env.example:3` |

**不是意外泄露，是设计如此**：`index.js:58-59` 把真实群 ID 硬编码为默认 chat→project 绑定，
所以每次提交都会重新带上。→ 立 **T1.6** 把它挪出产品代码。

**风险校准（不要过度报警）**：Telegram chat ID **不是凭据** —— 知道群 ID 不能加入、不能读、不能发，
那需要 bot token 或邀请链接。实际危害是元数据暴露（这些群存在、归属本项目），
次生风险是万一 token 将来泄露，现成 ID 列表让攻击者能直接定位目标。
提交前扫描未发现 token / `sk-` 格式 key / 私钥头。

**不重写历史**：force push 已被契约禁止；对公开仓库而言也删不掉已被 fork 或 GitHub 缓存的 dangling commit；
而 chat ID 非凭据，收益远小于风险。是否更换群属运营决定，不在计划范围内。


## Phase 1 执行结果（2026-09-21）

- T1.1：脱敏两份实例模板 allowlist 后提交多实例/记忆隔离基线，commit `be579fd`。
- T1.6：默认 chat→project 绑定从源码移入服务本地 `data/chat-project-bindings.json`；安装脚本先迁移旧绑定再 rsync，既有本地文件不覆盖。源码、跟踪测试和配置不再包含调查中的真实群 ID；不重写公开历史。
- T1.2：运行时从 `index.js` 自身计算 SHA-256，启动日志与 `/status` 暴露完整哈希及前 8 位。
- T1.3：安装脚本拒绝脏工作树（显式 `BRIDGE_ALLOW_DIRTY=1` 才绕过），写 `DEPLOYED_REF`，并排除 `.planning/`。
- T1.4/T1.5：三实例均经安装脚本部署，四份 index.js 哈希一致为 `889d4bd36bfc...`，LaunchAgent 进程存活，命名实例角色文件保留。默认实例在 `bca12d3` 部署，命名实例在 `65a6f34` 部署；两者业务文件哈希相同，差异为后续规划文档提交。
- Phase 1 tag 为 `v0.1.1`（`8c8e8b3`）；全套最终检查 104/104 通过，四个 zsh 语法检查通过。未进行真实群消息冒烟，因此用户侧实际回复仍是剩余人工验证项。

### 收口更正

Phase 1 仍 in_progress，Phase 2 pending。已部署三实例且哈希一致，但未取得逐实例实际应答及 /status 绑定比对证据，前述 complete/灰度通过表述过早；v0.1.1 不能视为完整验收发布。详见 progress.md 收口更正。


### Phase 2 执行追加发现（2026-09-22）

- T2.1 已实现 sendMessage transient/429 重试；108/108 测试通过，尚未部署。
- T2.3 原规格存在恢复语义矛盾：仅先写递增 offset 不保存 update 内容，崩溃后从新 offset 继续会跳过未完成项，不能推出“最多重复一次”。当前 handler 为异步 fire-and-forget，单纯 SIGTERM flush 也不足以解决。建议先明确持久化入站 inbox 及重放/完成边界，再联动执行 T2.2/T2.3；已按契约停止扩大实现范围。


### T2.2/T2.3 implementation finding (2026-09-22)

The corrected inbox contract is implemented in the same change as graceful shutdown. `store.json` now provides the atomic boundary for offset plus minimal pending update data; no separate inbox file is used. Tests prove pending data is present before dispatch and survives a fresh Store reload. Production kill/restart smoke is intentionally deferred until the Phase 2 deployment gate.

### T2.3a 回归验证（2026-09-22）

串行等待启动重放导致 pollingLoop 不启动已通过真实启动尾部的隔离测试复现。仅将启动重放改为后台 Promise 后，新消息在旧 dispatch 永不完成时仍能处理，未完成项保留在 inbox；117/117 与完整语法检查通过，尚待灰度运行验证。
