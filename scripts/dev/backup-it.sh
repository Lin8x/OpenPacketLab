#!/usr/bin/env bash
# Tests every network backup destination against real servers in Docker:
# S3 (SeaweedFS), WebDAV, SFTP and FTP. Add --keep to leave the servers running.
source "$(dirname "$0")/_lib.sh"
have docker || die "Docker is not installed"
need_deps
servers=(opl-it-s3 opl-it-dav opl-it-sftp opl-it-ftp)
cleanup() { [[ "${1:-}" == --keep ]] || docker rm -f "${servers[@]}" >/dev/null 2>&1 || true; }
trap 'cleanup "${KEEP:-}"' EXIT
[[ "${1:-}" == --keep ]] && KEEP=--keep
docker rm -f "${servers[@]}" >/dev/null 2>&1 || true
step "Starting test servers"
run docker run -d --name opl-it-s3   -p 8333:8333 -v "$ROOT/tests/fixtures:/cfg:ro" chrislusf/seaweedfs server -s3 -s3.config=/cfg/s3.json
run docker run -d --name opl-it-dav  -p 8081:80 -e AUTH_TYPE=Basic -e USERNAME=opl -e PASSWORD=oplpass bytemark/webdav
run docker run -d --name opl-it-sftp -p 2222:22 atmoz/sftp opl:oplpass:::upload
run docker run -d --name opl-it-ftp  -p 2121:21 -p 21000-21010:21000-21010 -e "USERS=opl|oplpass" -e ADDRESS=127.0.0.1 delfer/alpine-ftp-server
sleep 12
step "S3 and WebDAV"; OPL_IT=1 run npx vitest run tests/backup.integration.test.ts
if have cargo; then
  step "SFTP and FTP"; (cd src-tauri && run cargo test -- --ignored)
else
  warn "cargo not found, skipping SFTP and FTP"
fi
ok "Backup destinations work"
