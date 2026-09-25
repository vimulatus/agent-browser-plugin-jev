#!/usr/bin/env bash
# Installs what `pnpm test` needs: pnpm (the version package.json pins, through
# corepack) and the package's dependencies. Safe to run again.
#
# The cloud environment script owns the machine: Node 24, gh, bun, ffmpeg,
# agent-browser and its Chrome. It runs once per cached image, and its
# SessionStart hook puts Node 24 first on PATH before it runs this script.
set -euo pipefail

cd "$(dirname "$0")/../.."

# Node 25 dropped corepack; there, the pnpm already on PATH does the install.
if command -v corepack >/dev/null; then corepack enable; fi
pnpm install --frozen-lockfile

echo "setup: node $(node -v), pnpm $(pnpm -v)"
