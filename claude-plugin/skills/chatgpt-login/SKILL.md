---
name: chatgpt-login
description: Sign in to your OpenAI ChatGPT subscription (OAuth PKCE), inspect login status, list or choose ChatGPT models, and sign out from inside Claude Code.
---

# Sign in with ChatGPT (inside Claude Code)

Use this skill whenever the user wants to sign in to ChatGPT, check ChatGPT subscription status, list/select ChatGPT models, or sign out while inside Claude Code.

> **Note:** If you do not have an Anthropic account signed in to Claude Code, launch Claude Code via `goat-claude` (`npm run claude`) rather than bare `claude` so Claude Code skips Anthropic's `/login` gate and routes through your ChatGPT subscription proxy.

## Preferred Flow (via `goat-harness-claude` MCP Tools)

1. **Check current status first**:
   - Call `goat_status`.
   - If `auth.mode === "oauth"` and the user did not ask to switch accounts / re-login, report the connected ChatGPT account (`auth.account.email`, `planType`) and current `settings.defaultModel`, and optionally call `goat_list_models`.

2. **Start Sign in with ChatGPT**:
   - Call `goat_login_chatgpt` with `{"action": "start", "open_browser": true}` (add `"force": true` if re-authenticating).
   - Immediately present the returned `auth_url` as a clickable URL in your message so the user can open it if their browser did not focus automatically.
   - Then call `goat_login_chatgpt` with `{"action": "wait", "wait_sec": 180}` to wait for the browser OAuth callback to finish.

3. **Confirm connection & pick model**:
   - When `status === "connected"`, display the signed-in email/plan and the available `models` list (including `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, etc.).
   - If `default_model` is empty or the user wants a specific model (for example `gpt-6-astra`, `gpt-6.1-sol`, or `gpt-6.1-terra`), call `goat_set_model` with `{"model": "<slug>", "reasoning_effort": "medium"}` (supports `low | medium | high | xhigh | max | ultra`).
   - Inside an active `goat-claude` interactive session, you can also switch live via `/model opus` (`gpt-6-astra`), `/model sonnet` (`gpt-6.1-sol`), `/model haiku` (`gpt-6-luna`), or `/model <slug>`.

4. **Check usage (if requested)**:
   - Call `goat_usage` to inspect local per-model & daily token counts and present the ChatGPT Settings link (`https://chatgpt.com/#settings`) for server-side weekly caps.

5. **Sign out (if requested)**:
   - Call `goat_logout_chatgpt`.

## CLI Fallback (if MCP tools are unavailable in the current session)

If `goat_login_chatgpt` / `goat_status` are not registered in the active Claude session, use `Bash` to run the CLI helper (trying `goat-login` on `PATH` first, or locating `bin/goat-login.mjs`):

```bash
goat-login status --json
goat-login login --json
goat-login models --json
goat-login set-model gpt-6-astra --effort high
goat-login usage --json
goat-login logout
```

Note: `goat-login` stores tokens securely (`0600`) in `~/.goat-harness/auth.json` (or `$GOAT_HARNESS_HOME`).
