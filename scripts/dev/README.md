# Dev scripts

Plain bash scripts for testing and releasing. Run them from anywhere.

| Script | What it does |
| --- | --- |
| `./scripts/dev/setup.sh` | Install npm dependencies |
| `./scripts/dev/doctor.sh` | Check Node, Rust, Docker, WebKitGTK and gh are installed |
| `./scripts/dev/dev.sh [app]` | Run with hot reload (web at http://localhost:1420, or the desktop window) |
| `./scripts/dev/test.sh [name] [--watch]` | Run the tests, optionally filtered |
| `./scripts/dev/check.sh [--fast]` | Everything CI checks (types, tests, build, Rust fmt/clippy/tests) |
| `./scripts/dev/build.sh [web\|app\|deb\|rpm\|appimage\|dmg\|msi\|nsis]` | Build the web app or desktop installers |
| `./scripts/dev/size.sh` | Show the web bundle size |
| `./scripts/dev/docker.sh [up\|pull\|down\|logs\|test]` | Run or smoke-test the container |
| `./scripts/dev/backup-it.sh [--keep]` | Test S3, WebDAV, SFTP and FTP backups against servers in Docker |
| `./scripts/dev/version.sh [x.y.z\|patch\|minor\|major]` | Show or set the version everywhere |
| `./scripts/dev/release.sh <version> [--dry] [--skip-checks]` | Check, bump, tag and push a release |
| `./scripts/dev/clean.sh` | Remove build output |
