# 手工验证 Runbook（0.1.x 验证债务）

> 目的：把 TODO 中不能进 CI 的发布后验证项变成任何人 20–30 分钟可执行完的固定流程。
> 执行结果按 TODO.md 对应条目勾选并注明日期；失败项按严重度走 ROADMAP 发布后事件处理。
> 通用要求：全程用公开发布的 stable binary（`wukong --version` 记录版本），不用开发构建。

## A. Windows 真实 repo：blocker → fix → full rerun → PASS

前置：Windows x64 或 arm64 实机/VM；Node ≥ 24；一个真实 Node 或 Python 项目 repo；有效 BYOK key。

1. 安装：`wukong --version` 确认安装的是当前 stable。
2. 在 repo 里人为引入一个会失败的测试（ seeded blocker ），`git status` 记录 dirty 基线。
3. 配置 provider 并完成 smoke（一次简单 `-p` 提问拿到正常回复）。
4. `wukong -p "修复当前失败的测试" --done-when "测试全部通过"`（或 TUI `/loop` 等价路径）。
5. Preflight 逐项检查：dirty paths 摘要与第 2 步一致；checks 识别正确；审批逐项确认。
6. 跑到终态，逐项核对：
   - [ ] 终态为 `PASS`；失败测试确实被修复并真实重跑通过
   - [ ] 文件归因区分 pre-existing dirty 与 Wukong touched，第 2 步的既有改动没有被归给 Wukong
   - [ ] usage（calls/tokens）与 budget 显示完整
   - [ ] decisive evidence、blocker、next action 可读且与实际一致
7. 中途打断补测：重跑一次到中途 Ctrl-C → 恢复 → 到达终态，确认无重复 provider 副作用、无状态损坏。
8. 记录：Windows 版本、arch、wukong 版本、repo 类型、终态截图/日志位置。

## B. 五来源真实 Resume smoke

前置：本机装有 Codex、Claude Code、Cursor、Kimi Code、Grok 中对应来源，且在当前 workspace 各有一段真实未完成会话。

对每个来源（codex / claude / cursor / kimi / grok）：

1. `wukong` 进 TUI，`/resume <source>`。
2. picker 检查：
   - [ ] 列出该来源真实本地会话，带来源标签
   - [ ] 原生 ID 搜索能找到目标会话
   - [ ] 当前目录 / 全部目录切换正常
3. 选中后：
   - [ ] 只读导入产生**可编辑** Goal 草稿，未发生任何写操作
   - [ ] 历史声明未被当作当前证据（Gate 仍以当前 Git/测试/review 为准）
4. 确认 `Continue in Wukong`，编辑 Goal 后进入 Preflight，启动 Loop 到终态：
   - [ ] 到达 PASS / NEEDS_WORK / ERROR 之一且 reason 正确
   - [ ] 中途 pause → resume 可恢复
5. 负向抽查（至少一个来源）：损坏 JSONL、workspace mismatch 的会话不导致崩溃，只显示可理解的错误。

## C. 真实 TUI `/loop` 人工 smoke（0.0.12 遗留）

1. TUI 启动 `/loop "<一个真实小目标>"`。
2. 迭代过程中确认 transcript 仍保留高级诊断细节（check 输出、reviewer finding 可展开）。
3. 终态卡片信息分层正确：Gate、主要 blocker、下一步；页脚只有一条紧凑计数。

## D. 0.1.1 发布候选验收

> 只在生成候选资产后执行。工作树测试或本地 `dev:stub` 通过不能替代本节。

1. 记录 exact source commit、package version、catalog identity 和六平台 workflow run。
2. 对 macOS、Linux、Windows 的 x64/ARM64 ZIP 与相邻 SHA-256 逐项核对：
   - [ ] archive 内 `wukong --version` 为 `0.1.1`
   - [ ] provider catalog smoke、基础 Loop、Resume、stop/recovery 通过
   - [ ] 同一平台 ZIP 与 SHA-256 来源一致，provenance 指向 exact source
3. 公开 `0.1.0` 安装后运行 `wukong upgrade`：
   - [ ] 升级到 `0.1.1`，原 config、provider、session 与 Loop records 可读
   - [ ] 恢复 session 后 usage 只显示本次新增量
   - [ ] 跨 workspace 外部 Resume 只提示切换目录，不导入错误项目
4. Fresh install：
   - [ ] installer、下载页和 GitHub Release 都指向同一 `0.1.1` 资产
   - [ ] 首次启动安装引导包含 project、`/provider` 和 `/loop` 下一步
5. Web smoke：
   - [ ] Server token gate 先于 onboarding；token 从 URL hash 清除
   - [ ] 断线/重连状态持续可见且恢复后消失
   - [ ] Session/Workspace 键盘导航、YOLO 确认、Workspace rename 持久化通过
6. 只有以上公开资产与版本面都通过，才能把文档中的“未发布”改为“已发布”。

## 记录模板

```text
日期 / 执行人 / wukong 版本 / 平台
项目类型 / 来源（B 类）
结果：通过 | 失败（附最小复现与日志路径）
TODO 勾选条目：
```
