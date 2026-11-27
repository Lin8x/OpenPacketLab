# Shortcuts for scripts/opl.mjs. Run `make help` for the full list.
.PHONY: help install dev app check test size bundle docker docker-stop clean doctor release

help:            ; @node scripts/opl.mjs help
install:         ; npm ci
doctor:          ; @node scripts/opl.mjs doctor
dev:             ; @node scripts/opl.mjs dev
app:             ; @node scripts/opl.mjs app
check:           ; @node scripts/opl.mjs check
test:            ; @node scripts/opl.mjs test
size:            ; @node scripts/opl.mjs size
bundle:          ; @node scripts/opl.mjs bundle
docker:          ; @node scripts/opl.mjs docker run
docker-stop:     ; @node scripts/opl.mjs docker stop
clean:           ; @node scripts/opl.mjs clean
# make release V=patch   (or V=1.2.3)
release:         ; @node scripts/opl.mjs release $(V)
