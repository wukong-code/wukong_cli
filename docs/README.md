# Wukong Code 文档索引

> 最后更新: 2026-07-02
> 当前事实基线: `wukong_cli` 内部实现仓库，产品名称为 **Wukong Code**
> 状态说明: 本目录区分 **当前已实现** 与 **商业化后续待实现**。

## 当前已实现

这些文档可以作为当前 Wukong Code 的事实来源：

- [用户指南](user-guide.md)
  只描述当前 top-level CLI 能力、源码运行方式和本地数据位置。
- [apps/wukong 开发指南](../apps/wukong/AGENTS.md)
  描述当前 CLI/TUI app 的文件边界和代码约定。
- [根 README](../README.md) / [中文 README](../README.zh-CN.md)
  面向仓库入口的当前能力说明。

当前可用 top-level commands 以 `wukong --help` 为准，主要包括：

```text
wukong
wukong -p
wukong provider
wukong acp
wukong server
wukong web
wukong verify
wukong scan
wukong guard
wukong login
wukong doctor
wukong export
wukong vis
wukong migrate
wukong upgrade
```

## 商业化文档

这些文档记录当前 P0 实现和后续计划。`verify`、`scan`、`guard` 已作为 top-level CLI 命令实现；`/verify`、`/scan`、`/guard`、`/report` 已作为 TUI slash commands 实现；`wukong_verify` agent tool 已接入 agent-core。sync/today、云端报告、计费和团队能力仍是后续工作：

- [商业化与产品重构方案](business/COMMERCIAL_REFACTOR_PLAN.md)
  定义产品定位、商业模型、目标命令结构和路线图。
- [商业化重构技术实现方案](tech/commercial-refactor-implementation.md)
  定义 `@wukong/verification`、`wukong verify`、`wukong scan`、`wukong guard`、agent tool 的实现方案。
- [最新技术架构](tech/architecture.md)
  定义当前新 Kimi-code base 与 P0 verification/guard 架构。
- [产品设计文档](design/design.md)
  定义未来验证型产品的交互、成长体系和命令设计。
- [登录与同步验收计划](test/test-login-sync.md)
  记录登录与同步能力进入实现阶段前应满足的验收条件。
- [Verification CLI 自动化测试计划](test/verification-cli-test-plan.md)
  记录 `verify`、`scan`、`guard`、TUI slash commands 和 `wukong_verify` 的核心测试、CLI smoke 和后续测试 TODO。

## 当前最高优先级 TODO

1. 实现 report history / redaction metadata，避免未来云端报告上传源码 diff 或敏感片段。
2. 统一发布渠道、package version、安装文档和收费边界。
3. 实现 sync/today 时先定义本地数据模型和 redaction 边界。
4. 在文档站重新发布前，补齐实际页面或保持当前单层文档结构，不再链接不存在的 `/en/guides/*`、`/zh/guides/*`。
