#!/usr/bin/env bash
# Installs what `pnpm test` and a real run need: Node >= 24, pnpm (the version
# package.json pins, through corepack), the package's dependencies, and the
# Chrome that agent-browser drives. Safe to run again.
#
# Node 24, not 22: behind a proxy that sets NODE_USE_ENV_PROXY, Node 22 prints
# an EnvHttpProxyAgent warning on stderr, and the tests that expect an empty or
# exact stderr fail.
set -euo pipefail

cd "$(dirname "$0")/../.."

NODE_MAJOR=24

if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]; then
  export NVM_DIR="${NVM_DIR:-/opt/nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "setup: node >= $NODE_MAJOR is not on PATH and nvm is not at $NVM_DIR" >&2
    exit 1
  fi
  # nvm.sh reads unset variables, so -u is off while it runs.
  set +u
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR" >/dev/null
  nvm alias default "$NODE_MAJOR" >/dev/null
  NODE_BIN="$(dirname "$(nvm which "$NODE_MAJOR")")"
  set -u
  export PATH="$NODE_BIN:$PATH"
  # Carries the new PATH into the session's later shells.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
fi

corepack enable
pnpm install --frozen-lockfile

if command -v agent-browser >/dev/null; then
  agent-browser install
else
  echo "setup: agent-browser is not on PATH; runs need it, tests do not" >&2
fi

echo "setup: node $(node -v), pnpm $(pnpm -v), $(agent-browser --version 2>/dev/null || echo 'no agent-browser')"
