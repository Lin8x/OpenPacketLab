#!/usr/bin/env bash
# Builds the app.  ./build.sh web     static site in dist/ (what Docker serves)
#                  ./build.sh app     desktop installers for this machine
#                  ./build.sh deb     only the .deb (fastest desktop build on Linux)
source "$(dirname "$0")/_lib.sh"
need_deps
case "${1:-web}" in
  web) run npx vite build
       ok "Built dist/ ($(du -sh dist | cut -f1))" ;;
  app) run npx tauri build
       ok "Installers are in src-tauri/target/release/bundle/" ;;
  deb|rpm|appimage|dmg|msi|nsis)
       run npx tauri build --bundles "$1"
       ok "Built in src-tauri/target/release/bundle/$1/" ;;
  *) die "Unknown target: $1 (use web, app, deb, rpm, appimage, dmg, msi or nsis)" ;;
esac
