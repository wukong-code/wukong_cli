# Wukong Code 文档

> 当前发布版本：`0.0.21`

Wukong Code 的主流程是 **Goal → Write → Check → Review → Fix**。当前文档
只索引已经发布或已经实现的能力。

## 开始使用

- [用户指南](user-guide.md)
- [0.0.21 发布说明](releases/0.0.21.md)
- [0.0.21 Loop Evidence Integrity](design/0.0.21-loop-evidence-integrity.md)
- [CLI 更新与公告](operations/updates-and-announcements.md)
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

## 当前主要命令

```text
wukong
wukong -p
wukong provider
wukong loop
wukong review
wukong guard
wukong login
wukong doctor
wukong export
wukong vis
wukong upgrade
```

完整命令和参数以 `wukong --help` 为准。

## 开发文档

- [apps/wukong 开发指南](../apps/wukong/AGENTS.md)
- [技术架构](tech/architecture.md)
- [贡献指南](../CONTRIBUTING.md)
- [执行层 TODO](../TODO.md)
