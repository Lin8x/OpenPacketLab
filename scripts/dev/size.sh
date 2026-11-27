#!/usr/bin/env bash
# Builds the web app and shows how big it is, raw and gzipped.
source "$(dirname "$0")/_lib.sh"
need_deps
npx vite build >/dev/null
total=0; gz=0
while IFS= read -r f; do
  s=$(wc -c <"$f"); g=$(gzip -c "$f" | wc -c)
  total=$((total + s)); gz=$((gz + g))
  printf '  %8.1f KB  %s\n' "$(echo "$s/1024" | bc -l)" "${f#dist/}"
done < <(find dist -type f | sort)
printf '\n  %s%.1f KB total, %.1f KB gzipped%s\n' "$B" "$(echo "$total/1024" | bc -l)" "$(echo "$gz/1024" | bc -l)" "$N"
