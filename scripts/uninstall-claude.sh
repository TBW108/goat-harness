#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

exec node "${REPO_DIR}/bin/goat-claude.mjs" uninstall "$@"
