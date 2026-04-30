#!/usr/bin/env bash
# Wrapper so Gemini CLI (and any other MCP client) can start the server
# without needing to pass env vars — credentials are loaded from .env / .env.local.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load credentials from .env / .env.local if not already in environment
for f in "$SERVER_DIR/.env.local" "$SERVER_DIR/.env"; do
  if [[ -f "$f" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$f"
    set +a
    break
  fi
done

exec bun run "$SERVER_DIR/src/index.ts"
