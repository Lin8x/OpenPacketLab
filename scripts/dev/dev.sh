#!/usr/bin/env bash
# Starts the app with hot reload. ./dev.sh        web UI at http://localhost:1420
#                                 ./dev.sh app    desktop window
source "$(dirname "$0")/_lib.sh"
need_deps
if [[ "${1:-web}" == app ]]; then run npx tauri dev; else run npx vite; fi
