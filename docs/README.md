# Wukong Code 文档

> 当前 stable 版本：`0.1.1`
>
> 候选证据：[`0.1.0-rc.1`](https://github.com/mutnpc/wukong-code/releases/tag/v0.1.0-rc.1)
> immutable prerelease 已通过六平台验收
>
> 当前版本说明：[`0.1.1 Reliability And Trust Boundary`](releases/0.1.1.md)

0.1.1 延续[可控、可恢复、可解释的 Trusted Local Loop](design/0.1.0-trusted-local-loop.md)：
Preflight usage 上限、no-check、文件归因、终态、恢复兼容和最小 Gate
completeness/freshness 已实现并通过自动化；`v0.1.0` 六平台资产、公开
安装/升级/恢复和生产版本面验收已完成。真实来源流程与 opt-in cohort 继续作为
发布后产品学习，不设置固定等待门槛。完整多层 coverage schema 与 direct-shell
attestation 后移。

Wukong Code 的主流程是 **Goal → Write → Check → Review → Fix**。下方“已发布”
描述当前 `0.1.1` stable；标成“开发 checkout”的命令和行为仍以当前源码为准。

## 开始使用

- [用户指南](user-guide.md)
- [0.1.1 Reliability And Trust Boundary 发布说明](releases/0.1.1.md)
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
公开 `0.1.1` 与历史 opt-in `0.1.0-rc.1` 的实际命令面分别以对应安装包中的
`wukong --help` 为准。

## 开发文档

- [apps/wukong 开发指南](../apps/wukong/AGENTS.md)
- [技术架构](tech/architecture.md)
- [贡献指南](../CONTRIBUTING.md)
- [执行层 TODO](../TODO.md)
