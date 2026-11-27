#!/usr/bin/env bash
# Checks that the tools needed to build and test are installed.
source "$(dirname "$0")/_lib.sh"
bad=0
check() { # label, command, required(1/0)
  local out
  if out=$(eval "$2" 2>/dev/null | head -n1) && [[ -n "$out" ]]; then ok "$(printf '%-30s' "$1") ${D}$out${N}"
  elif [[ "$3" == 1 ]]; then echo "${R}✗${N} $(printf '%-30s' "$1") ${D}missing (required)${N}"; bad=1
  else warn "$(printf '%-30s' "$1") ${D}not found (optional)${N}"; fi
}
check "Node.js 20+"           "node --version" 1
check "npm"                   "npm --version" 1
check "git"                   "git --version" 1
check "Rust (cargo)"          "cargo --version" 0
check "Docker"                "docker --version" 0
check "GitHub CLI"            "gh --version" 0
[[ "$(uname)" == Linux ]] && check "WebKitGTK 4.1" "pkg-config --modversion webkit2gtk-4.1" 0
if have node && (( $(node -p 'process.versions.node.split(".")[0]') < 20 )); then echo "${R}✗${N} Node.js is older than 20"; bad=1; fi
[[ -d node_modules ]] && ok "npm dependencies installed" || warn "npm dependencies missing: run ./scripts/dev/setup.sh"
if [[ "$(uname)" == Linux ]] && ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "${D}  Desktop builds on Debian/Ubuntu need: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf${N}"
fi
exit $bad
