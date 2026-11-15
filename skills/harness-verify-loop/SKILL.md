---
name: harness-verify-loop
description: >-
  Execute a disciplined Claude-Code-style Explore -> Plan -> Implement -> Verify -> Fix loop
  in Antigravity, optionally pairing with an OpenAI second-opinion review before finalizing.
  Use for non-trivial multi-file features, bug fixes, or refactors where verification rigor matters.
---

# Harness Verification Loop

Bring Claude Code's disciplined agent harness loop into Antigravity's native Gemini workflow:

## 1. Explore First
- Locate relevant symbols, entry points, and test files before editing.
- Read only the targeted functions/blocks needed to understand contracts and invariants.

## 2. Plan & Bound Scope
- Identify exact files to modify, edge cases, and the verification command that proves correctness (`npm test`, `pytest`, `cargo test`, `go test`, typecheck, etc.).

## 3. Implement Cleanly
- Keep edits minimal, modular, and consistent with existing repository helpers and conventions.

## 4. Verify & Cross-Check
- Run the relevant tests and linters after your final edit and confirm all cases pass.
- For high-risk or complex changes, optionally call `goat_review_with_openai` (if GOAT Harness is connected) for an independent ChatGPT-backed review before concluding.
- If GOAT Harness's Stop verification gate asks you to continue because source files changed without a passing test run, run the verification command and fix any failures before ending the turn.
