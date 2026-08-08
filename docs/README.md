# Wukong Code 文档

> 当前 stable 版本：`0.0.22`
>
> opt-in prerelease：[`0.1.0-rc.1`](https://github.com/mutnpc/wukong-code/releases/tag/v0.1.0-rc.1)
> 已公开并通过六平台验收；默认 installer 继续指向 `0.0.22`

0.1.0 的唯一当前设计是[可控、可恢复、可解释的 Trusted Local Loop](design/0.1.0-trusted-local-loop.md)：
Preflight 成本上限、no-check、文件归因、终态、恢复兼容和最小 Gate
completeness/freshness 已实现并通过自动化；六平台候选与公开资产验收也已通过。
当前仍需真实来源流程、opt-in cohort 和 14 天稳定窗口，不能据此称为正式版。完整多层
coverage schema 与 direct-shell attestation 后移。

Wukong Code 的主流程是 **Goal → Write → Check → Review → Fix**。下方“已发布”
只描述 `0.0.22`；标成“开发 checkout”的命令和行为只有从当前源码构建时才可用，
不能据此推断公开安装包已经包含这些能力。

## 开始使用

- [用户指南](user-guide.md)
- [0.0.22 发布说明](releases/0.0.22.md)
- [0.1.0-rc.1 候选说明（公开固定版本安装）](releases/0.1.0-rc.1.md)
- [0.1.0 Trusted Local Loop（RC 验证中）](design/0.1.0-trusted-local-loop.md)
- [0.0.21 Loop Evidence Integrity](design/0.0.21-loop-evidence-integrity.md)
- [CLI 更新与公告](operations/updates-and-announcements.md)
- [CLI telemetry 字段、endpoint、retention 与 opt-out](operations/cli-telemetry.md)
- [自动化测试计划](test/verification-cli-test-plan.md)

## 已发布的核心能力

- [Loop-first verification](design/verification-loop-v2.md)
- [Structured review findings](design/review-learning-loop.md)
- [Cross-Agent Resume](design/0.0.14-resume-loop-polish.md)
- [Durable Loop lifecycle](design/0.0.15-loop-reliability.md)
- [Loop convergence](design/0.0.16-loop-convergence.md)
- [Command surface reliability](design/0.0.17-command-surface-reliability.md)
- [Loop-first simplification](design/0.0.18-loop-first-simplification.md)
- [Explicit Finish Line](design/0.0.19-explicit-finish-line.md)
- [Reusable Verification Criteria](design/0.0.20-reusable-verification-skills.md)
- [Loop Evidence Integrity](design/0.0.21-loop-evidence-integrity.md)

## 当前开发 checkout 的主要命令

```text
wukong
wukong -p
wukong provider
wukong loop
wukong review
wukong guard
wukong login
wukong logout
wukong doctor
wukong export
wukong vis
wukong upgrade
```

完整命令和参数以 `wukong --help` 为准。
公开 `0.0.22` 与 opt-in `0.1.0-rc.1` 的实际命令面分别以对应安装包中的
`wukong --help` 为准。

## 开发文档

- [apps/wukong 开发指南](../apps/wukong/AGENTS.md)
- [技术架构](tech/architecture.md)
- [贡献指南](../CONTRIBUTING.md)
- [执行层 TODO](../TODO.md)
