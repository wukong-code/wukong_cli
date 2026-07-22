---
name: resume-grok
description: Import a selected local Grok session and continue it in Wukong.
disable-model-invocation: true
---

# Resume a Grok session in Wukong

The arguments are trusted Wukong-generated JSON containing `source`, `sessionId`,
`sourcePath`, and `workDir` for the session selected in `/resume`.

1. Parse the JSON. Require `source` to equal `grok` and `sourcePath` to be an
   absolute `chat_history.jsonl` path that resolves under `~/.grok/sessions/`.
   Refuse any other path, symlink escape, or malformed input.
2. Read only top-level `user` and `assistant` chat messages whose content is text.
   Ignore system prompts, reasoning, credentials, auth data, approvals, events,
   terminal logs, memtrace, tool calls, and raw tool results.
3. Briefly state that this is an import into Wukong, not a restart of Grok.
   Summarize the goal, completed work that is supported by chat text, unresolved
   work, and the last user request.
4. Re-read the current workspace and Git state before trusting old claims. Never
   replay tools or assume old checks still pass.
5. Continue the unfinished task in Wukong. Ask a question only when the imported
   history leaves a decision that cannot safely be inferred.

Keep imported transcript excerpts minimal and do not upload or expose the source
path unless the user explicitly asks for it.
