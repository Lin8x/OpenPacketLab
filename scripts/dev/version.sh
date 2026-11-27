#!/usr/bin/env bash
# Shows or sets the version in package.json, package-lock.json, tauri.conf.json and Cargo.toml.
#   ./version.sh            print it
#   ./version.sh 0.2.0      set it (or: patch, minor, major)
source "$(dirname "$0")/_lib.sh"
[[ $# -eq 0 ]] && { version; exit 0; }
run node scripts/opl.mjs version "$1"
