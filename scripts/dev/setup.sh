#!/usr/bin/env bash
# Installs npm dependencies (clean install from package-lock.json).
source "$(dirname "$0")/_lib.sh"
run npm ci --no-audit --no-fund
ok "Dependencies installed. Next: ./scripts/dev/test.sh"
