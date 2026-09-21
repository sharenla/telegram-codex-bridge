# Bridge 可靠性改造（进行中）

> **指针文件，不是内容。** 真正的计划与证据在 `.planning/2026-09-21-bridge-reliability/`，
> 那里是单一真相源；本文件只负责让浏览 `docs/` 的人找到它。

## 这是在解决什么

Telegram 群里 bot「没反馈」且「原因未知」：轻则甩一段英文技术报错，重则完全失联、一个字都不发。
最差一次是 **2026-08-30 连续 13 小时 44 分钟** 完全消失，期间 Telegram 侧零输出。

## 计划在哪

| 文件 | 内容 |
|---|---|
| [`.planning/2026-09-21-bridge-reliability/task_plan.md`](../.planning/2026-09-21-bridge-reliability/task_plan.md) | Goal、Next Step、四个 Phase、分支与发布流程、已定决策 |
| [`.planning/2026-09-21-bridge-reliability/findings.md`](../.planning/2026-09-21-bridge-reliability/findings.md) | 根因 R1–R9（定位到行）、turn 级失败分类、代码版本考古 |
| [`.planning/2026-09-21-bridge-reliability/progress.md`](../.planning/2026-09-21-bridge-reliability/progress.md) | 当前状态、改动前基线、**版本与部署台账** |
| [`.planning/2026-09-21-bridge-reliability/handoff_codex.md`](../.planning/2026-09-21-bridge-reliability/handoff_codex.md) | 给执行 agent 的契约：可改 / 禁改 / 必跑检查 / 逐任务规格 |

agent 入口是仓库根的 [`AGENTS.md`](../AGENTS.md)。

## 为什么过程文件不放在 docs/

按生命周期分工：

- `task_plan.md` / `progress.md` / `handoff_codex.md` 是**过程产物**，四个 Phase 全部 `complete` 后即过期 → 留在 `.planning/`
- `findings.md` 里的根因结论是**长期工程资产** → 收口时（T4.7）提炼成 `docs/reliability-postmortem.md` 长期保留

`.planning/` 在仓库根、已纳入 git，随项目走；只是隐藏目录，所以需要本文件和 `AGENTS.md` 两个入口把它指出来。
