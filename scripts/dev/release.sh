#!/usr/bin/env bash
# Cuts a release from a clean main branch:
#   runs every check, sets the version, dates CHANGELOG.md, commits, tags vX.Y.Z and pushes.
# GitHub Actions then builds the installers, the Docker image and publishes the release.
#   ./release.sh 0.1.0           (or: patch, minor, major)
#   ./release.sh 0.1.0 --dry     do everything locally but don't push (undo: see the message)
#   ./release.sh 0.1.0 --skip-checks
source "$(dirname "$0")/_lib.sh"
[[ $# -ge 1 ]] || die "Usage: ./scripts/dev/release.sh <version|patch|minor|major> [--dry] [--skip-checks]"
target="$1"; shift
dry=0; checks=1
for a in "$@"; do
  case "$a" in --dry) dry=1 ;; --skip-checks) checks=0 ;; *) die "Unknown option: $a" ;; esac
done
[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || die "Switch to main first"
[[ -z "$(git status --porcelain)" ]] || die "Commit or stash your changes first"
run git pull --ff-only origin main
(( checks )) && "$ROOT/scripts/dev/check.sh"
args=("$target" --skip-checks)
(( dry )) && args+=(--no-push)
run node scripts/opl.mjs release "${args[@]}"
v="$(version)"
if (( dry )); then
  warn "Dry run: v$v is tagged locally only."
  echo "  Push it:  git push origin main v$v"
  echo "  Undo it:  git tag -d v$v && git reset --hard HEAD~1"
else
  ok "Released v$v. Watch the build: https://github.com/Lin8x/OpenPacketLab/actions/workflows/release.yml"
fi
