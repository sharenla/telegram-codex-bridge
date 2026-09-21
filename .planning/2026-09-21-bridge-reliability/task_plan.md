# Task Plan: Telegram Bridge 消除「无反馈 / 失联」

执行设备 **wukong**（`javisdeMac-mini-5.local`），仓库 `/Users/wukong/Documents/Playground/telegram-codex-bridge`。
执行者为 Codex，逐任务约束见同目录 `handoff_codex.md`；证据见 `findings.md`；进度见 `progress.md`。

## Goal

让 Telegram 群里任何一条被受理的消息，在任何故障下都至少收到一条中文说明当前状态与原因，不再出现零输出。

## Next Step

Phase 1 已完成；下一步是按计划开启 Phase 2 分支并执行 T2.1。当前尚未开始 Phase 2。

## Current Phase

Phase 2

## Phases

### Phase 1: 基线与版本对齐

- [x] T1.1 提交工作区未提交改动到 main（510 行 / 9 文件 / 3 个未跟踪路径，无 stash）
- [x] T1.2 启动时打印 `index.js` sha256 前 8 位到日志与 `/status`
- [x] T1.3 让部署认 git ref：脏工作树拒绝安装 + 写 `DEPLOYED_REF`
- [ ] T1.4 默认实例 W-SVC 升级到工作区版本（行为中性），装完哈希复验
- [x] T1.5 两个命名实例同步到同一版本，确认各自 AGENTS.md 未被覆盖
- [x] T1.6 把 `index.js:58-59` 硬编码的真实群 ID 挪出产品代码（不重写历史）
- **Status:** in_progress

> T1.1 提交前须先把两份 `config/instances/*.env.example` 的 allowlist 换成占位符
> （2026-09-21 已批准，见 `handoff_codex.md` §3.2.1）。执行顺序：T1.1 → T1.6 → T1.2 → T1.3 → T1.4 → T1.5。

### Phase 2: 消除「完全无反馈」

- [ ] T2.1 `sendMessage` 纳入重试白名单 + 429 按 `retry_after` 退避
- [ ] T2.2 SIGTERM 优雅关闭：强制落盘 + kill 在飞 curl + 停 app-server
- [ ] T2.3 offset write-ahead：先落盘再处理（宁可重复，不要丢）
- [ ] T2.4 持久化 outbox，进程重启后补发
- [ ] T2.5 收到即确认（ack）+ 后续状态编辑同一条消息
- [ ] T2.6 上游 5xx / 流中断自动重试（新增 `upstream_transient` 分类）
- [ ] T2.7 `server_overloaded` 从切号逻辑拆出，改同号退避 + 建议换模型
- [ ] T2.8 实例锁迁出 `os.tmpdir()`，修好防重复启动
- **Status:** complete

### Phase 3: 修重启死循环与失联可见

- [ ] T3.1 调整启动顺序：先起 app-server，或用缓存 botIdentity 起步
- [ ] T3.2 supervisor 加启动宽限期（<60s 不计 miss）+ 强杀退避
- [ ] T3.3 轮询卡死不再 `process.exit`，改内部标记 degraded / unreachable
- [ ] T3.4 恢复后播报失联时长与积压数；`restartReason` 先消费再清空
- [ ] T3.5 supervisor 兜底直发（连续强杀 ≥3 次时自己 curl 通知）
- [ ] T3.6 409 Conflict 单独归类 `telegram_poll_conflict` 并播报
- **Status:** pending

### Phase 4: 错误分类与可观测指标

- [ ] T4.1 先用 rollout jsonl 出一版基线数字（只读脚本，不依赖新埋点）
- [ ] T4.2 固定 15 项错误码表
- [ ] T4.3 结构化日志（每行 JSON，含 `ts` / `chatId` / `requestId` / `errorClass`）
- [ ] T4.4 群内改中文文案 + 处置建议；英文原文只进日志与 `/health`
- [ ] T4.5 指标计数器 12 项 + 日报口径
- [ ] T4.6 日志保留策略：errorClass 汇总长期留，`launchd.stderr.log` 纳入轮转
- [ ] T4.7 收口沉淀：把 `findings.md` 的根因结论提炼成 `docs/reliability-postmortem.md`
- **Status:** pending

## Key Questions

1. ~~T1.1 的提交信息由谁写？~~ → **由 Codex 自行撰写**，须含多实例支持 + 每实例记忆隔离、须提到 `config/instances/` 角色文件、不得含 token（2026-09-21 人工确认）
2. ~~工作区测试 bot token 由谁提供？~~ → **不需要**。wukong 上 3 个 bot 全在线上被轮询、无闲置；Phase 2 有 5 个任务纯单测可覆盖、2 个在线上实例验证即可。原任务已改写为 T2.8「修实例锁」
3. ~~每个 Phase 完成后何时部署？~~ → **立即部署，但必须走分支流程**（见下方 Decisions Made）
4. Phase 2 的 T2.5（ack）是否需要在群里做一次人工观感确认，还是单测覆盖即可？—— 待 Phase 2 开始时决定
5. Phase 4 的日报输出到哪里（文件 / Telegram / 两者）？—— 待 Phase 4 开始时决定

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| 以**工作区**为唯一上游，单向推平三个线上实例 | 双向 diff 已验证：线上默认实例「独有」的 2 行只是被改掉那两行的旧版本；命名实例「独有」的 12 行是 Clash 故障转移的早期写法。工作区是两者的严格超集，无任何需要反向合的内容 |
| 分支流程：**分支写码 → 从分支灰度部署到生产验证 → 验证通过再合并 main → main 打 tag** | 只有一个生产环境、没有 staging。未验证代码进 main 会让 main 失去「已知良好」基准，出事时无干净回滚点 |
| 粒度：**一个 Phase 一个分支**，分支内一任务一 commit | 24 个任务开 24 个分支太碎；一任务一 commit 已足够追溯 |
| 回滚锚点 = **tag + index.js sha256 双记录** | 部署是 `rsync`，prod 目录里没有 `.git`，光有 tag 无法确认线上跑的是哪个版本。这使 T1.2 成为版本管理的必要组件而非可选项 |
| 灰度顺序 rv-prediction → 默认实例 → strategy-observation | 三个实例共用一份代码，天然可分批；命名实例影响面最小，先拿它试 |
| Phase 1 例外地直接在 main 上做，不开分支 | 它的产出就是「已知良好的 main」这个基准本身 |
| 新增 T1.3（部署认 git ref），排在 T1.4 之前 | `install-launch-agent.sh:122` 的 `rsync -a --delete` 直接从工作树拷贝、不看 git，这是本次版本漂移的制度性成因。不修它，分支与 tag 都只是装饰 |
| T2.8 改为「修实例锁」而非「换 bot token」 | 锁建在 `os.tmpdir()`，macOS 会定期清理 `/var/folders/*/T/` —— 这正是实测只剩 1 个锁文件、另两个实例锁不见了的原因。修锁才是 R7 的真正修法，且不需要人工提供 token |
| T2.5 **不做**定时进度推送，只在状态真实变化时编辑同一条 | 现网已有 5 次 429 + 88 次 editMessageText 失败，定时推送会加剧限流 |
| T2.6 的上游 5xx 另建分类，**不塞进** `ACCOUNT_FAILOVER_PATTERNS` | 塞进去会误触发切号，重演 T2.7 要修的那个问题 |
| T2.3 选择「宁可重复，不要丢」 | 重复回复用户能理解；消息凭空消失用户完全无从判断 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
|       | 1       |            |

## Notes

- 阶段状态只用 `pending` / `in_progress` / `complete`，推进时同步更新本文件与 `progress.md`
- 每次重大决定前重读 Goal 与 Next Step
- 一次只做一个任务；任务受阻立即停止并写入 `progress.md` 的 Error Log，不要自行扩大范围
- Phase 1 的 T1.1 未完成前，不得修改任何业务代码（工作区有 510 行未提交改动且无 stash）
- **编号变更提示**：本文件采用插件模板的 Phase 1–4 编号。与 2026-09-21 会话中口头讨论过的旧编号对应关系：

  | 旧编号 | 新编号 | 旧编号 | 新编号 |
  |---|---|---|---|
  | T0.1 提交 | T1.1 | T1.8 实例锁 | T2.8 |
  | T0.4 版本哈希 | T1.2 | T2.1–T2.6 | T3.1–T3.6（同序） |
  | T0.5 部署认 git | T1.3 | T3.5 基线数字 | T4.1 |
  | T0.2 默认实例 | T1.4 | T3.1 错误码表 | T4.2 |
  | T0.3 命名实例 | T1.5 | T3.3 结构化日志 | T4.3 |
  | T1.1–T1.7 | T2.1–T2.7（按执行序重排） | T3.2 / T3.4 / T3.6 | T4.4 / T4.5 / T4.6 |
