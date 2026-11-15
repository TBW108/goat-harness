---
name: claude-harness-delegate
description: >-
  Delegate coding tasks or read-only second-opinion code reviews from Antigravity
  to the Claude Code harness powered by the user's ChatGPT subscription via GOAT Harness MCP tools.
  Use when the user asks to run a task with OpenAI/ChatGPT, get a GPT code review, or use Claude Code's harness inside Antigravity.
---

# Delegate to Claude Code Harness + ChatGPT Subscription

Use this workflow when routing work from Antigravity's primary Gemini agent into GOAT Harness's MCP tools (`goat_status`, `goat_list_models`, `goat_run_claude_harness`, `goat_review_with_openai`).

## Steps

1. **Check connectivity first**
   - Call `goat_status` to verify both `auth.connected` (Sign in with ChatGPT or API key fallback) and `claude.available`.
   - If `auth.connected` is `false`, do not attempt a delegation run. Point the user to the GOAT Harness auxiliary panel (`sidecar://goat-harness/goat_harness_ui/`) so they can complete **Sign in with ChatGPT**.

2. **Confirm model selection (when needed)**
   - Call `goat_list_models` if the user wants a specific OpenAI model slug or if `settings.defaultModel` is empty.

3. **Choose the right delegation mode**
   - **Read-only code review / second opinion**: Call `goat_review_with_openai` with `cwd` set to the workspace root and a clear `focus` (e.g., `"Review uncommitted changes for edge cases, race conditions, and security issues"`).
   - **Coding / refactoring / debugging**: Call `goat_run_claude_harness` with:
     - `cwd`: workspace root
     - `prompt`: crisp goal, constraints, and expected verification command
     - `permission_mode`: `"acceptEdits"` (or `"plan"` if exploratory)
     - `allowed_tools`: restrict bash commands when appropriate (e.g., `["Read", "Edit", "Write", "Glob", "Grep", "Bash(npm test *)"]`)
     - `resume_session_id`: pass the previous `claude_session_id` for follow-up turns.

4. **Verify and reconcile**
   - Inspect changed files and run project tests directly in Antigravity before reporting final completion.
   - Surface concrete file paths, findings, and exact test results.
