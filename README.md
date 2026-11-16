# GOAT Harness

Use your **OpenAI ChatGPT subscription** (`Sign in with ChatGPT`) directly inside **Claude Code** — with native `/model` picking, `/effort` control, streaming tool use, built-in `web_search`, local token usage tracking, and one-command reversible global installation.

## Features

- **Official ChatGPT OAuth 2.0 + PKCE** — Signs in with your ChatGPT Plus / Pro / Business subscription (`dynamic_agent_client` + `chatgpt.tokens.use.direct`) without manual cookie extraction or Anthropic `/login`.
- **Deep Claude Code `/model` & `/effort` Integration** — Dynamically syncs your live ChatGPT model catalog (e.g. `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`), hides built-in Anthropic entries cleanly (`replaceBuiltInOptions: true`), maps Claude tier aliases (`opus` → `gpt-6-astra`, `sonnet` → `gpt-6.1-sol`, `haiku` → `gpt-6-luna`), and supports `low` / `medium` / `high` / `xhigh` / `max` reasoning effort.
- **Full Protocol Translation (`Anthropic /v1/messages` ↔ `OpenAI /v1/responses`)** — Handles SSE streaming with 10s keepalive pings, tool calls, interrupted (`Esc`) turn reconciliation, multimodal image/PDF inputs, OpenAI `web_search`, prompt cache/reasoning token telemetry, and automatic HTTP 400 fallback handling.
- **Persistent Loopback Proxy Daemon** — Runs `goat-proxy` on `127.0.0.1` (auto-managed via macOS `LaunchAgent` or background PID) while respecting `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and macOS `scutil` system proxy settings (e.g. Clash).
- **100% Reversible Installation** — Snapshots your pre-install `~/.claude/settings.json` keys once before editing anything, so uninstalling cleanly restores vanilla Claude Code.

## Prerequisites

- **Node.js >= 22**
- **Claude Code CLI** (`npm i -g @anthropic-ai/claude-code`)
- **ChatGPT Subscription** (Plus, Pro, or Business)

## Installation

### Option 1: Global Install (Recommended — use bare `claude` everywhere)

```bash
git clone https://github.com/TBW108/goat-harness.git
cd goat-harness

# Link global CLIs, sign in with ChatGPT in your browser, start the proxy daemon,
# and configure ~/.claude/settings.json globally
npm run install:claude
```

Once installed, run `claude` from **any directory** — no Anthropic `/login` or API key needed:

```bash
cd /path/to/any/project
claude
```

You can also customize the initial default model or reasoning depth during installation (or re-run anytime without overwriting your original pre-install backup):

```bash
goat-claude install --model gpt-6-astra --effort high
```

**What installation sets up:**
- Links global CLI commands (`goat-claude`, `goat-login`, `goat-proxy`) via `npm link`.
- Saves a verbatim pre-install snapshot in `~/.goat-harness/claude-install-backup.json` (only on first install, so repeated `install` calls never clobber your original settings).
- Starts the background loopback proxy daemon (`goat-proxy` on `127.0.0.1`, auto-started via macOS `LaunchAgent` `com.goat-harness.proxy`).
- Updates `~/.claude/settings.json` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `model`, `effortLevel`, `modelPicker`, tier mappings, `permissions.defaultMode`, and `NO_PROXY`) while leaving all unrelated plugins and settings intact.
- Links `~/.claude/skills/chatgpt-login` and `~/.claude/skills/chatgpt-usage`, and registers user-scoped MCP `goat-harness-claude`.

### Option 2: Ephemeral Mode (Zero Changes to `~/.claude/settings.json`)

Want to try it without modifying your global Claude Code configuration? Launch an isolated session that spins up a temporary local proxy only for that run:

```bash
npm run claude
# or after linking:
goat-claude --goat-model gpt-6-astra --effort xhigh
```

## Uninstalling & Restoring Vanilla Claude Code

Uninstalling cleanly **reverses every change made to Claude Code** and returns bare `claude` to its exact original Anthropic configuration:

```bash
# 1. Restore original Claude Code (keeps ~/.goat-harness/ login & usage history for later)
goat-claude uninstall

# Or uninstall completely (also deletes ~/.goat-harness/ and unlinks global CLI commands)
goat-claude uninstall --purge --unlink
```

If you never linked global binaries (or already unlinked them), run the equivalent script inside the cloned repo:

```bash
npm run uninstall:claude
# or full cleanup:
npm run uninstall:claude -- --purge --unlink
```

**What uninstalling reverts:**
1. **Stops and removes the background proxy daemon** (`goat-proxy`) and unloads/deletes the macOS `LaunchAgent`.
2. **Restores `~/.claude/settings.json` verbatim** from `~/.goat-harness/claude-install-backup.json`:
   - Restores every original `env` key (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `NO_PROXY`, etc.), top-level `model`, `effortLevel`, `modelPicker`, and `permissions.defaultMode` — or deletes keys that did not exist before install.
   - If `~/.claude/settings.json` did not exist prior to installation and no other keys remain, deletes `~/.claude/settings.json` cleanly.
3. **Removes injected skills & MCP**: unlinks `~/.claude/skills/chatgpt-login` and `~/.claude/skills/chatgpt-usage`, and runs `claude mcp remove -s user goat-harness-claude`.
4. **With `--purge --unlink`**: deletes `~/.goat-harness/` (OAuth tokens, local usage ledger, backup) and runs `npm unlink -g goat-harness` to remove `goat-claude`, `goat-login`, and `goat-proxy` from `PATH`.

After uninstalling, running `claude` immediately talks directly to Anthropic again using your original Claude Code settings.

## CLI Reference

### Status, Models, Auth & Usage

```bash
goat-claude status                # Check install state, daemon health, auth, active model & usage
goat-claude --models              # Quick list of available ChatGPT models
goat-claude --usage               # Quick local token usage summary

goat-login login                  # Authenticate with ChatGPT via browser OAuth
goat-login models                 # List models with context windows & supported reasoning efforts
goat-login set-model <slug> --effort <low|medium|high|xhigh|max|ultra>
goat-login usage                  # Detailed local token ledger + ChatGPT quota settings URL
goat-login logout                 # Clear stored ChatGPT OAuth tokens
```

### Proxy Daemon

```bash
goat-proxy start | stop | restart | status | logs
```

### Inside Claude Code

- `/model` — Switch between GPT models and adjust reasoning effort with `←` / `→`
- `/effort <level>` — Set reasoning depth (`low`, `medium`, `high`, `xhigh`, `max`)
- `/chatgpt-login` and `/chatgpt-usage` — Installed Claude Code skills
- `Shift+Tab` — Cycle permission modes (`acceptEdits` / `plan` / `auto mode`)

## Architecture

```text
claude CLI ──(Anthropic /v1/messages)──▶ goat-proxy (127.0.0.1) ──(OpenAI /v1/responses + ChatGPT OAuth)──▶ ChatGPT Codex Backend
```

`goat-claude install` configures `~/.claude/settings.json` so `claude` routes Anthropic Messages API requests to `goat-proxy`, which translates prompts, schemas, tools, multimodal blocks, and streaming SSE events to OpenAI's Responses API using your ChatGPT subscription OAuth token.

## Development & Security

```bash
npm test   # Runs the full offline test suite via Node's built-in test runner
```

- OAuth credentials and settings are stored under `~/.goat-harness/` (`0700` directory, `0600` files, protected by a cross-process refresh lock). Override the storage directory with `GOAT_HARNESS_HOME`.
- Intended strictly for interactive personal development under your own ChatGPT subscription terms.

## License

MIT
