#!/usr/bin/env bash
# Removes build output: dist, src-tauri/target, src-tauri/gen and packaging/dist.
source "$(dirname "$0")/_lib.sh"
for d in dist src-tauri/target src-tauri/gen packaging/dist; do rm -rf "$d" && ok "removed $d"; done
