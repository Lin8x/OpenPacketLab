#!/usr/bin/env bash
# Docker helpers.  ./docker.sh up      build from source and run on http://localhost:8080
#                  ./docker.sh pull    run the published image instead
#                  ./docker.sh down    stop it
#                  ./docker.sh logs    follow the logs
#                  ./docker.sh test    build, start, check health, stop
# Set OPL_PORT to use another port.
source "$(dirname "$0")/_lib.sh"
have docker || die "Docker is not installed"
PORT="${OPL_PORT:-8080}"
case "${1:-up}" in
  up)   run docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
        ok "Running at http://localhost:$PORT" ;;
  pull) run docker compose pull && run docker compose up -d
        ok "Running at http://localhost:$PORT" ;;
  down) run docker compose down ;;
  logs) run docker compose logs -f ;;
  test)
    run docker build -t openpacketlab:test .
    docker rm -f opl-smoke >/dev/null 2>&1 || true
    run docker run -d --name opl-smoke -p "$PORT:8080" --read-only --tmpfs /tmp --tmpfs /var/cache/nginx openpacketlab:test
    trap 'docker rm -f opl-smoke >/dev/null 2>&1 || true' EXIT
    for _ in $(seq 1 20); do curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS "http://localhost:$PORT/" | grep -q OpenPacketLab || die "The page did not load"
    ok "Container serves the app ($(docker image inspect openpacketlab:test --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1e6}'))" ;;
  *) die "Unknown command: $1 (use up, pull, down, logs or test)" ;;
esac
