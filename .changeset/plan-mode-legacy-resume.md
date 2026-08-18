---
"@wukong/agent-core": patch
"@wukong/wukong-sdk": patch
"@wukong.today/code": patch
---

Keep plan mode active when resuming a session whose legacy plan record has no plan data, instead of silently reporting plan mode as off. Status now reflects the real plan-mode state rather than whether plan content exists.
