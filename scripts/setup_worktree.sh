#!/usr/bin/env bash
set -euo pipefail

MAIN_REPO="/Users/user/Desktop/Work/CodeRepo/TimeMachineWeb"
CURRENT_DIR="$(pwd)"

if [ "$CURRENT_DIR" = "$MAIN_REPO" ]; then
  echo "[setup_worktree] Already in main repository ($MAIN_REPO), skipping symlinks."
  exit 0
fi

echo "[setup_worktree] Initializing worktree at $CURRENT_DIR ..."

if [ -d "$MAIN_REPO/node_modules" ] && [ ! -e "./node_modules" ]; then
  ln -sfn "$MAIN_REPO/node_modules" ./node_modules
  echo "  -> Linked node_modules"
fi

if [ -d "$MAIN_REPO/DPlanet" ] && [ ! -e "./DPlanet" ]; then
  ln -sfn "$MAIN_REPO/DPlanet" ./DPlanet
  echo "  -> Linked DPlanet"
fi

if [ -d "$MAIN_REPO/data/generated" ] && [ ! -e "./data/generated" ]; then
  mkdir -p ./data
  ln -sfn "$MAIN_REPO/data/generated" ./data/generated
  echo "  -> Linked data/generated"
fi

echo "[setup_worktree] Done."
