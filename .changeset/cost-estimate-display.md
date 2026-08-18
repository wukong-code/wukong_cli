---
"@wukong/kosong": patch
"@wukong/agent-core": patch
"@wukong/wukong-sdk": patch
"@wukong.today/code": patch
---

Show the estimated provider cost in run and Loop summaries when the embedded catalog snapshot carries pricing for the model used; otherwise keep showing `Cost unavailable`. Estimates are computed offline from per-model token usage and never trigger network requests.
