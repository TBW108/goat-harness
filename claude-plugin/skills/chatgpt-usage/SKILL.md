---
name: chatgpt-usage
description: Check ChatGPT/OpenAI token usage (today, 7d, 30d, per-model breakdown, last quota errors), switch between models like gpt-6-astra and gpt-6.1-sol, or adjust reasoning effort.
---

# ChatGPT Usage & Model Switching (GOAT Harness)

Use this skill whenever the user asks to check usage ("查看用量", "token usage", "quota"), inspect which ChatGPT models are available, or switch models (`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`, etc.) / reasoning effort (`low | medium | high | xhigh | max | ultra`).

## Check Usage

1. Call MCP tool `goat_usage` (or run `goat-login usage` / `goat-claude --usage` via `Bash`).
2. Present both:
   - **Exact local token usage** recorded by GOAT Harness (`today`, `last7Days`, `last30Days`, `allTime`, and per-model breakdown in `byModel`, plus `lastQuotaError` if any HTTP 429 occurred).
   - **Server-side ChatGPT weekly quota UI**: `https://chatgpt.com/#settings`. Clearly note that OpenAI Sign-in-with-ChatGPT OAuth tokens (`chatgpt.tokens.use.direct`) cannot query OpenAI's server-side remaining percentage quota via API.

## Switch Models (`gpt-6-astra`, `gpt-6.1-sol`, etc.)

- **Live inside an active `goat-claude` session**:
  - `/model opus` -> `gpt-6-astra` (when listed)
  - `/model sonnet` -> `gpt-6.1-sol`
  - `/model haiku` -> `gpt-6-luna`
  - `/model <slug>` -> exact OpenAI slug (for example `/model gpt-6-astra` or `/model gpt-6.1-terra`)
- **Persist default across sessions**:
  - Call MCP `goat_list_models` then `goat_set_model` with `{"model": "gpt-6-astra", "reasoning_effort": "high"}`
  - Or run CLI: `goat-login set-model gpt-6-astra --effort high`
  - Or launch one session with: `goat-claude --goat-model gpt-6-astra --effort xhigh`
