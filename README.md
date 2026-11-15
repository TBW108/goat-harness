# GOAT Harness

Use your **OpenAI ChatGPT subscription** (`Sign in with ChatGPT`) directly inside **Claude Code** — with native `/model` picking, `/effort` control, streaming tool use, built-in `web_search`, local token usage tracking, and one-command reversible global installation.

## Features

- **Official ChatGPT OAuth 2.0 + PKCE** — Signs in with your ChatGPT Plus / Pro / Business subscription (`dynamic_agent_client` + `chatgpt.tokens.use.direct`) without manual cookie extraction or Anthropic `/login`.
- **Deep Claude Code `/model` & `/effort` Integration** — Dynamically syncs your live ChatGPT model catalog (e.g. `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`), hides built-in Anthropic entries cleanly (`replaceBuiltInOptions: true`), maps Claude tier aliases (`opus` → `gpt-6-astra`, `sonnet` → `gpt-6.1-sol`, `haiku` → `gpt-6-luna`), and supports `low` / `medium` / `high` / `xhigh` / `max` reasoning effort.
- **Full Protocol Translation (`Anthropic /v1/messages` ↔ `OpenAI /v1/responses`)** — Handles SSE streaming with 10s keepalive pings, tool calls, interrupted (`Esc`) turn reconciliation, multimodal image/PDF inputs, OpenAI `web_search`, prompt cache/reasoning token telemetry, and automatic HTTP 400 fallback handling.
- **Persistent Loopback Proxy Daemon** — Runs `goat-proxy` on `127.0.0.1` (auto-managed via macOS `LaunchAgent` or background PID) while respecting `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and macOS `scutil` system proxy settings (e.g. Clash).
- **Clean & Reversible Setup** — Backs up pre-install keys in `~/.claude/settings.json` (`~/.goat-harness/claude-install-backup.json`) and restores them verbatim on uninstall.

## Prerequisites

- **Node.js >= 22**
- **Claude Code CLI** (`npm i -g @anthropic-ai/claude-code`)
- **ChatGPT Subscription** (Plus, Pro, or Business)

## Quick Start

```bash
git clone https://github.com/TBW108/goat-harness.git
cd goat-harness

# 1. Link global CLIs, sign in with ChatGPT, start the local proxy daemon,
#    and configure ~/.claude/settings.json globally
npm run install:claude

# 2. Run Claude Code from any directory using your ChatGPT models
cd /path/to/any/project
claude
```

Prefer not to modify `~/.claude/settings.json`? Run an isolated session anytime with:

```bash
npm run claude
# or after linking:
goat-claude --goat-model gpt-6-astra --effort xhigh
```

## CLI Reference

### Global Install & Lifecycle

```bash
goat-claude install [--model <slug>] [--effort <level>]   # Configure Claude Code globally
goat-claude status                                        # Check install, daemon, auth, model & usage
goat-claude uninstall                                     # Stop daemon and restore ~/.claude/settings.json
goat-claude uninstall --purge --unlink                    # Also delete ~/.goat-harness and unlink CLIs
```

### Models, Auth & Usage

```bash
goat-login login                  # Authenticate with ChatGPT via browser OAuth
goat-login models                 # List available ChatGPT models & supported reasoning levels
goat-login set-model <slug> --effort <low|medium|high|xhigh|max|ultra>
goat-login usage                  # Show local token ledger + ChatGPT quota settings URL
goat-login logout                 # Clear stored ChatGPT OAuth tokens

goat-claude --models              # Quick model list
goat-claude --usage               # Quick usage summary
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

`goat-claude install` sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, tier defaults, `modelPicker`, and safe runtime env flags in `~/.claude/settings.json`, while `goat-proxy` stays running locally to translate requests/streams and track local token usage.

## Development & Security

```bash
npm test   # Runs the full offline test suite via Node's built-in test runner
```

- OAuth credentials and settings are stored under `~/.goat-harness/` (`0700` directory, `0600` files, protected by a cross-process refresh lock). Override the storage directory with `GOAT_HARNESS_HOME`.
- Intended strictly for interactive personal development under your own ChatGPT subscription terms.

## License

MIT
