Call this tool after you have modified code and before you tell the user the task is complete.

It runs deterministic checks (lint, typecheck, tests, build if requested) and scans the git diff for risks such as TODOs, placeholders, skipped tests, secret-looking files, or source changes without test changes.

Parameters:
- `cwd`: optional working directory. Defaults to the current session directory.
- `commands`: optional explicit commands to run. If omitted, Wukong auto-detects package scripts.
- `includeBuild`: include the build script when auto-detecting commands.
- `writeReport`: write a Markdown evidence report to the workspace (default true).
- `reportPath`: custom path for the report.
- `timeoutSeconds`: per-command timeout (default 300, max 3600).
- `strict`: treat any risk as a failed verification.

Output:
- `status`: `passed`, `warning`, or `failed`.
- `changedFiles`: number of changed files.
- `commandsRun` / `failedCommands`: counts.
- `risksFound` / `highRisks`: counts.
- Per-command results and risk list.
- `reportPath` when a report is written.
- A `structured_summary` JSON block.

Rules:
- If status is `failed`, you MUST NOT claim the task is done. Fix the failures and call again.
- If status is `warning` with high-severity risks, explain to the user why each warning is acceptable before claiming done.
- If status is `passed`, you may summarize the verification in your final response.
