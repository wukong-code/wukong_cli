# `wukong today` / `/today` 设计

> 版本: v1.0
> 日期: 2026-07-08
> 状态: 已实现（P1）
> 域名对齐: `wukong.today` — CLI 侧「今天你和代码的关系」入口

## 1. 定位

**`today` = Daily Proof Briefing（今日简报 + 今日 Focus）**

一句话：**今天 AI 写了什么、验了什么、能不能合并、今天要交付什么。**

- 与域名 `wukong.today` 天然对齐：开发者每天开工第一眼。
- 与 Wukong proof-layer 定位一致：读状态，不替代 `verify` / `proof` / `goal` / `loop` 的执行。
- 默认离线可用；登录后可增强（hosted report 计数、dashboard 链接），不阻塞本地。

**不做：** XP / mood / 喂养 / pomodoro / 随机 quote 当主功能；不重新跑 verify；不上传源码 diff；不对齐 web legacy `/api/today` 的 companion quests 模型。

## 2. 命令契约

```bash
# 只读：今日简报（含当前 focus，若有）
wukong today
wukong today --json
wukong today --workspace /path/to/repo

# 读写：设置今日 focus，并输出更新后的简报
wukong today "ship checkout auth fix"
wukong today --clear-focus

# TUI
/today
/today ship checkout auth fix
/today clear
```

| 模式 | 行为 |
|---|---|
| 无参数 | 只读简报 |
| 位置参数 `"..."` | 写入今日 focus → 再输出简报 |
| `--clear-focus` | 清除 focus → 再输出简报 |
| `--json` | 机器可读（脚本 / dashboard） |
| `--workspace` | 指定工作区，默认 `cwd` |

## 3. 输出形态

Focus 置顶，stats 在下，Next 基于真实状态生成（不调用模型）：

```text
Wukong Today — 2026-07-08

Focus: ship checkout auth fix

Workspace: ~/proj/my-app (3 changed)
Today: verify 4 (2✓ 2✗) · scan 2 · proof 1 BLOCKED · guard 1 blocked
Last proof: BLOCKED — auth/session.test.ts failing
Streak: 5 days with at least 1 clean verify

Next
  → wukong proof
  → /goal "fix auth tests" --until verify-pass
```

无 focus 时：

```text
Focus: (not set) — wukong today "<your goal>"
```

## 4. 数据来源（只读聚合）

从本地 `~/.wukong` 读取，不执行 verification：

| 字段 | 来源 |
|---|---|
| 今日 verify/scan/proof/guard 次数与 pass/fail | `~/.wukong/stats/events.jsonl`（或等价索引，P1 先定义 schema） |
| Last proof 结论 | stats ledger 中最近一条 proof completion event；若用户显式保存 evidence，再附本地 artifact 路径 |
| Workspace git 快照 | `inspectGit(cwd)` — changed files 计数 |
| 进行中 goal/loop | 当前 session / goal store |
| Streak | 连续 N 天至少有 1 次 clean verify（基于 stats 按日聚合） |
| Focus | `~/.wukong/today/focus.json` |

登录态可选增强：

- hosted report 今日上传数 / quota（`wukong.today` API）
- Dashboard 链接：`https://wukong.today/dashboard`

## 5. Focus 存储

```json
{
  "text": "ship checkout auth fix",
  "setAt": "2026-07-08T09:00:00.000Z",
  "workspace": "/Users/dev/proj/my-app"
}
```

路径：`~/.wukong/today/focus.json`（按自然日可重置或跨日保留至用户 `--clear-focus`）。

**与 `/goal` 的分工：**

| | `today` focus | `/goal` |
|---|---|---|
| 粒度 | 今天的大方向（一天一条） | 可执行任务 + 停止条件 |
| 示例 | `ship checkout auth fix` | `fix auth tests --until verify-pass` |
| 关系 | TUI 新 session、`/goal`、`/loop` 可注入为默认上下文 | 执行核 |

## 6. JSON 输出（`--json`）

```ts
interface TodayBriefing {
  date: string;                    // ISO date, local or UTC 需文档固定
  focus: string | null;
  workspace: { cwd: string; changedFiles: number };
  today: {
    verify: { runs: number; passed: number; failed: number };
    scan: { runs: number; blocked: number };
    proof: { runs: number; lastStatus?: 'pass' | 'blocked' };
    guard: { blocked: number; allowed: number };
    goals: { completed: number; inProgress: number };
  };
  lastProof?: { status: 'pass' | 'blocked'; summary: string };
  streak: number;
  next: string[];                  // 1–2 条建议，基于规则映射
  hosted?: { reportsToday: number; quota?: number; dashboardUrl: string };
}
```

## 7. 与其他命令

```text
/today     → 今日简报 + focus（日，读为主）
/verify    → 跑一次检查（动作）
/proof     → 合并证据（动作）
/goal      → 单任务到 gate（动作）
/loop      → 多轮迭代（动作）
/retro     → 本周复盘（周，P1 后）
/journey   → 长期趋势（月，P2 后）
/sync      → 与 wukong.today 同步 metadata（基础设施）
```

## 8. 实施前置

1. 定义 stats 事件 schema（verify / scan / proof / guard / goal / loop 写入统一事件流）。
2. Milestone 0.5 的 proof / loop 稳定后，today 才有有意义的「Last proof」「goals in progress」。
3. web legacy `/api/today` 不作为 CLI 对齐目标；未来 web dashboard 消费同一套 redacted stats / focus sync。

## 9. 验收

- 未登录：`wukong today` 完整输出本地简报。
- `wukong today "focus text"` 写入 focus 且再次 `wukong today` 可见。
- `--clear-focus` 清除后简报显示 `(not set)`。
- `--json` 符合 `TodayBriefing` schema。
- 不触发 verify/scan/proof 执行；不上传源码 diff。
- Next 建议在有 BLOCKED proof 时指向 `wukong proof` 或带 `--until` 的 goal。
