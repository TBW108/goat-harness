#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/goat-harness"

mkdir -p "${HOME}/.gemini/config/plugins"

if [ -L "${TARGET_DIR}" ]; then
  CURRENT="$(readlink "${TARGET_DIR}")"
  if [ "${CURRENT}" = "${REPO_DIR}" ]; then
    echo "GOAT Harness plugin is already linked at ${TARGET_DIR} -> ${REPO_DIR}"
    exit 0
  fi
  echo "Updating symlink ${TARGET_DIR} -> ${REPO_DIR}"
  ln -sfn "${REPO_DIR}" "${TARGET_DIR}"
elif [ -e "${TARGET_DIR}" ]; then
  echo "Error: ${TARGET_DIR} already exists and is not a symlink. Remove or rename it first." >&2
  exit 1
else
  ln -s "${REPO_DIR}" "${TARGET_DIR}"
  echo "Linked GOAT Harness plugin: ${TARGET_DIR} -> ${REPO_DIR}"
fi
