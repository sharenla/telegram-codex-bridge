# AGENTS.md — telegram-codex-bridge

本文件是进入本仓库的**唯一入口指引**。任何 agent（Codex / Claude Code / 其他）在动手前先读这里。

## 当前有一份进行中的计划

```
.planning/2026-09-21-bridge-reliability/
PLAN_ID = 2026-09-21-bridge-reliability
```

读取顺序（不要跳）：

1. `.planning/2026-09-21-bridge-reliability/handoff_codex.md` — **执行契约**：可改什么、禁改什么、必跑哪些检查、逐任务规格
2. `.planning/2026-09-21-bridge-reliability/task_plan.md` — Goal / Next Step / 四个 Phase / 分支与发布流程
3. `.planning/2026-09-21-bridge-reliability/progress.md` — 当前状态、改动前基线、版本与部署台账
4. `.planning/2026-09-21-bridge-reliability/findings.md` — 根因 R1–R9 与已核实的数字（**只读，不要改**）

`task_plan.md` 的 `## Next Step` 就是下一个该做的动作。做完一个任务立即更新 `progress.md`。

## 三条硬约束（完整版在 handoff_codex.md）

- **禁止** `git checkout` / `restore` / `clean` / `reset` / `stash` / `rebase` / `commit --amend` / `tag -d`。切分支用 `git switch`。理由：工作区曾有 510 行未提交改动且无 stash，其中含线上实例赖以运行的角色文件
- **禁止**手工编辑 `~/Library/Application Support/telegram-codex-bridge*-service/` 下任何文件。线上代码只能经 `scripts/install-launch-agent.sh` 更新
- **禁止**碰任何 `.env`；**禁止**在本仓库用线上 token 启动 bridge（三个 bot 全在线上被轮询，抢占即丢真实消息）

## 环境（会踩的坑）

```sh
export PATH=/opt/homebrew/bin:$PATH   # 非登录 shell 里没有 npm、没有 timeout
node -c index.js && node --test ./tests/*.test.js   # 基线 99/99，改动后总数只增、fail 必须为 0
```

设备 wukong（`javisdeMac-mini-5.local`），时区 UTC+7；codex app-server 日志用 UTC，supervisor 用本地时间。

## 遇阻怎么办

停止改动，把现象 / 已尝试 / 卡在哪 / 影响面写进 `progress.md` 的 Error Log，**不要自行扩大范围**。
