#!/usr/bin/env bash
# Shared helpers for the dev scripts. Sourced, not run.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  B=$'\e[1m'; D=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; C=$'\e[34m'; N=$'\e[0m'
else
  B=; D=; R=; G=; Y=; C=; N=
fi
step() { echo "${C}›${N} ${B}$*${N}"; }
ok()   { echo "${G}✓${N} $*"; }
warn() { echo "${Y}•${N} $*"; }
die()  { echo "${R}✗${N} $*" >&2; exit 1; }
run()  { echo "${D}\$ $*${N}"; "$@"; }
have() { command -v "$1" >/dev/null 2>&1; }
need_deps() { [[ -d node_modules ]] || run npm ci --no-audit --no-fund; }
version() { node -p "require('./package.json').version"; }
