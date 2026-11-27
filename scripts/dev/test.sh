#!/usr/bin/env bash
# Runs the engine, CLI and backup tests. Pass a name to filter, e.g. ./test.sh ospf
# Add --watch to re-run on every change.
source "$(dirname "$0")/_lib.sh"
need_deps
if [[ "${1:-}" == "--watch" ]]; then shift; run npx vitest "$@"; else run npx vitest run "$@"; fi
