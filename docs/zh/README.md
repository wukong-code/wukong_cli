# Wukong Code 文档

> 当前 stable 版本：`0.2.0`（Standalone Gate & Proof Foundation）
>
> 候选证据：[`0.1.0-rc.1`](https://github.com/wukong-code/wukong-code/releases/tag/v0.1.0-rc.1)
> immutable prerelease 已通过六平台验收
>
> 当前版本说明：[`0.2.0 Standalone Gate & Proof Foundation`](releases/0.2.0.md)

0.2.0 在[可控、可恢复、可解释的 Trusted Local Loop](../design/0.1.0-trusted-local-loop.md)基础上推出独立验收与交付证明主线命令
（`wukong init`、`wukong provider test`、`wukong check`、`wukong gate`、`wukong summary`）、三级 CLI/TUI 命令面收敛以及无头单确认 run-plan，并保持 MIT 免费、本地优先、BYOK 边界不变。官网后端、账号与运营服务保持私有。

Wukong Code 的主流程是 **Goal / Change → Check → Fresh Review → Proof Card (`PASS` / `NEEDS_WORK` / `ERROR`)**。下方“已发布”
描述当前 `0.2.0` stable；标成“开发 checkout”的命令和行为仍以当前源码为准。

本地 CLI 已以 MIT 许可开源（`v0.2.0`），官网后端保持私有。
公开文档只维护使用方式、技术设计、兼容性和隐私合同；商业与运营材料独立私有留存。

## 开始使用

- [用户指南](user-guide.md)
- [0.2.0 Standalone Gate & Proof Foundation 发布说明](releases/0.2.0.md)
- [0.1.2 Open-Source Edition 发布说明](releases/0.1.2.md)
- [0.1.1 Reliability And Trust Boundary 发布说明](releases/0.1.1.md)
- [0.1.0 发布说明](releases/0.1.0.md)
- [0.0.22 发布说明](releases/0.0.22.md)
- [0.1.0-rc.1 候选说明（公开固定版本安装）](releases/0.1.0-rc.1.md)
- [0.1.0 Trusted Local Loop](../design/0.1.0-trusted-local-loop.md)
- [0.0.21 Loop Evidence Integrity](../design/0.0.21-loop-evidence-integrity.md)
- [CLI 更新与公告](operations/updates-and-announcements.md)
- [CLI telemetry 字段、endpoint、retention 与 opt-out](operations/cli-telemetry.md)
- [自动化测试计划](../test/verification-cli-test-plan.md)

## 已发布的核心能力

- [Loop-first verification](../design/verification-loop-v2.md)
- [Structured review findings](../design/review-learning-loop.md)
- [Cross-Agent Resume](../design/0.0.14-resume-loop-polish.md)
- [Durable Loop lifecycle](../design/0.0.15-loop-reliability.md)
- [Loop convergence](../design/0.0.16-loop-convergence.md)
- [Command surface reliability](../design/0.0.17-command-surface-reliability.md)
- [Loop-first simplification](../design/0.0.18-loop-first-simplification.md)
- [Explicit Finish Line](../design/0.0.19-explicit-finish-line.md)
- [Reusable Verification Criteria](../design/0.0.20-reusable-verification-skills.md)
- [Loop Evidence Integrity](../design/0.0.21-loop-evidence-integrity.md)

## 当前开发 checkout 的主要命令

```text
wukong init
wukong check
wukong gate
wukong summary
wukong loop
wukong provider
wukong doctor
wukong upgrade
```

完整命令和参数以 `wukong --help` / `wukong help --all` 为准。
公开 `0.1.1` 与历史 opt-in `0.1.0-rc.1` 的实际命令面分别以对应安装包中的
`wukong --help` 为准。

## 开发文档

- [apps/wukong 开发指南](https://github.com/wukong-code/wukong_cli/blob/main/apps/wukong/AGENTS.md)
- [技术架构](../tech/architecture.md)
- [贡献指南](https://github.com/wukong-code/wukong_cli/blob/main/CONTRIBUTING.md)
- [执行层 TODO](../../TODO.md)
