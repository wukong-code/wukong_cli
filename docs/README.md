# Wukong Code 文档

> 当前 stable 版本：`0.1.0`
>
> 候选证据：[`0.1.0-rc.1`](https://github.com/mutnpc/wukong-code/releases/tag/v0.1.0-rc.1)
> immutable prerelease 已通过六平台验收

0.1.0 的唯一当前设计是[可控、可恢复、可解释的 Trusted Local Loop](design/0.1.0-trusted-local-loop.md)：
Preflight 成本上限、no-check、文件归因、终态、恢复兼容和最小 Gate
completeness/freshness 已实现并通过自动化；六平台候选与公开资产验收也已通过。
stable 仍需对 `v0.1.0` exact assets、公开安装/升级/恢复和生产版本面完成验收。真实来源
流程与 opt-in cohort 转为发布后产品学习，不设置固定 14 天等待门槛。完整多层
coverage schema 与 direct-shell attestation 后移。

Wukong Code 的主流程是 **Goal → Write → Check → Review → Fix**。下方“已发布”
描述当前 `0.1.0` stable；标成“开发 checkout”的命令和行为仍以当前源码为准。

## 开始使用

- [用户指南](user-guide.md)
- [0.1.0 发布说明](releases/0.1.0.md)
- [0.0.22 发布说明](releases/0.0.22.md)
- [0.1.0-rc.1 候选说明（公开固定版本安装）](releases/0.1.0-rc.1.md)
- [0.1.0 Trusted Local Loop](design/0.1.0-trusted-local-loop.md)
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
公开 `0.1.0` 与历史 opt-in `0.1.0-rc.1` 的实际命令面分别以对应安装包中的
`wukong --help` 为准。

## 开发文档

- [apps/wukong 开发指南](../apps/wukong/AGENTS.md)
- [技术架构](tech/architecture.md)
- [贡献指南](../CONTRIBUTING.md)
- [执行层 TODO](../TODO.md)
