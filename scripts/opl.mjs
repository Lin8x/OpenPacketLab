#!/usr/bin/env node
// OpenPacketLab developer tool. Run `npm run opl -- help` or `node scripts/opl.mjs help`.
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (...p) => path.join(ROOT, ...p);
const read = (p) => fs.readFileSync(rel(p), "utf8");
const write = (p, s) => fs.writeFileSync(rel(p), s);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), blue = c(34);

function die(msg) {
  console.error(red("✗ ") + msg);
  process.exit(1);
}
function step(msg) {
  console.log(blue("› ") + bold(msg));
}
function run(cmd, opts = {}) {
  console.log(dim(`$ ${cmd}`));
  const r = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0 && !opts.allowFail) die(`Command failed: ${cmd}`);
  return r.status === 0;
}
function out(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const currentVersion = () => JSON.parse(read("package.json")).version;

function nextVersion(spec) {
  const cur = currentVersion();
  if (SEMVER.test(spec)) return spec;
  const [maj, min, pat] = cur.split("-")[0].split(".").map(Number);
  if (spec === "major") return `${maj + 1}.0.0`;
  if (spec === "minor") return `${maj}.${min + 1}.0`;
  if (spec === "patch") return `${maj}.${min}.${pat + 1}`;
  die(`Not a version: ${spec}. Use x.y.z, major, minor or patch.`);
}

/** Writes the version to every file that carries it. */
function setVersion(v) {
  const pkg = JSON.parse(read("package.json"));
  pkg.version = v;
  write("package.json", JSON.stringify(pkg, null, 2) + "\n");

  if (fs.existsSync(rel("package-lock.json"))) {
    const lock = JSON.parse(read("package-lock.json"));
    lock.version = v;
    if (lock.packages?.[""]) lock.packages[""].version = v;
    write("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  }

  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  conf.version = v;
  write("src-tauri/tauri.conf.json", JSON.stringify(conf, null, 2) + "\n");

  write("src-tauri/Cargo.toml", read("src-tauri/Cargo.toml").replace(/^version = ".*"$/m, `version = "${v}"`));
  if (fs.existsSync(rel("src-tauri/Cargo.lock"))) {
    write(
      "src-tauri/Cargo.lock",
      read("src-tauri/Cargo.lock").replace(/(\[\[package\]\]\nname = "openpacketlab"\nversion = )".*"/, `$1"${v}"`),
    );
  }
}

/** Returns the CHANGELOG section for a version (or Unreleased). */
function changelogSection(v) {
  const text = fs.existsSync(rel("CHANGELOG.md")) ? read("CHANGELOG.md") : "";
  const re = new RegExp(`^## \\[?${v.replace(/\./g, "\\.")}\\]?.*$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const commands = {
  help: {
    desc: "Show this help",
    run() {
      console.log(`${bold("OpenPacketLab dev tool")} ${dim("v" + currentVersion())}\n`);
      console.log(`Usage: ${bold("npm run opl -- <command> [options]")}\n`);
      const w = Math.max(...Object.keys(commands).map((k) => (k + " " + (commands[k].args ?? "")).length));
      for (const [name, cmd] of Object.entries(commands)) {
        const sig = name + " " + (cmd.args ?? "");
        console.log(`  ${green(sig.padEnd(w))}  ${cmd.desc}`);
      }
      console.log(`\nExamples:\n  npm run opl -- doctor\n  npm run opl -- check\n  npm run opl -- release patch\n  npm run opl -- docker run`);
    },
  },

  doctor: {
    desc: "Check that the tools needed to build are installed",
    run() {
      const checks = [
        ["Node.js 20+", "node --version", (v) => Number(v.slice(1).split(".")[0]) >= 20, true],
        ["npm", "npm --version", () => true, true],
        ["Rust (cargo)", "cargo --version", () => true, false],
        ["rustc", "rustc --version", () => true, false],
        ["Docker", "docker --version", () => true, false],
        ["git", "git --version", () => true, true],
        ["GitHub CLI (releases)", "gh --version", () => true, false],
      ];
      if (process.platform === "linux") checks.push(["WebKitGTK 4.1 (desktop build)", "pkg-config --modversion webkit2gtk-4.1", () => true, false]);
      let bad = 0;
      for (const [label, cmd, ok, required] of checks) {
        const v = out(cmd);
        const pass = v && ok(v);
        if (!pass && required) bad++;
        const mark = pass ? green("✓") : required ? red("✗") : yellow("•");
        console.log(`${mark} ${label.padEnd(32)} ${dim(pass ? v.split("\n")[0] : required ? "missing (required)" : "not found (optional)")}`);
      }
      console.log(fs.existsSync(rel("node_modules")) ? `${green("✓")} ${"npm dependencies".padEnd(32)} ${dim("installed")}` : `${yellow("•")} ${"npm dependencies".padEnd(32)} ${dim("run npm ci")}`);
      if (process.platform === "linux" && !out("pkg-config --modversion webkit2gtk-4.1"))
        console.log(dim("\nDesktop builds on Debian/Ubuntu need:\n  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf"));
      if (bad) process.exit(1);
    },
  },

  dev: {
    desc: "Start the web UI with hot reload (http://localhost:1420)",
    run: () => run("npx vite"),
  },
  app: {
    desc: "Start the desktop app with hot reload",
    run: () => run("npx tauri dev"),
  },

  check: {
    args: "[--fast]",
    desc: "Type check, run the tests, build, and check the Rust shell",
    run(args) {
      step("Type check");
      run("npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings");
      step("Tests");
      run("npx vitest run");
      if (args.includes("--fast")) return;
      step("Web build");
      run("npx vite build");
      if (out("cargo --version")) {
        step("Rust shell");
        run("cargo fmt --check", { cwd: rel("src-tauri") });
        run("cargo clippy -- -D warnings", { cwd: rel("src-tauri") });
      } else console.log(yellow("• cargo not found, skipping the Rust checks"));
      console.log(green("\n✓ All checks passed"));
    },
  },

  test: {
    args: "[pattern]",
    desc: "Run the engine and CLI tests (optionally filtered)",
    run: (args) => run(`npx vitest run ${args.join(" ")}`),
  },

  it: {
    args: "[--keep]",
    desc: "Integration-test backup destinations against S3, WebDAV, SFTP and FTP servers in Docker",
    run(args) {
      const cfg = rel("tests/fixtures/s3.json");
      const servers = [
        ["opl-it-s3", `-p 8333:8333 -v "${path.dirname(cfg)}:/cfg:ro" chrislusf/seaweedfs server -s3 -s3.config=/cfg/s3.json`],
        ["opl-it-dav", "-p 8081:80 -e AUTH_TYPE=Basic -e USERNAME=opl -e PASSWORD=oplpass bytemark/webdav"],
        ["opl-it-sftp", "-p 2222:22 atmoz/sftp opl:oplpass:::upload"],
        ["opl-it-ftp", '-p 2121:21 -p 21000-21010:21000-21010 -e USERS="opl|oplpass" -e ADDRESS=127.0.0.1 delfer/alpine-ftp-server'],
      ];
      step("Starting test servers");
      for (const [name, opts] of servers) {
        run(`docker rm -f ${name}`, { stdio: "ignore", allowFail: true });
        run(`docker run -d --name ${name} ${opts}`);
      }
      const stop = () => {
        if (args.includes("--keep")) return;
        for (const [name] of servers) run(`docker rm -f ${name}`, { stdio: "ignore", allowFail: true });
      };
      try {
        run("node -e \"setTimeout(()=>{},12000)\""); // let the servers start
        step("Web providers (S3, WebDAV)");
        run("npx vitest run tests/backup.integration.test.ts", { env: { ...process.env, OPL_IT: "1" } });
        step("Native providers (SFTP, FTP)");
        run("cargo test -- --ignored", { cwd: rel("src-tauri") });
        console.log(green("\n✓ All backup destinations work"));
      } finally {
        stop();
      }
    },
  },

  size: {
    desc: "Build and report the web bundle size",
    run() {
      run("npx vite build", { stdio: "ignore" });
      let total = 0, gz = 0;
      const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p);
          else {
            const buf = fs.readFileSync(p);
            total += buf.length;
            gz += gzipSync(buf).length;
            console.log(`  ${(buf.length / 1024).toFixed(1).padStart(8)} KB  ${path.relative(rel("dist"), p)}`);
          }
        }
      };
      walk(rel("dist"));
      console.log(bold(`\n  ${(total / 1024).toFixed(1)} KB total, ${(gz / 1024).toFixed(1)} KB gzipped`));
    },
  },

  bundle: {
    args: "[tauri args]",
    desc: "Build desktop installers for this machine",
    run: (args) => run(`npx tauri build ${args.join(" ")}`),
  },

  docker: {
    args: "build|run|stop",
    desc: "Build the container image or run it on http://localhost:8080",
    run([sub = "run"]) {
      if (sub === "build") return run("docker build -t openpacketlab:local .");
      if (sub === "run") {
        run("docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build");
        console.log(green("\n✓ OpenPacketLab is running at http://localhost:8080"));
        return;
      }
      if (sub === "stop") return run("docker compose down");
      die(`Unknown docker command: ${sub}`);
    },
  },

  version: {
    args: "<version|patch|minor|major>",
    desc: "Set the version in package.json, tauri.conf.json and Cargo.toml",
    run([spec]) {
      if (!spec) return console.log(currentVersion());
      const v = nextVersion(spec);
      setVersion(v);
      console.log(green(`✓ Version set to ${v}`));
    },
  },

  release: {
    args: "<version|patch|minor|major>",
    desc: "Check, bump, date the CHANGELOG, commit, tag, push. Flags: --no-push, --skip-checks",
    run(args) {
      const spec = args.find((a) => !a.startsWith("--"));
      if (!spec) die("Usage: opl release <x.y.z|major|minor|patch>");
      const v = nextVersion(spec);
      const branch = out("git rev-parse --abbrev-ref HEAD");
      if (branch !== "main") die(`Releases are cut from main (you are on ${branch}).`);
      if (out("git status --porcelain")) die("The working tree has uncommitted changes.");
      if (out(`git tag -l v${v}`)) die(`Tag v${v} already exists.`);

      if (!args.includes("--skip-checks")) commands.check.run([]);

      step(`Releasing ${v}`);
      setVersion(v);
      if (fs.existsSync(rel("CHANGELOG.md"))) {
        const date = new Date().toISOString().slice(0, 10);
        let log = read("CHANGELOG.md");
        if (/^## \[?Unreleased\]?/im.test(log)) log = log.replace(/^## \[?Unreleased\]?.*$/im, `## [Unreleased]\n\n## [${v}] - ${date}`);
        else log = log.replace(/^(# .*\n)/, `$1\n## [${v}] - ${date}\n`);
        write("CHANGELOG.md", log);
      }
      run("git add -A");
      run(`git commit -m "Release v${v}"`);
      run(`git tag -a v${v} -m "OpenPacketLab v${v}"`);
      if (args.includes("--no-push")) {
        console.log(yellow(`\nTagged v${v} locally. Push with: git push origin main v${v}`));
        return;
      }
      run(`git push origin main v${v}`);
      const remote = out("git remote get-url origin")?.replace(/\.git$/, "");
      console.log(green(`\n✓ Pushed v${v}. The Release workflow is building installers:`));
      if (remote?.startsWith("https://github.com/")) console.log(`  ${remote}/actions/workflows/release.yml`);
    },
  },

  notes: {
    args: "<version>",
    desc: "Print release notes for a version from CHANGELOG.md",
    run([v = currentVersion()]) {
      const body = changelogSection(v) ?? changelogSection("Unreleased") ?? "";
      const base = `https://github.com/Lin8x/OpenPacketLab/releases/download/v${v}`;
      console.log(`${body || "See CHANGELOG.md for details."}

### Download

| Platform | File |
| --- | --- |
| macOS (Apple silicon and Intel) | [OpenPacketLab_${v}_universal.dmg](${base}/OpenPacketLab_${v}_universal.dmg) or \`brew install --cask lin8x/tap/openpacketlab\` |
| Windows x64 | [Installer (.exe)](${base}/OpenPacketLab_${v}_x64-setup.exe), [MSI](${base}/OpenPacketLab_${v}_x64_en-US.msi) |
| Windows ARM64 | [Installer (.exe)](${base}/OpenPacketLab_${v}_arm64-setup.exe) |
| Linux x86_64 | [.deb](${base}/OpenPacketLab_${v}_amd64.deb), [.rpm](${base}/OpenPacketLab-${v}-1.x86_64.rpm), [AppImage](${base}/OpenPacketLab_${v}_amd64.AppImage) |
| Linux ARM64 | [.deb](${base}/OpenPacketLab_${v}_arm64.deb), [.rpm](${base}/OpenPacketLab-${v}-1.aarch64.rpm), [AppImage](${base}/OpenPacketLab_${v}_aarch64.AppImage) |
| Docker / Portainer | \`docker run -p 8080:8080 ghcr.io/lin8x/openpacketlab:${v}\` |
| Any browser (self-host) | [OpenPacketLab_${v}_web.zip](${base}/OpenPacketLab_${v}_web.zip) |

Checksums are in SHA256SUMS.txt.`);
    },
  },

  manifests: {
    args: "<version> --assets <dir>",
    desc: "Render Homebrew, Scoop, AUR, winget, Chocolatey, Flatpak and Snap manifests",
    run(args) {
      const v = args.find((a) => SEMVER.test(a)) ?? currentVersion();
      const ai = args.indexOf("--assets");
      const assets = ai >= 0 ? path.resolve(args[ai + 1]) : null;
      const sums = new Map();
      if (assets) for (const f of fs.readdirSync(assets)) if (fs.statSync(path.join(assets, f)).isFile()) sums.set(f, sha256(path.join(assets, f)));
      const missing = new Set();
      const render = (text) =>
        text.replaceAll("{{VERSION}}", v).replace(/\{\{SHA256:([^}]+)\}\}/g, (_, name) => {
          if (sums.has(name)) return sums.get(name);
          missing.add(name);
          return "0".repeat(64);
        });
      const src = rel("packaging/templates");
      const dst = rel("packaging/dist");
      fs.rmSync(dst, { recursive: true, force: true });
      const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          const target = path.join(dst, path.relative(src, p));
          if (fs.statSync(p).isDirectory()) {
            fs.mkdirSync(target, { recursive: true });
            walk(p);
          } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, render(fs.readFileSync(p, "utf8")));
            console.log(`${green("✓")} ${path.relative(ROOT, target)}`);
          }
        }
      };
      walk(src);
      // The Scoop manifest also lives at a stable path so `scoop install <raw url>` works.
      fs.copyFileSync(path.join(dst, "scoop/openpacketlab.json"), rel("packaging/scoop-openpacketlab.json"));
      if (missing.size) console.log(yellow(`\n• No asset found for: ${[...missing].join(", ")} (checksums left as zeros)`));
    },
  },

  clean: {
    desc: "Remove build output (dist, src-tauri/target, packaging/dist)",
    run() {
      for (const d of ["dist", "src-tauri/target", "src-tauri/gen", "packaging/dist"]) {
        fs.rmSync(rel(d), { recursive: true, force: true });
        console.log(`${green("✓")} removed ${d}`);
      }
    },
  },

  lab: {
    args: "<file.opl>",
    desc: "Validate a project file and print a summary",
    run([file]) {
      if (!file) die("Usage: opl lab <file.opl>");
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
      } catch (e) {
        die(`Not valid JSON: ${e.message}`);
      }
      if (data.format !== "openpacketlab") die("Not an OpenPacketLab project (missing format: \"openpacketlab\").");
      const devices = data.devices ?? [];
      const kinds = {};
      for (const d of devices) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
      console.log(`${bold(data.name ?? path.basename(file))} ${dim(`format v${data.version}`)}`);
      console.log(`  ${devices.length} devices: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
      console.log(`  ${(data.links ?? []).length} links, ${(data.notes ?? []).length} notes`);
      const ids = new Set(devices.map((d) => d.id));
      const bad = (data.links ?? []).filter((l) => !ids.has(l.a?.device) || !ids.has(l.b?.device));
      if (bad.length) die(`${bad.length} links point at missing devices.`);
      console.log(green("✓ Looks valid"));
    },
  },
};

const [name = "help", ...args] = process.argv.slice(2);
const cmd = commands[name];
if (!cmd) {
  console.error(red(`Unknown command: ${name}\n`));
  commands.help.run();
  process.exit(1);
}
await cmd.run(args);
