#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Linking global goat-claude / goat-login / goat-proxy commands..."
if npm link --prefix "$(npm config get prefix)" "$REPO_DIR" >/dev/null 2>&1 || npm link >/dev/null 2>&1; then
  echo "Global binaries linked into $(npm config get prefix)/bin"
else
  echo "Note: could not run \`npm link\` automatically (you may run \`npm link\` later)."
fi

exec node "${REPO_DIR}/bin/goat-claude.mjs" install --no-link "$@"
