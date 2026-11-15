# GOAT Harness Rules

When the `goat-harness` plugin is enabled, Antigravity retains its native Gemini model for primary orchestration while gaining optional OpenAI ChatGPT-subscription delegation via Claude Code's harness and stricter verification discipline.

## Using Claude Code Harness + OpenAI Subscription

- Use `goat_status` to check whether the user has connected their ChatGPT subscription via **Sign in with ChatGPT** and verify `claude` CLI availability before delegating.
- If ChatGPT is not signed in yet, surface the **GOAT Harness** sidecar auxiliary panel link `[GOAT Harness](sidecar://goat-harness/goat_harness_ui/)` (when running as a plugin sidecar) or instruct the user to click **Sign in with ChatGPT** in the GOAT Harness panel.
- Use `goat_review_with_openai` (`plan` read-only mode) when the user asks for an OpenAI second opinion, pre-commit code review, or bug/security audit across changes.
- Use `goat_run_claude_harness` when the user explicitly asks to execute an implementation, refactoring, or debugging task through the Claude Code harness powered by an OpenAI model.
- Always inspect and verify any files modified by `goat_run_claude_harness` before reporting completion to the user.

## Verification Discipline

- After modifying source files, always run the project's test, lint, or typecheck command before finishing.
- Never report tests or checks as passing unless you observed the command exit cleanly after your final edit.
