---
name: resume-kimi
description: Import the last request from a selected local Kimi Code session and continue it in Wukong.
disable-model-invocation: true
---

# Resume a Kimi Code request in Wukong

The arguments are trusted Wukong-generated JSON containing `source`, `sessionId`,
`sourcePath`, and `workDir` for the session selected in `/resume`.

1. Parse the JSON. Require `source` to equal `kimi` and `sourcePath` to resolve
   under `~/.kimi-code/`. Accept only the selected session `state.json` or a
   `.jsonl` file under `user-history`. Refuse any other path, symlink escape, or
   malformed input.
2. Treat Kimi Code data as request history, not a complete transcript. Read only
   the bounded `content` strings from the selected user-history JSONL, or
   `lastPrompt` from the selected state file. Do not claim assistant messages,
   completed work, or test results were imported.
3. Briefly state that Wukong recovered the last request, not the full Kimi Code
   conversation. Summarize the latest request without exposing the local path.
4. Re-read the current workspace and Git state. Never replay old tools,
   permissions, approvals, or assumed test results.
5. Continue the unfinished task in Wukong. Ask a question only when the recovered
   request leaves a decision that cannot safely be inferred.

Keep excerpts minimal and do not upload or expose the source path unless the user
explicitly asks for it.
