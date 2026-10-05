#!/usr/bin/env bash
# Deploys the last COMMITTED state of this repo to Fly (app: ramherd-app).
# Uncommitted edits never ship, so other agents' half-done work stays local.
# Usage: scripts/deploy.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "note: uncommitted changes exist and will NOT be deployed:"
  git status -s --untracked-files=no
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive HEAD | tar -x -C "$tmp"
echo "deploying $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
fly deploy "$tmp" --config "$tmp/fly.toml" --app ramherd-app --remote-only
curl -fsS https://ramherd-app.fly.dev/api/health && echo
