#!/usr/bin/env bash
# Everything CI checks: types, tests, web build, Rust format, lint and tests.
# Use --fast to stop after types and tests.
source "$(dirname "$0")/_lib.sh"
need_deps
step "Type check";  run npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
step "Tests";       run npx vitest run
[[ "${1:-}" == "--fast" ]] && { ok "Fast checks passed"; exit 0; }
step "Web build";   run npx vite build
if have cargo; then
  step "Rust shell"
  (cd src-tauri && run cargo fmt --check && run cargo clippy --all-targets -- -D warnings && run cargo test)
else
  warn "cargo not found, skipping the Rust checks"
fi
ok "All checks passed"
