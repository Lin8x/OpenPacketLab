// IOS-style command line session for routers and switches.

import { isValidIp, isValidMask, macDotted, normalizeMac, wildcardToMask, maskToPrefix, networkOf } from "../addr";
import { aclTypeForNumber, ICMP_NAMES, PORT_NAMES, type Acl, type AclEntry, type PortMatch } from "../devices/acl";
import type { IosDevice } from "../devices/ios";
import { Router } from "../devices/router";
import { defaultEigrp, defaultOspf, defaultRip } from "../devices/routing";
import { Switch, type SwitchPortConfig } from "../devices/switch";
import type { IpStack } from "../ipstack";
import { match, parseSyntax, tokenize, expandVlans, normalizeIfName, type Args, type CommandDef, type Syntax } from "./parser";
import { RemoteLink, type RemoteRequest, type RemoteResponse } from "./remote";
import * as show from "./show";
import { decodeType7 } from "./passwords";
import { DnsResolver } from "../services";
import { prefixToMask } from "../addr";

export type Mode =
  | "user"
  | "priv"
  | "config"
  | "if"
  | "subif"
  | "range"
  | "line"
  | "router"
  | "vlan"
  | "dhcp"
  | "acl-std"
  | "acl-ext";

const CONFIG_MODES: Mode[] = ["config", "if", "subif", "range", "line", "router", "vlan", "dhcp", "acl-std", "acl-ext"];
const SUB_MODES: Mode[] = ["if", "subif", "range", "line", "router", "vlan", "dhcp", "acl-std", "acl-ext"];
const IF_MODES: Mode[] = ["if", "subif", "range"];

const PROMPTS: Record<Mode, string> = {
  user: ">",
  priv: "#",
  config: "(config)#",
  if: "(config-if)#",
  subif: "(config-subif)#",
  range: "(config-if-range)#",
  line: "(config-line)#",
  router: "(config-router)#",
  vlan: "(config-vlan)#",
  dhcp: "(dhcp-config)#",
  "acl-std": "(config-std-nacl)#",
  "acl-ext": "(config-ext-nacl)#",
};

interface Ctx {
  ifaces: string[];
  line?: "con" | "vty";
  vlans?: number[];
  pool?: string;
  acl?: string;
  proto?: "rip" | "ospf" | "eigrp";
}

type Pending =
  | { kind: "login"; tries: number }
  | { kind: "enable"; tries: number }
  | { kind: "confirm"; prompt: string; action: (yes: boolean) => void }
  | { kind: "filename"; def: string; action: (name: string) => void }
  | { kind: "banner"; delim: string; text: string[] };

export class CliSession {
  mode: Mode = "user";
  ctx: Ctx = { ifaces: [] };
  history: string[] = [];
  busy = false;
  closed = false;
  pending?: Pending;
  remote?: RemoteLink;
  private abortFn?: () => void;
  private commands: Syntax[] = [];
  private out: (s: string) => void = () => {};
  private unlisten?: () => void;
  /** When non-null, the session belongs to a remote vty connection. */
  vty = false;
  buffer = "";

  constructor(public dev: IosDevice) {
    this.register();
  }

  // ------------------------------------------------------------- terminal I/O

  attach(out: (s: string) => void) {
    this.out = out;
    this.unlisten?.();
    const fn = (line: string) => {
      if (!this.vty) this.write(`\n${line}\n`);
    };
    this.dev.consoleListeners.add(fn);
    this.unlisten = () => this.dev.consoleListeners.delete(fn);
  }

  detach() {
    this.unlisten?.();
    this.out = () => {};
  }

  write(s: string) {
    this.buffer += s;
    this.out(s);
  }

  get hostname() {
    return this.dev.hostname;
  }

  get hidden(): boolean {
    if (this.remote) return this.remote.hidden;
    return this.pending?.kind === "login" || this.pending?.kind === "enable";
  }

  prompt(): string {
    if (this.remote) return this.remote.prompt;
    if (this.pending) {
      if (this.pending.kind === "login" || this.pending.kind === "enable") return "Password: ";
      if (this.pending.kind === "confirm") return this.pending.prompt;
      if (this.pending.kind === "filename") return `Destination filename [${this.pending.def}]? `;
      if (this.pending.kind === "banner") return "";
    }
    return this.hostname + PROMPTS[this.mode];
  }

  /** Initial text when the console is opened. */
  open(): void {
    this.closed = false;
    this.mode = "user";
    this.ctx = { ifaces: [] };
    if (this.dev.ios.banner) this.write(`${this.dev.ios.banner}\n\n`);
    if (this.dev.ios.consoleLogin && this.dev.ios.consolePassword && !this.vty) {
      this.write("\nUser Access Verification\n\n");
      this.pending = { kind: "login", tries: 0 };
    }
  }

  private finish() {
    this.busy = false;
    this.abortFn = undefined;
    this.write(this.prompt());
  }

  /** Processes one line of input. Returns immediately; output is streamed. */
  input(raw: string) {
    if (this.busy) return;
    const line = raw.replace(/\r?\n$/, "");
    if (this.remote) return this.remoteInput(line);
    if (this.pending) {
      this.write(this.hidden ? "\n" : `${line}\n`);
      this.handlePending(line);
      if (!this.busy) this.write(this.prompt());
      return;
    }
    this.write(`${line}\n`);
    if (line.trim()) {
      this.history.push(line.trim());
      if (this.history.length > 50) this.history.shift();
    }
    this.exec(line);
    if (!this.busy) this.write(this.prompt());
  }

  abort() {
    if (this.abortFn) {
      this.abortFn();
      this.write("\n");
      this.finish();
    }
  }

  /** Ctrl+Z */
  end() {
    if (CONFIG_MODES.includes(this.mode)) {
      this.write("^Z\n");
      this.toPriv();
      this.write(this.prompt());
    }
  }

  private toPriv() {
    this.mode = "priv";
    this.ctx = { ifaces: [] };
    this.dev.log(`%SYS-5-CONFIG_I: Configured from console by console`);
  }

  // --------------------------------------------------------------- help/tab

  private candidates(neg: boolean): Syntax[] {
    return this.commands.filter((s) => s.cmd.modes.includes(this.mode) && (!neg || s.cmd.no));
  }

  /** `?` help for partially typed `text`. Returns lines to print. */
  help(text: string): string {
    let tokens = tokenize(text);
    const trailing = text.length === 0 || /\s$/.test(text);
    let neg = false;
    let doPrefix = false;
    if (tokens[0] && "no".startsWith(tokens[0].toLowerCase()) && tokens[0].length >= 2 && (tokens.length > 1 || trailing) && this.mode !== "user" && this.mode !== "priv") {
      neg = true;
      tokens = tokens.slice(1);
    } else if (tokens[0]?.toLowerCase() === "do" && CONFIG_MODES.includes(this.mode) && (tokens.length > 1 || trailing)) {
      doPrefix = true;
      tokens = tokens.slice(1);
    }
    const saved = this.mode;
    if (doPrefix) this.mode = "priv";
    const syn = this.candidates(neg).filter((s) => !s.cmd.hidden);
    const res = match(tokens, syn, trailing);
    this.mode = saved;
    const items = trailing ? res.next : res.partial;
    const seen = new Map<string, string>();
    for (const i of items) if (!seen.has(i.word)) seen.set(i.word, i.help);
    const out: string[] = [];
    if (!trailing) {
      out.push([...seen.keys()].sort().join("  "));
    } else {
      const width = Math.max(12, ...[...seen.keys()].map((k) => k.length + 2));
      for (const [k, h] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) out.push(`  ${k.padEnd(width)}${h}`);
      if (res.canEnd) out.push("  <cr>");
    }
    if (!out.length || (out.length === 1 && !out[0])) return "% Unrecognized command\n";
    return out.join("\n") + "\n";
  }

  /** Tab completion: returns the completed text (or the same text). */
  complete(text: string): string {
    if (this.remote) return text;
    const tokens = tokenize(text);
    if (!tokens.length || /\s$/.test(text)) return text;
    let neg = false;
    let toks = tokens;
    if (toks.length > 1 && "no".startsWith(toks[0].toLowerCase()) && toks[0].length >= 2) {
      neg = true;
      toks = toks.slice(1);
    }
    const saved = this.mode;
    if (toks[0]?.toLowerCase() === "do" && CONFIG_MODES.includes(this.mode) && toks.length > 1) {
      this.mode = "priv";
      toks = toks.slice(1);
    }
    const res = match(toks, this.candidates(neg), false);
    this.mode = saved;
    const words = [...new Set(res.partial.map((p) => p.word).filter((w) => /^[a-z0-9-]+$/i.test(w) && w !== "WORD" && w !== "LINE"))];
    if (words.length !== 1) return text;
    const last = tokens[tokens.length - 1];
    if (/^[a-zA-Z-]+$/.test(last) && res.partial.some((p) => p.help === "Interface type")) {
      const proper = normalizeIfName(words[0] + "0")?.replace(/0$/, "");
      if (proper) return text.slice(0, text.length - last.length) + proper;
    }
    return text.slice(0, text.length - last.length) + words[0] + " ";
  }

  // ------------------------------------------------------------- execution

  exec(line: string) {
    let tokens = tokenize(line);
    if (!tokens.length) return;
    if (tokens[0].startsWith("!")) return;
    let neg = false;
    let doPrefix = false;
    if (tokens[0].toLowerCase() === "do" && CONFIG_MODES.includes(this.mode)) {
      doPrefix = true;
      tokens = tokens.slice(1);
      if (!tokens.length) return this.write("% Incomplete command.\n");
    } else if (tokens.length > 1 && "no".startsWith(tokens[0].toLowerCase()) && tokens[0].length >= 2 && CONFIG_MODES.includes(this.mode)) {
      neg = true;
      tokens = tokens.slice(1);
    }
    const saved = this.mode;
    if (doPrefix) this.mode = "priv";
    try {
      this.dispatch(tokens, neg, line);
    } finally {
      if (doPrefix && this.mode === "priv") this.mode = saved;
    }
  }

  private dispatch(tokens: string[], neg: boolean, raw: string): void {
    const syn = this.candidates(neg);
    let res = match(tokens, syn, false);
    if (!res.full.length && neg) {
      // `no` forms may omit trailing parameters: try truncated syntaxes.
      for (const s of syn) {
        for (let k = 1; k < s.tokens.length && !res.full.length; k++) {
          const r = match(tokens, [{ ...s, tokens: s.tokens.slice(0, k) }], false);
          if (r.full.length) res = { ...r, full: r.full.map((f) => ({ ...f, syntax: s })) };
        }
        if (res.full.length) break;
      }
    }
    if (!res.full.length && SUB_MODES.includes(this.mode)) {
      // Global configuration commands work from any configuration sub-mode.
      const saved = this.mode;
      const savedCtx = this.ctx;
      this.mode = "config";
      const g = match(tokens, this.candidates(neg), false);
      if (g.full.length) {
        this.ctx = { ifaces: [] };
        return this.dispatch(tokens, neg, raw);
      }
      this.mode = saved;
      this.ctx = savedCtx;
    }
    // Ambiguity: a token abbreviates several keywords at its position.
    for (let i = 0; i < tokens.length; i++) {
      const pm = match(tokens.slice(0, i + 1), syn, false);
      const lits = new Set(pm.partial.filter((p) => p.lit).map((p) => p.word));
      if (lits.size > 1 && !lits.has(tokens[i].toLowerCase()) && !pm.partial.some((p) => !p.lit)) {
        return this.write(`% Ambiguous command:  "${raw.trim()}"\n`);
      }
    }
    if (!res.full.length) {
      if (res.incomplete) return this.write("% Incomplete command.\n");
      if ((this.mode === "user" || this.mode === "priv") && tokens.length === 1 && !neg) {
        // IOS treats an unknown single word as a host name to telnet to.
        if (this.dev.ios.domainLookup) {
          this.write(`Translating "${tokens[0]}"...domain server (255.255.255.255)\n`);
          return this.write("% Unknown command or computer name, or unable to find computer address\n");
        }
        return this.write(`Translating "${tokens[0]}"\n% Unknown command or computer name, or unable to find computer address\n`);
      }
      const offset = this.caretOffset(raw, res.failAt + (neg ? 1 : 0));
      return this.write(`${" ".repeat(this.prompt().length + offset)}^\n% Invalid input detected at '^' marker.\n\n`);
    }
    // Ambiguity: the same input token matched different keywords.
    const byPos = new Map<number, Set<string>>();
    for (const f of res.full) for (const [pos, lit] of f.litAt) (byPos.get(pos) ?? byPos.set(pos, new Set()).get(pos)!).add(lit);
    for (const [pos, lits] of byPos) {
      if (lits.size > 1 && !lits.has(tokens[pos].toLowerCase())) return this.write(`% Ambiguous command: "${raw.trim()}"\n`);
    }
    const best = res.full.sort((a, b) => b.exact - a.exact || b.syntax.tokens.length - a.syntax.tokens.length || a.params - b.params)[0];
    try {
      best.syntax.cmd.run(best.args, neg);
    } catch (e) {
      this.write(`% ${(e as Error).message}\n`);
    }
  }

  private caretOffset(raw: string, tokenIndex: number): number {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(raw))) {
      if (i === tokenIndex) return m.index;
      i++;
    }
    return raw.length;
  }

  private handlePending(line: string) {
    const p = this.pending!;
    const ios = this.dev.ios;
    if (p.kind === "login") {
      if (line === ios.consolePassword) this.pending = undefined;
      else if (++p.tries >= 3) {
        this.pending = undefined;
        this.write("% Bad passwords\n");
        this.open();
      }
      return;
    }
    if (p.kind === "enable") {
      const ok = ios.enableSecret ? line === ios.enableSecret : line === ios.enablePassword;
      if (ok) {
        this.pending = undefined;
        this.mode = "priv";
      } else if (++p.tries >= 3) {
        this.pending = undefined;
        this.write("% Bad secrets\n\n");
      }
      return;
    }
    if (p.kind === "confirm") {
      this.pending = undefined;
      const yes = line.trim() === "" || /^y/i.test(line.trim()) || /^confirm$/i.test(line.trim());
      p.action(yes);
      return;
    }
    if (p.kind === "filename") {
      this.pending = undefined;
      p.action(line.trim() || p.def);
      return;
    }
    if (p.kind === "banner") {
      const idx = line.indexOf(p.delim);
      if (idx >= 0) {
        p.text.push(line.slice(0, idx));
        this.dev.ios.banner = p.text.join("\n").replace(/^\n+/, "");
        this.pending = undefined;
      } else p.text.push(line);
    }
  }

  // --------------------------------------------------------------- remote

  private remoteInput(line: string) {
    const link = this.remote!;
    this.write(link.hidden ? "\n" : `${line}\n`);
    this.busy = true;
    link.send(line, (r, err) => {
      if (!r) {
        this.write(`\n% Connection lost: ${err}\n`);
        this.remote = undefined;
        return this.finish();
      }
      this.write(r.out);
      if (r.closed) {
        this.write(`\n[Connection to ${link.ip} closed by foreign host]\n`);
        this.remote = undefined;
      }
      this.finish();
    });
  }

  private remoteTo(host: string, proto: "telnet" | "ssh", user?: string) {
    this.busy = true;
    this.resolveHost(host, (ip) => {
      if (ip) return this.connect(ip, proto, user);
      this.write("% Unrecognized host or address, or protocol not running.\n");
      this.finish();
    });
  }

  private connect(ip: string, proto: "telnet" | "ssh", user?: string) {
    const stack = this.stack();
    this.write(proto === "telnet" ? `Trying ${ip} ...` : "");
    this.busy = true;
    const link = new RemoteLink(stack, ip, proto, user);
    this.abortFn = () => (link.closed = true);
    link.open((r, err) => {
      if (link.closed && !r) return;
      if (!r) {
        this.write(proto === "telnet" ? `\n% Connection ${err === "Connection refused" ? "refused by remote host" : "timed out; remote host not responding"}\n` : `\n% Connection ${err === "Connection refused" ? "refused by remote host" : "timed out"}\n`);
        return this.finish();
      }
      if (proto === "telnet") this.write(" Open\n");
      this.write(r.out);
      if (!r.closed) this.remote = link;
      else this.write(`\n[Connection to ${ip} closed by foreign host]\n`);
      this.finish();
    });
  }

  // ----------------------------------------------------------- helpers

  private stack(): IpStack {
    return (this.dev as Router | Switch).stack;
  }

  get router(): Router | undefined {
    return this.dev instanceof Router ? this.dev : undefined;
  }

  get sw(): Switch | undefined {
    return this.dev instanceof Switch ? this.dev : undefined;
  }

  private commit() {
    const d = this.dev as Router | Switch;
    d.applyConfig();
    for (const p of d.ports) if (p.link) d.net?.linkChanged(p.link);
  }

  private resolveHost(name: string, cb: (ip: string | null) => void) {
    if (isValidIp(name)) return cb(name);
    const r = this.router;
    const hosts = r?.cfg.hosts ?? {};
    const hit = Object.entries(hosts).find(([h]) => h.toLowerCase() === name.toLowerCase());
    if (hit) return cb(hit[1]);
    this.write(`Translating "${name}"...domain server (${r?.cfg.nameServers[0] ?? "255.255.255.255"})\n`);
    if (!r?.cfg.nameServers.length || !this.dev.ios.domainLookup) return cb(null);
    new DnsResolver(r.stack).resolve(name, r.cfg.nameServers[0], (ip) => cb(ip));
  }

  private ifExists(name: string): boolean {
    const r = this.router;
    if (r) {
      if (/^Loopback\d+$/.test(name) || /^Tunnel\d+$/.test(name)) return true;
      const base = name.split(".")[0];
      return !!r.port(base) && r.port(base)!.media !== "console";
    }
    const sw = this.sw!;
    if (/^Vlan\d+$/.test(name)) return Number(name.slice(4)) >= 1 && Number(name.slice(4)) <= 4094;
    const p = sw.port(name);
    return !!p && p.media !== "console";
  }

  private canonicalIf(name: string): string {
    const dev = this.dev;
    const base = name.split(".")[0];
    const p = dev.port(base);
    if (p) return p.name + (name.includes(".") ? "." + name.split(".")[1] : "");
    return name;
  }

  private parseRange(spec: string): string[] | null {
    const out: string[] = [];
    for (const part0 of spec.split(",")) {
      const part = part0.trim().replace(/\s*-\s*/g, "-");
      const m = part.match(/^([a-zA-Z-]+\s*[\d/]*\/)(\d+)(?:-(\d+))?$/) ?? part.match(/^([a-zA-Z-]+\s*)(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      const a = Number(m[2]);
      const b = m[3] !== undefined ? Number(m[3]) : a;
      for (let i = a; i <= b; i++) {
        const n = normalizeIfName((m[1] + i).replace(/\s+/g, ""));
        if (!n) return null;
        const c = this.canonicalIf(n);
        if (!this.ifExists(c)) return null;
        out.push(c);
      }
    }
    return out;
  }

  private pwArg(a: Args): string {
    const v = a.pw;
    if (a.enc === "7") return decodeType7(v) ?? v;
    return v;
  }

  // -------------------------------------------------------------- commands

  private def(cmd: CommandDef) {
    for (const s of Array.isArray(cmd.syntax) ? cmd.syntax : [cmd.syntax]) this.commands.push({ tokens: parseSyntax(s, cmd.help), cmd });
  }

  private register() {
    const isR = () => !!this.router;
    const isSw = () => !!this.sw;
    const d = (c: CommandDef, when: () => boolean = () => true) => {
      if (when()) this.def(c);
    };
    const H = {
      show: "Show running system information",
      ip: "IP information",
      interface: "Select an interface to configure",
      no: "Negate a command or set its defaults",
      exit: "Exit from configuration mode",
      end: "Exit to privileged EXEC mode",
    };

    // ---------------------------------------------------------------- exec
    d({ modes: ["user"], syntax: "enable", help: { enable: "Turn on privileged commands" }, run: () => {
      const ios = this.dev.ios;
      if (ios.enableSecret || ios.enablePassword) this.pending = { kind: "enable", tries: 0 };
      else if (this.vty) this.write("% No password set\n");
      else this.mode = "priv";
    } });
    d({ modes: ["priv"], syntax: "disable", help: { disable: "Turn off privileged commands" }, run: () => (this.mode = "user") });
    d({ modes: ["user", "priv"], syntax: ["exit", "logout", "quit"], help: { exit: "Exit from the EXEC", logout: "Exit from the EXEC", quit: "Exit from the EXEC" }, run: () => {
      this.closed = true;
      this.mode = "user";
      if (!this.vty) {
        this.write(`\n${this.hostname} con0 is now available\n\n\n\n\n\nPress RETURN to get started.\n\n\n`);
        this.open();
      }
    } });
    d({ modes: ["priv"], syntax: ["configure terminal", "configure"], help: { configure: "Enter configuration mode", terminal: "Configure from the terminal" }, run: () => {
      this.mode = "config";
      this.write("Enter configuration commands, one per line.  End with CNTL/Z.\n");
    } });
    d({ modes: ["user", "priv"], syntax: ["terminal length <n:num:0-512>", "terminal no monitor", "terminal monitor", "terminal width <n:num:0-512>"], help: { terminal: "Set terminal line parameters", length: "Set number of lines on a screen" }, run: () => {} });

    d({ modes: ["user", "priv"], syntax: ["ping <host:word>", "ping <host:word> repeat <n:num:1-1000>", "ping <host:word> size <size:num:36-18024>", "ping <host:word> source <src:word>", "ping <host:word> timeout <t:num:0-3600>", "ping <host:word> repeat <n:num:1-1000> size <size:num:36-18024>"], help: { ping: "Send echo messages", repeat: "specify repeat count", source: "specify source address or name", size: "specify datagram size" }, run: (a) => this.ping(a) });
    d({ modes: ["user", "priv"], syntax: ["traceroute <host:word>", "tracert <host:word>"], help: { traceroute: "Trace route to destination" }, run: (a) => this.traceroute(a.host) });
    d({ modes: ["user", "priv"], syntax: "telnet <host:word>", help: { telnet: "Open a telnet connection" }, run: (a) => this.remoteTo(a.host, "telnet") });
    d({ modes: ["user", "priv"], syntax: ["ssh -l <user:word> <host:word>", "ssh -v 2 -l <user:word> <host:word>"], help: { ssh: "Open a secure shell client connection" }, run: (a) => this.remoteTo(a.host, "ssh", a.user) });
    d({ modes: ["priv"], syntax: ["copy running-config startup-config", "write memory", "write", "copy run start"], help: { copy: "Copy from one file to another", write: "Write running configuration to memory", "running-config": "Copy from current system configuration", "startup-config": "Copy to startup configuration" }, run: (_a) => {
      const save = () => {
        this.dev.saveStartup();
        this.write("Building configuration...\n[OK]\n");
      };
      save();
    } });
    d({ modes: ["priv"], syntax: ["copy startup-config running-config"], run: () => {
      if (!this.dev.startup) return this.write("%% Non-volatile configuration memory is not present\n");
      this.dev.loadRunning(structuredClone(this.dev.startup));
      this.write(`Destination filename [running-config]? \n${JSON.stringify(this.dev.startup).length} bytes copied in 0.416 secs\n`);
    } });
    d({ modes: ["priv"], syntax: ["erase startup-config", "write erase", "erase nvram:"], help: { erase: "Erase a filesystem" }, run: () => {
      this.pending = { kind: "confirm", prompt: "Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]", action: (yes) => {
        if (!yes) return;
        this.dev.eraseStartup();
        this.write("[OK]\nErase of nvram: complete\n");
        this.dev.log("%SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram");
      } };
    } });
    d({ modes: ["priv"], syntax: "reload", help: { reload: "Halt and perform a cold restart" }, run: () => {
      this.pending = { kind: "confirm", prompt: "Proceed with reload? [confirm]", action: (yes) => {
        if (!yes) return;
        this.write("\nSystem Bootstrap, Version 1.0\nInitializing memory...\n\nRestarting system.\n\n");
        this.dev.reload();
        this.mode = "user";
        this.ctx = { ifaces: [] };
        this.write(`\n${this.dev.model} processor with 512K bytes of memory.\n\nPress RETURN to get started!\n\n`);
        this.open();
      } };
    } });
    d({ modes: ["priv"], syntax: ["clear arp-cache", "clear ip arp", "clear arp"], help: { clear: "Reset functions" }, run: () => this.stack().clearArp() });
    d({ modes: ["priv"], syntax: ["clear mac address-table dynamic", "clear mac-address-table dynamic", "clear mac address-table"], run: () => this.sw?.clearMacTable() }, isSw);
    d({ modes: ["priv"], syntax: ["clear ip nat translation *", "clear ip nat translations *"], run: () => this.router?.clearNat() }, isR);
    d({ modes: ["priv"], syntax: ["clear ip route *", "clear ip ospf process", "clear ip eigrp neighbors"], run: () => {
      const dev = this.dev as Router | Switch;
      dev.routing.stop();
      dev.routing.start();
    } });
    d({ modes: ["priv"], syntax: ["clear counters", "clear access-list counters"], run: () => {
      for (const acl of Object.values((this.dev as Router | Switch).cfg.acls)) for (const e of acl.entries) e.matches = 0;
    } });
    d({ modes: ["priv"], syntax: ["clock set <t:line>"], help: { clock: "Manage the system clock" }, run: (a) => {
      const t = Date.parse(a.t.replace(/(\d{1,2}):(\d{2}):(\d{2}) (\d{1,2}) ([a-z]+) (\d{4})/i, "$5 $4 $6 $1:$2:$3"));
      if (isNaN(t)) return this.write("% Invalid input detected.\n");
      this.dev.ios.clockOffsetMs = t - Date.now();
    } });
    d({ modes: ["priv"], syntax: ["debug <what:line>", "undebug all", "no debug all"], help: { debug: "Debugging functions" }, run: () => this.write("Debugging output is shown in Simulation mode's event list.\n") });

    // ---------------------------------------------------------------- show
    const S = (syntax: string | string[], fn: (a: Args) => string, when: () => boolean = () => true, modes: Mode[] = ["user", "priv"]) =>
      d({ modes, syntax: (Array.isArray(syntax) ? syntax : [syntax]).map((s) => `show ${s}`), help: SHOW_HELP, run: (a) => {
        const s = fn(a);
        if (s) this.write(s.endsWith("\n") ? s : s + "\n");
      } }, when);
    S(["running-config", "run"], () => show.runningConfig(this.dev), () => true, ["priv"]);
    S("running-config interface <if:if>", (a) => sliceInterface(show.runningConfig(this.dev), this.canonicalIf(a.if)), () => true, ["priv"]);
    S(["startup-config", "start"], () => (this.dev.startup ? showStartup(this.dev) : "startup-config is not present"), () => true, ["priv"]);
    S("version", () => show.showVersion(this.dev));
    S("ip interface brief", () => show.showIpIntBrief(this.dev));
    S(["interfaces", "interface"], () => show.showInterfaces(this.dev));
    S(["interfaces <if:if>", "interface <if:if>"], (a) => show.showInterfaces(this.dev, this.canonicalIf(a.if)));
    S(["ip route", "ip route {connected|static|rip|ospf|eigrp}"], (a) => show.showIpRoute(this.dev, a._lit));
    S(["arp", "ip arp"], () => show.showArp(this.dev));
    S(["cdp neighbors", "lldp neighbors"], () => show.showNeighbors(this.dev));
    S(["cdp neighbors detail", "lldp neighbors detail", "cdp entry *"], () => show.showNeighbors(this.dev, true));
    S("cdp", () => (this.dev.ios.cdp ? "Global CDP information:\n\tSending CDP packets every 60 seconds\n\tSending a holdtime value of 180 seconds\n\tSending CDPv2 advertisements is  enabled" : "% CDP is not enabled"));
    S("clock", () => {
      const t = new Date(Date.now() + this.dev.ios.clockOffsetMs);
      return `*${t.toUTCString().replace("GMT", "UTC")}`;
    });
    S("history", () => this.history.map((h) => `  ${h}`).join("\n"));
    S(["access-lists", "ip access-lists", "access-lists <n:word>"], (a) => show.showAccessLists(this.dev as Router | Switch, a.n));
    S("ip protocols", () => show.showIpProtocols(this.dev as Router | Switch));
    S("ip ospf neighbor", () => show.showOspfNeighbor(this.dev as Router | Switch));
    S("ip ospf database", () => show.showOspfDatabase(this.dev as Router | Switch));
    S("ip ospf", () => (this.dev as Router).cfg.routing.ospf ? ` Routing Process "ospf ${(this.dev as Router).cfg.routing.ospf!.pid}" with ID ${(this.dev as Router).routing.routerId()}` : "%OSPF: No router process is configured");
    S(["ip eigrp neighbors", "ip eigrp neighbor"], () => show.showEigrpNeighbors(this.dev as Router | Switch));
    S("ip rip database", () => {
      const r = this.dev as Router | Switch;
      return r.stack.routingTable().filter((x) => x.code === "R" || x.code === "C").map((x) => `${x.network}/${x.prefix}    ${x.code === "C" ? "directly connected, " + x.iface : `[${x.metric}] via ${x.nextHop}, ${x.iface}`}`).join("\n");
    });
    S(["ip dhcp binding"], () => show.showDhcpBinding(this.dev as Router | Switch));
    S(["ip dhcp pool"], () => {
      const pools = isR() ? this.router!.cfg.dhcpPools : [];
      return pools.map((p) => `Pool ${p.name} :\n Utilization mark (high/low)    : 100 / 0\n Subnet size (first/next)       : 0 / 0\n Total addresses                : ${2 ** (32 - maskToPrefix(p.mask)) - 2}\n Leased addresses               : ${[...this.router!.dhcpServer.bindings.values()].filter((b) => b.pool === p.name).length}\n Excluded addresses             : ${this.router!.cfg.dhcpExcluded.length}\n Pending event                  : none`).join("\n\n");
    }, isR);
    S(["ip nat translations", "ip nat translation"], () => show.showNat(this.router!), isR);
    S("ip nat statistics", () => {
      const r = this.router!;
      const ins = Object.entries(r.cfg.interfaces).filter(([, c]) => c.nat === "inside").map(([n]) => n);
      const outs = Object.entries(r.cfg.interfaces).filter(([, c]) => c.nat === "outside").map(([n]) => n);
      return `Total translations: ${r.natTable.length} (${r.cfg.nat.statics.length} static, ${r.natTable.filter((e) => !e.static).length} dynamic, ${r.natTable.filter((e) => e.insideGlobalPort !== undefined).length} extended)\nOutside Interfaces: ${outs.join(", ")}\nInside Interfaces: ${ins.join(", ")}`;
    }, isR);
    S(["mac address-table", "mac-address-table", "mac address-table dynamic"], () => show.showMacTable(this.sw!), isSw);
    S(["vlan brief", "vlan"], (a) => show.showVlanBrief(this.sw!, a._lit !== undefined ? true : true), isSw);
    S(["interfaces trunk"], () => show.showTrunk(this.sw!), isSw);
    S(["interfaces status"], () => show.showInterfacesStatus(this.sw!), isSw);
    S(["spanning-tree", "spanning-tree vlan <v:num:1-4094>"], () => show.showSpanningTree(this.sw!), isSw);
    S(["port-security", "port-security interface <if:if>"], (a) => show.showPortSecurity(this.sw!, a.if ? this.canonicalIf(a.if) : undefined), isSw);
    S(["port-security address"], () => {
      const sw = this.sw!;
      const lines = ["\t\tSecure Mac Address Table", "-------------------------------------------------------------------", "Vlan\tMac Address\tType\t\t\tPorts\tRemaining Age", "----\t-----------\t----\t\t\t-----\t-------------"];
      for (const p of sw.ports) {
        const c = sw.cfg.ports[p.name];
        if (!c?.security.enabled) continue;
        for (const m of c.security.macs) lines.push(`${c.accessVlan}\t${macDotted(m)}\t${c.security.sticky ? "SecureSticky" : "DynamicConfigured"}\t${p.short}\t-`);
      }
      return lines.join("\n");
    }, isSw);
    S(["ip ssh"], () => (this.dev.ios.sshKeyBits ? `SSH Enabled - version 2.0\nAuthentication timeout: 120 secs; Authentication retries: 3` : "SSH Disabled - version 1.99\n%Please create RSA keys (of atleast 768 bits size) to enable SSH v2."));
    S("users", () => `    Line       User       Host(s)              Idle       Location\n*  0 con 0                idle                 00:00:00`);
    S(["flash", "flash:"], () => `Directory of flash:/\n\n    1  -rw-     33591768          <no date>  opl-universal-1.0.bin\n\n64016384 bytes total (30424616 bytes free)`);
    S("logging", () => `Syslog logging: enabled\n    Console logging: level debugging\n    Logging to: ${this.dev.ios.logging.host ?? "none"}\n\nLog Buffer:\n${this.dev.consoleLog.slice(-50).map((l) => l.text).join("\n")}`);

    // ------------------------------------------------------------ config
    d({ modes: CONFIG_MODES, syntax: "end", help: { end: H.end }, run: () => this.toPriv() });
    d({ modes: ["config"], syntax: "exit", help: { exit: H.exit }, run: () => this.toPriv() });
    d({ modes: SUB_MODES, syntax: "exit", help: { exit: "Exit from current mode" }, run: () => {
      this.mode = "config";
      this.ctx = { ifaces: [] };
    } });
    d({ modes: ["config"], syntax: "hostname <name:word>", help: { hostname: "Set system's network name" }, run: (a) => {
      if (!/^[a-zA-Z][\w-]{0,62}$/.test(a.name)) return this.write("% Hostname contains one or more illegal characters.\n");
      (this.dev as Router | Switch).cfg.hostname = a.name;
      this.dev.hostname = a.name;
    } });
    d({ modes: ["config"], syntax: ["enable secret <pw:word>", "enable secret {0|5} <pw:word>"], no: true, help: { enable: "Modify enable password parameters", secret: "Assign the privileged level secret" }, run: (a, neg) => {
      this.dev.ios.enableSecret = neg ? undefined : a.pw;
    } });
    d({ modes: ["config"], syntax: ["enable password <pw:word>", "enable password <enc:num:7-7> <pw:word>"], no: true, help: { password: "Assign the privileged level password" }, run: (a, neg) => {
      this.dev.ios.enablePassword = neg ? undefined : this.pwArg(a);
    } });
    d({ modes: ["config"], syntax: "service password-encryption", no: true, help: { service: "Modify use of network based services", "password-encryption": "Encrypt system passwords" }, run: (_a, neg) => (this.dev.ios.passwordEncryption = !neg) });
    d({ modes: ["config"], syntax: ["service timestamps <x:line>", "service <x:word>"], no: true, hidden: true, run: () => {} });
    d({ modes: ["config"], syntax: "banner motd <text:line>", no: true, help: { banner: "Define a login banner", motd: "Set Message of the Day banner" }, run: (a, neg) => {
      if (neg) return void (this.dev.ios.banner = undefined);
      const delim = a.text[0];
      const rest = a.text.slice(1);
      const end = rest.indexOf(delim);
      if (end >= 0) this.dev.ios.banner = rest.slice(0, end);
      else {
        this.write(`Enter TEXT message.  End with the character '${delim}'.\n`);
        this.pending = { kind: "banner", delim, text: [rest] };
      }
    } });
    d({ modes: ["config"], syntax: ["ip domain-name <name:word>", "ip domain name <name:word>"], no: true, help: { "domain-name": "Define the default domain name" }, run: (a, neg) => (this.dev.ios.domainName = neg ? undefined : a.name) });
    d({ modes: ["config"], syntax: ["ip domain-lookup", "ip domain lookup"], no: true, help: { "domain-lookup": "Enable IP Domain Name System hostname translation" }, run: (_a, neg) => (this.dev.ios.domainLookup = !neg) });
    d({ modes: ["config"], syntax: ["username <name:word> secret <pw:word>", "username <name:word> password <pw:word>", "username <name:word> privilege <lvl:num:0-15> secret <pw:word>", "username <name:word> privilege <lvl:num:0-15> password <pw:word>"], no: true, help: { username: "Establish User Name Authentication" }, run: (a, neg) => {
      const ios = this.dev.ios;
      ios.users = ios.users.filter((u) => u.name !== a.name);
      if (!neg) ios.users.push({ name: a.name, secret: a.pw, privilege: Number(a.lvl ?? 1) });
    } });
    d({ modes: ["config"], syntax: ["crypto key generate rsa", "crypto key generate rsa modulus <bits:num:360-4096>", "crypto key generate rsa general-keys modulus <bits:num:360-4096>"], help: { crypto: "Encryption module" }, run: (a) => {
      if (!this.dev.ios.domainName) return this.write("% Please define a domain-name first.\n");
      const bits = Number(a.bits ?? 1024);
      this.write(`The name for the keys will be: ${this.hostname}.${this.dev.ios.domainName}\n% The key modulus size is ${bits} bits\n% Generating ${bits} bit RSA keys, keys will be non-exportable...[OK]\n`);
      this.dev.ios.sshKeyBits = bits;
      this.dev.log("%SSH-5-ENABLED: SSH 1.99 has been enabled");
    } });
    d({ modes: ["config"], syntax: ["crypto key zeroize rsa"], run: () => (this.dev.ios.sshKeyBits = 0) });
    d({ modes: ["config"], syntax: ["ip ssh version <v:num:1-2>", "ip ssh time-out <t:num:1-120>", "ip ssh authentication-retries <n:num:0-5>"], no: true, run: () => {} });
    d({ modes: ["config"], syntax: ["cdp run", "lldp run"], no: true, help: { cdp: "Global CDP configuration subcommands", lldp: "Global LLDP configuration subcommands" }, run: (_a, neg) => {
      this.dev.ios.cdp = !neg;
      this.dev.ios.lldp = !neg;
    } });
    d({ modes: ["config"], syntax: ["logging <ip:ip>", "logging host <ip:ip>"], no: true, help: { logging: "Modify message logging facilities" }, run: (a, neg) => (this.dev.ios.logging.host = neg ? undefined : a.ip) });

    // interface selection
    const enterIf = (name0: string) => {
      const name = this.canonicalIf(name0);
      if (!this.ifExists(name)) return this.write("%Invalid interface type and number\n");
      const r = this.router;
      if (r) {
        r.ifCfg(name);
        r.applyConfig();
        this.mode = name.includes(".") ? "subif" : "if";
        if (/^loopback/i.test(name) && !r.cfg.interfaces[name]) this.dev.log(`%LINK-5-CHANGED: Interface ${name}, changed state to up`);
      } else {
        const sw = this.sw!;
        if (/^Vlan\d+$/.test(name)) {
          const v = Number(name.slice(4));
          if (!sw.cfg.svis[v]) {
            sw.cfg.svis[v] = { shutdown: false, description: "", helpers: [] };
            sw.applyConfig();
          }
        }
        this.mode = "if";
      }
      this.ctx = { ifaces: [name] };
    };
    d({ modes: ["config", ...IF_MODES], syntax: "interface <if:if>", help: { interface: H.interface }, no: true, run: (a, neg) => {
      if (neg) {
        const name = this.canonicalIf(a.if);
        const r = this.router;
        if (r && (name.includes(".") || /^Loopback/i.test(name))) {
          delete r.cfg.interfaces[name];
          r.applyConfig();
        } else if (this.sw && /^Vlan\d+$/.test(name)) {
          delete this.sw.cfg.svis[Number(name.slice(4))];
          this.sw.applyConfig();
        } else this.write("% Removal of physical interfaces is not permitted\n");
        return;
      }
      enterIf(a.if);
    } });
    d({ modes: ["config", ...IF_MODES], syntax: "interface range <spec:line>", help: { range: "interface range command" }, run: (a) => {
      const list = this.parseRange(a.spec);
      if (!list || !list.length) return this.write("% Invalid input detected.\n");
      this.mode = "range";
      this.ctx = { ifaces: list };
    } });

    // ---------------------------------------------------- interface config
    const forIfs = (fn: (name: string) => void) => {
      for (const n of this.ctx.ifaces) fn(n);
      this.commit();
    };
    d({ modes: IF_MODES, syntax: "shutdown", no: true, help: { shutdown: "Shutdown the selected interface" }, run: (_a, neg) => forIfs((n) => {
      const r = this.router;
      if (r) r.ifCfg(n).shutdown = !neg;
      else {
        const sw = this.sw!;
        if (/^Vlan/.test(n)) sw.cfg.svis[Number(n.slice(4))].shutdown = !neg;
        else {
          const p = sw.port(n)!;
          if (neg) sw.clearErrDisable(p);
          sw.portCfg(p).shutdown = !neg;
        }
      }
      if (/^Loopback|^Vlan/.test(n)) this.dev.log(`%LINK-5-CHANGED: Interface ${n}, changed state to ${neg ? "up" : "administratively down"}`);
      if (/^Vlan/.test(n) || n.includes(".")) this.dev.log(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${n}, changed state to ${neg && this.sviOrSubUp(n) ? "up" : "down"}`);
    }) });
    d({ modes: IF_MODES, syntax: "description <text:line>", no: true, help: { description: "Interface specific description" }, run: (a, neg) => forIfs((n) => {
      const text = neg ? "" : a.text;
      const r = this.router;
      if (r) r.ifCfg(n).description = text;
      else if (/^Vlan/.test(n)) this.sw!.cfg.svis[Number(n.slice(4))].description = text;
      else this.sw!.portCfg(n).description = text;
    }) });
    d({ modes: IF_MODES, syntax: ["ip address <ip:ip> <mask:mask>", "ip address <ip:ip> <mask:mask> secondary", "ip address dhcp"], no: true, help: { address: "Set the IP address of an interface", dhcp: "IP Address negotiated via DHCP" }, run: (a, neg) => {
      if (!neg && a.ip && !isValidMask(a.mask)) return this.write("% Bad mask 0x" + a.mask + " for address " + a.ip + "\n");
      if (!neg && a.ip && (a.ip === networkOf(a.ip, a.mask) && maskToPrefix(a.mask) < 31)) return this.write(`Bad mask /${maskToPrefix(a.mask)} for address ${a.ip}\n`);
      // Overlap check (routers).
      if (!neg && a.ip && this.router) {
        for (const [n, c] of Object.entries(this.router.cfg.interfaces)) {
          if (this.ctx.ifaces.includes(n) || !c.ip || !c.mask) continue;
          if (networkOf(c.ip, c.mask) === networkOf(a.ip, a.mask) || networkOf(a.ip, c.mask) === networkOf(c.ip, c.mask)) {
            return this.write(`% ${networkOf(a.ip, a.mask)} overlaps with ${n}\n`);
          }
        }
      }
      forIfs((n) => {
        const r = this.router;
        if (r) {
          const c = r.ifCfg(n);
          c.dhcpClient = !neg && !a.ip;
          c.ip = neg ? undefined : a.ip;
          c.mask = neg ? undefined : a.mask;
        } else {
          const sw = this.sw!;
          if (/^Vlan/.test(n)) {
            const s = sw.cfg.svis[Number(n.slice(4))];
            s.ip = neg ? undefined : a.ip;
            s.mask = neg ? undefined : a.mask;
          } else {
            const c = sw.portCfg(n);
            if (!c.routed) throw new Error("Invalid input detected: interface is a switchport. Use 'no switchport' first.");
            c.ip = neg ? undefined : a.ip;
            c.mask = neg ? undefined : a.mask;
          }
        }
      });
    } });
    d({ modes: IF_MODES, syntax: "ip helper-address <ip:ip>", no: true, help: { "helper-address": "Specify a destination address for UDP broadcasts" }, run: (a, neg) => forIfs((n) => {
      const list = this.router ? this.router.ifCfg(n).helpers : this.sw!.cfg.svis[Number(n.slice(4))]?.helpers;
      if (!list) throw new Error("Helper addresses can be set on routed interfaces only");
      const i = list.indexOf(a.ip);
      if (neg) {
        if (a.ip) list.splice(i, i >= 0 ? 1 : 0);
        else list.length = 0;
      } else if (i < 0) list.push(a.ip);
    }) });
    d({ modes: IF_MODES, syntax: "ip access-group <acl:word> {in|out}", no: true, help: { "access-group": "Specify access control for packets" }, run: (a, neg) => forIfs((n) => {
      const c = this.router ? this.router.ifCfg(n) : this.sw!.cfg.svis[Number(n.slice(4))];
      if (!c) throw new Error("Access groups can be applied to routed interfaces only");
      const d0 = this.lastLit("in", "out");
      if (d0 === "out") c.aclOut = neg ? undefined : a.acl;
      else c.aclIn = neg ? undefined : a.acl;
    }) });
    d({ modes: IF_MODES, syntax: "ip nat {inside|outside}", no: true, help: { nat: "NAT interface commands", inside: "Inside interface for address translation", outside: "Outside interface for address translation" }, run: (_a, neg) => forIfs((n) => {
      const c = this.router!.ifCfg(n);
      c.nat = neg ? undefined : (this.lastLit("inside", "outside") as "inside" | "outside");
    }) }, isR);
    d({ modes: IF_MODES, syntax: "ip ospf cost <c:num:1-65535>", no: true, help: { ospf: "OSPF interface commands", cost: "Interface cost" }, run: (a, neg) => forIfs((n) => {
      if (this.router) this.router.ifCfg(n).ospfCost = neg ? undefined : Number(a.c);
    }) });
    d({ modes: IF_MODES, syntax: ["ip ospf hello-interval <n:num:1-65535>", "ip ospf dead-interval <n:num:1-65535>", "ip ospf priority <n:num:0-255>", "ip ospf authentication <x:line>", "ip ospf message-digest-key <x:line>"], no: true, hidden: true, run: () => {} });
    d({ modes: IF_MODES, syntax: ["ip proxy-arp", "ip redirects", "ip unreachables", "ip route-cache", "ip directed-broadcast", "ip mtu <n:num:68-1500>", "ip tcp adjust-mss <n:num:500-1460>"], no: true, hidden: true, run: () => {} });
    d({ modes: IF_MODES, syntax: ["speed {10|100|1000|auto}", "duplex {full|half|auto}", "mdix auto", "negotiation auto", "cdp enable", "keepalive <n:num:0-32767>", "load-interval <n:num:30-600>"], no: true, help: { speed: "Configure speed operation.", duplex: "Configure duplex operation." }, run: (a, neg) => forIfs((n) => {
      const sw = this.sw;
      if (sw && !/^Vlan/.test(n) && a._lit) {
        const c = sw.portCfg(n);
        if (["10", "100", "1000", "auto"].includes(a._lit)) c.speed = neg ? "auto" : (a._lit as SwitchPortConfig["speed"]);
        else if (["full", "half"].includes(a._lit)) c.duplex = neg ? "auto" : (a._lit as SwitchPortConfig["duplex"]);
      }
    }) });
    d({ modes: IF_MODES, syntax: "bandwidth <kbps:num:1-10000000>", no: true, help: { bandwidth: "Set bandwidth informational parameter" }, run: (a, neg) => forIfs((n) => {
      if (this.router) this.router.ifCfg(n).bandwidth = neg ? undefined : Number(a.kbps);
    }) });
    d({ modes: IF_MODES, syntax: ["clock rate <rate:num:300-8000000>", "clockrate <rate:num:300-8000000>"], no: true, help: { clock: "Configure serial interface clock", rate: "Configure serial interface clock speed" }, run: (a, neg) => forIfs((n) => {
      if (!n.startsWith("Serial")) throw new Error("Invalid input detected: clock rate applies to serial interfaces");
      const r = this.router!;
      const p = r.port(n);
      if (p?.link && !r.isDce(p) && !neg) this.write("This command applies only to DCE interfaces\n");
      r.ifCfg(n).clockRate = neg ? undefined : Number(a.rate);
    }) }, isR);
    d({ modes: IF_MODES, syntax: ["encapsulation {ppp|hdlc}", "encapsulation dot1q <vlan:num:1-4094>", "encapsulation dot1q <vlan:num:1-4094> native"], no: true, help: { encapsulation: "Set encapsulation type for an interface", dot1q: "IEEE 802.1Q Virtual LAN", ppp: "Point-to-Point protocol", hdlc: "Serial HDLC synchronous" }, run: (a, neg) => {
      const r = this.router!;
      forIfs((n) => {
        const c = r.ifCfg(n);
        if (a.vlan) {
          if (!n.includes(".")) throw new Error("Configuring IEEE 802.1Q encapsulation on the main interface is not supported; use a subinterface");
          c.dot1q = neg ? undefined : Number(a.vlan);
          c.native = !neg && /native\s*$/i.test(this.history[this.history.length - 1] ?? "");
        } else {
          if (!n.startsWith("Serial")) throw new Error("Invalid input detected: encapsulation ppp/hdlc applies to serial interfaces");
          c.encapsulation = neg ? undefined : (this.lastLit("ppp", "hdlc") as "ppp" | "hdlc");
        }
      });
    } }, isR);
    d({ modes: IF_MODES, syntax: ["ppp authentication {chap|pap}", "ppp pap sent-username <x:line>"], no: true, hidden: true, run: () => {} }, isR);
    d({ modes: IF_MODES, syntax: "mac-address <mac:mac>", no: true, help: { "mac-address": "Manually set interface MAC address" }, run: (a, neg) => forIfs((n) => {
      if (this.router) this.router.ifCfg(n).mac = neg ? undefined : normalizeMac(a.mac);
    }) }, isR);

    // switchport
    const portsOnly = (fn: (c: SwitchPortConfig, name: string) => void) =>
      forIfs((n) => {
        if (/^Vlan/.test(n)) throw new Error("Invalid input detected: not a switchport");
        fn(this.sw!.portCfg(n), n);
      });
    d({ modes: IF_MODES, syntax: "switchport mode {access|trunk}", no: true, help: { switchport: "Set switching mode characteristics", mode: "Set trunking mode of the interface", access: "Set trunking mode to ACCESS unconditionally", trunk: "Set trunking mode to TRUNK unconditionally" }, run: (_a, neg) => portsOnly((c) => {
      c.mode = neg ? "dynamic" : (this.lastLit("access", "trunk") as "access" | "trunk");
    }) }, isSw);
    d({ modes: IF_MODES, syntax: ["switchport mode dynamic {auto|desirable}"], run: () => portsOnly((c) => (c.mode = "dynamic")) }, isSw);
    d({ modes: IF_MODES, syntax: ["switchport nonegotiate", "switchport trunk encapsulation dot1q"], no: true, run: () => {} }, isSw);
    d({ modes: IF_MODES, syntax: "switchport access vlan <vlan:num:1-4094>", no: true, help: { "access": "Set access mode characteristics of the interface", vlan: "Set VLAN when interface is in access mode" }, run: (a, neg) => portsOnly((c) => {
      const v = neg ? 1 : Number(a.vlan);
      if (!(v in this.sw!.cfg.vlans)) {
        this.sw!.cfg.vlans[v] = show.vlanNameDefault(v);
        this.write(`% Access VLAN does not exist. Creating vlan ${v}\n`);
      }
      c.accessVlan = v;
    }) }, isSw);
    d({ modes: IF_MODES, syntax: "switchport voice vlan <vlan:num:1-4094>", no: true, run: (a, neg) => portsOnly((c) => (c.voiceVlan = neg ? undefined : Number(a.vlan))) }, isSw);
    d({ modes: IF_MODES, syntax: "switchport trunk native vlan <vlan:num:1-4094>", no: true, help: { trunk: "Set trunking characteristics of the interface", native: "Set trunking native characteristics when interface is in trunking mode" }, run: (a, neg) => portsOnly((c) => (c.nativeVlan = neg ? 1 : Number(a.vlan))) }, isSw);
    d({ modes: IF_MODES, syntax: ["switchport trunk allowed vlan <list:vlans>", "switchport trunk allowed vlan add <list:vlans>", "switchport trunk allowed vlan remove <list:vlans>", "switchport trunk allowed vlan except <list:vlans>", "switchport trunk allowed vlan all", "switchport trunk allowed vlan none"], no: true, help: { allowed: "Set allowed VLAN characteristics when interface is in trunking mode" }, run: (a, neg) => portsOnly((c) => {
      const last = this.history[this.history.length - 1] ?? "";
      const all = Object.keys(this.sw!.cfg.vlans).map(Number);
      const cur = c.allowed === "all" ? [...Array(4094)].map((_, i) => i + 1) : c.allowed;
      if (neg || / all\s*$/.test(last)) return void (c.allowed = "all");
      if (/ none\s*$/.test(last)) return void (c.allowed = []);
      const list = expandVlans(a.list);
      if (/ add /.test(last)) c.allowed = [...new Set([...cur, ...list])].sort((x, y) => x - y);
      else if (/ remove /.test(last)) c.allowed = cur.filter((v) => !list.includes(v));
      else if (/ except /.test(last)) c.allowed = [...Array(4094)].map((_, i) => i + 1).filter((v) => !list.includes(v));
      else c.allowed = list;
      if (Array.isArray(c.allowed) && c.allowed.length >= 4094) c.allowed = "all";
      void all;
    }) }, isSw);
    d({ modes: IF_MODES, syntax: "switchport", no: true, help: { switchport: "Set switching mode characteristics" }, run: (_a, neg) => portsOnly((c) => {
      if (!this.sw!.layer3 && neg) throw new Error("Invalid input detected: this switch does not support routed ports");
      c.routed = neg;
      if (!neg) {
        c.ip = undefined;
        c.mask = undefined;
      }
    }) }, isSw);
    d({ modes: IF_MODES, syntax: ["switchport port-security", "switchport port-security maximum <n:num:1-132>", "switchport port-security violation {shutdown|restrict|protect}", "switchport port-security mac-address sticky", "switchport port-security mac-address sticky <mac:mac>", "switchport port-security mac-address <mac:mac>", "switchport port-security aging time <t:num:0-1440>"], no: true, help: { "port-security": "Security related command", maximum: "Max secure addresses", violation: "Security violation mode", "mac-address": "Secure mac address", sticky: "Configure dynamic secure addresses as sticky" }, run: (a, neg) => portsOnly((c, n) => {
      const last = (this.history[this.history.length - 1] ?? "").toLowerCase();
      if (c.mode !== "access" && !neg) throw new Error(`Command rejected: ${n} is a dynamic port.`);
      if (/max/.test(last)) c.security.max = neg ? 1 : Number(a.n);
      else if (/viol/.test(last)) c.security.violation = neg ? "shutdown" : (this.lastLit("shutdown", "restrict", "protect") as "shutdown");
      else if (/sticky/.test(last)) {
        c.security.sticky = !neg;
        if (a.mac) c.security.macs.push(normalizeMac(a.mac));
      } else if (a.mac) {
        const m = normalizeMac(a.mac);
        c.security.macs = neg ? c.security.macs.filter((x) => x !== m) : [...new Set([...c.security.macs, m])];
      } else if (/aging/.test(last)) {
        /* accepted */
      } else c.security.enabled = !neg;
    }) }, isSw);
    d({ modes: IF_MODES, syntax: ["spanning-tree portfast", "spanning-tree portfast edge", "spanning-tree portfast trunk"], no: true, help: { "spanning-tree": "Spanning Tree Subsystem", portfast: "Enable an interface to move directly to forwarding on link up" }, run: (_a, neg) => {
      portsOnly((c) => (c.portfast = !neg));
      if (!neg) this.write("%Warning: portfast should only be enabled on ports connected to a single\n host. Connecting hubs, concentrators, switches, bridges, etc... to this\n interface  when portfast is enabled, can cause temporary bridging loops.\n Use with CAUTION\n\n");
    } }, isSw);
    d({ modes: IF_MODES, syntax: ["spanning-tree bpduguard enable", "spanning-tree bpduguard disable"], no: true, help: { bpduguard: "Don't accept BPDUs on this interface" }, run: (_a, neg) => portsOnly((c) => (c.bpduguard = !neg && this.lastLit("enable", "disable") === "enable")) }, isSw);
    d({ modes: IF_MODES, syntax: ["spanning-tree cost <c:num:1-200000000>", "spanning-tree vlan <v:vlans> cost <c:num:1-200000000>"], no: true, run: (a, neg) => portsOnly((c) => (c.stpCost = neg ? undefined : Number(a.c))) }, isSw);
    d({ modes: IF_MODES, syntax: ["channel-group <g:num:1-48> mode {active|passive|on|auto|desirable}"], no: true, help: { "channel-group": "Etherchannel/port bundling configuration" }, run: (a, neg) => portsOnly((c) => (c.channelGroup = neg ? undefined : Number(a.g))) }, isSw);

    // ------------------------------------------------------- global routing
    d({ modes: ["config"], syntax: ["ip route <net:ip> <mask:mask> <hop:ip>", "ip route <net:ip> <mask:mask> <hop:ip> <ad:num:1-255>", "ip route <net:ip> <mask:mask> <if:if>", "ip route <net:ip> <mask:mask> <if:if> <ad:num:1-255>", "ip route <net:ip> <mask:mask> <if:if> <hop:ip>"], no: true, help: { route: "Establish static routes" }, run: (a, neg) => {
      const dev = this.dev as Router | Switch;
      if (this.sw && !this.sw.layer3) return this.write("% Invalid input detected: this switch does not route. Use ip default-gateway.\n");
      const routes = dev.cfg.routes;
      const net = a.net && a.mask ? networkOf(a.net, a.mask) : a.net;
      const iface = a.if ? this.canonicalIf(a.if) : undefined;
      const matchR = (r: (typeof routes)[number]) => r.network === net && r.mask === a.mask && (!a.hop || r.nextHop === a.hop) && (!iface || r.iface === iface);
      if (neg) dev.cfg.routes = routes.filter((r) => !matchR(r));
      else {
        if (a.net !== net) this.write(`%Inconsistent address and mask\n`);
        if (a.net !== net) return;
        dev.cfg.routes = routes.filter((r) => !matchR(r));
        dev.cfg.routes.push({ network: net, mask: a.mask, nextHop: a.hop, iface, ad: Number(a.ad ?? 1) });
      }
      this.commit();
    } }, () => isR() || !!this.sw?.layer3);
    d({ modes: ["config"], syntax: "ip routing", no: true, help: { routing: "Enable IP routing" }, run: (_a, neg) => {
      const dev = this.dev as Router | Switch;
      dev.cfg.ipRouting = !neg;
      this.commit();
    } }, () => isR() || !!this.sw?.layer3);
    d({ modes: ["config"], syntax: "ip default-gateway <ip:ip>", no: true, help: { "default-gateway": "Specify default gateway (if not routing IP)" }, run: (a, neg) => {
      if (this.sw) this.sw.cfg.defaultGateway = neg ? undefined : a.ip;
      this.commit();
    } }, isSw);
    d({ modes: ["config"], syntax: ["ip classless", "ip cef", "ipv6 unicast-routing", "ip subnet-zero", "ip http server", "no ip http server", "ip flow-export version <v:num:1-9>"], no: true, hidden: true, run: () => {} });
    d({ modes: ["config"], syntax: "ip name-server <ip:ip>", no: true, help: { "name-server": "Specify address of name server to use" }, run: (a, neg) => {
      const r = this.router;
      if (!r) return;
      r.cfg.nameServers = neg ? [] : [...new Set([...r.cfg.nameServers, a.ip])];
    } }, isR);
    d({ modes: ["config"], syntax: "ip host <name:word> <ip:ip>", no: true, help: { host: "Add an entry to the ip hostname table" }, run: (a, neg) => {
      const r = this.router!;
      if (neg) delete r.cfg.hosts[a.name];
      else r.cfg.hosts[a.name] = a.ip;
    } }, isR);

    const enterRouter = (proto: "rip" | "ospf" | "eigrp", id?: number) => {
      const dev = this.dev as Router | Switch;
      const c = dev.cfg.routing;
      if (proto === "rip") c.rip ??= defaultRip();
      if (proto === "ospf") {
        if (c.ospf && c.ospf.pid !== id) return this.write(`% OSPF process ${c.ospf.pid} is already running. Only one process is supported.\n`);
        c.ospf ??= defaultOspf(id!);
      }
      if (proto === "eigrp") {
        if (c.eigrp && c.eigrp.asn !== id) return this.write(`% EIGRP AS ${c.eigrp.asn} is already running. Only one AS is supported.\n`);
        c.eigrp ??= defaultEigrp(id!);
      }
      this.mode = "router";
      this.ctx = { ifaces: [], proto };
      this.commit();
    };
    const routerOk = () => isR() || !!this.sw?.layer3;
    d({ modes: ["config"], syntax: ["router rip", "router ospf <id:num:1-65535>", "router eigrp <id:num:1-65535>"], no: true, help: { router: "Enable a routing process", rip: "Routing Information Protocol (RIP)", ospf: "Open Shortest Path First (OSPF)", eigrp: "Enhanced Interior Gateway Routing Protocol (EIGRP)" }, run: (a, neg) => {
      const proto = this.lastLit("rip", "ospf", "eigrp") as "rip" | "ospf" | "eigrp";
      if (neg) {
        const dev = this.dev as Router | Switch;
        delete dev.cfg.routing[proto];
        this.commit();
        return;
      }
      enterRouter(proto, a.id ? Number(a.id) : undefined);
    } }, routerOk);
    const R = () => (this.dev as Router | Switch).cfg.routing;
    d({ modes: ["router"], syntax: ["network <net:ip>", "network <net:ip> <wc:mask>", "network <net:ip> <wc:mask> area <area:num:0-4294967295>"], no: true, help: { network: "Enable routing on an IP network", area: "Set the OSPF area ID" }, run: (a, neg) => {
      const c = R();
      if (this.ctx.proto === "rip") {
        const n = networkOf(a.net, a.net.startsWith("1") && Number(a.net.split(".")[0]) < 128 ? "255.0.0.0" : Number(a.net.split(".")[0]) < 192 ? "255.255.0.0" : "255.255.255.0");
        c.rip!.networks = neg ? c.rip!.networks.filter((x) => x !== n) : [...new Set([...c.rip!.networks, n])];
      } else if (this.ctx.proto === "ospf") {
        if (!a.wc || a.area === undefined) throw new Error("Incomplete command.");
        const e = { network: a.net, wildcard: a.wc, area: Number(a.area) };
        c.ospf!.networks = c.ospf!.networks.filter((x) => !(x.network === e.network && x.wildcard === e.wildcard));
        if (!neg) c.ospf!.networks.push(e);
      } else {
        const e = { network: a.net, wildcard: a.wc };
        c.eigrp!.networks = c.eigrp!.networks.filter((x) => !(x.network === e.network && x.wildcard === e.wildcard));
        if (!neg) c.eigrp!.networks.push(e);
      }
      this.commit();
    } });
    d({ modes: ["router"], syntax: "version {1|2}", no: true, help: { version: "Set routing protocol version" }, run: (_a, neg) => {
      if (this.ctx.proto !== "rip") throw new Error("Invalid input detected.");
      R().rip!.version = neg ? 1 : (Number(this.lastLit("1", "2")) as 1 | 2);
      this.commit();
    } });
    d({ modes: ["router"], syntax: "auto-summary", no: true, help: { "auto-summary": "Enable automatic network number summarization" }, run: (_a, neg) => {
      const c = R();
      if (this.ctx.proto === "rip") c.rip!.autoSummary = !neg;
      if (this.ctx.proto === "eigrp") c.eigrp!.autoSummary = !neg;
      this.commit();
    } });
    d({ modes: ["router"], syntax: ["passive-interface <if:if>", "passive-interface default"], no: true, help: { "passive-interface": "Suppress routing updates on an interface" }, run: (a, neg) => {
      const c = R()[this.ctx.proto!]!;
      const n = a.if ? this.canonicalIf(a.if) : "";
      if (!n) return;
      c.passive = neg ? c.passive.filter((x) => x !== n) : [...new Set([...c.passive, n])];
      this.commit();
    } });
    d({ modes: ["router"], syntax: "default-information originate", no: true, help: { "default-information": "Control distribution of default information" }, run: (_a, neg) => {
      const c = R();
      if (this.ctx.proto === "rip") c.rip!.defaultOriginate = !neg;
      if (this.ctx.proto === "ospf") c.ospf!.defaultOriginate = !neg;
      this.commit();
    } });
    d({ modes: ["router"], syntax: ["redistribute static", "redistribute connected", "redistribute static subnets", "redistribute static metric <m:num:0-16>"], no: true, help: { redistribute: "Redistribute information from another routing protocol" }, run: (_a, neg) => {
      const c = R();
      const what = this.lastLit("static", "connected");
      if (this.ctx.proto === "rip") {
        if (what === "static") c.rip!.redistributeStatic = !neg;
        else c.rip!.redistributeConnected = !neg;
      }
      if (this.ctx.proto === "eigrp") c.eigrp!.redistributeStatic = !neg;
      this.commit();
    } });
    d({ modes: ["router"], syntax: ["router-id <id:ip>", "eigrp router-id <id:ip>"], no: true, help: { "router-id": "router-id for this OSPF process" }, run: (a, neg) => {
      const c = R();
      if (this.ctx.proto === "ospf") c.ospf!.routerId = neg ? undefined : a.id;
      if (this.ctx.proto === "eigrp") c.eigrp!.routerId = neg ? undefined : a.id;
      if (this.ctx.proto === "ospf") this.write("Reload or use \"clear ip ospf process\" command, for this to take effect\n");
      this.commit();
    } });
    d({ modes: ["router"], syntax: "auto-cost reference-bandwidth <bw:num:1-4294967>", no: true, run: (a, neg) => {
      if (this.ctx.proto === "ospf") R().ospf!.refBandwidth = neg ? 100 : Number(a.bw);
      this.commit();
    } });
    d({ modes: ["router"], syntax: ["log-adjacency-changes", "maximum-paths <n:num:1-16>", "distance <n:num:1-255>", "timers basic <x:line>", "variance <n:num:1-128>", "area <x:line>"], no: true, hidden: true, run: () => {} });

    // ------------------------------------------------------------ DHCP
    d({ modes: ["config"], syntax: "ip dhcp pool <name:word>", no: true, help: { dhcp: "Configure DHCP server and relay parameters", pool: "Configure DHCP address pools" }, run: (a, neg) => {
      const r = this.router!;
      if (neg) {
        r.cfg.dhcpPools = r.cfg.dhcpPools.filter((p) => p.name !== a.name);
        return this.commit();
      }
      if (!r.cfg.dhcpPools.some((p) => p.name === a.name)) r.cfg.dhcpPools.push({ name: a.name, network: "", mask: "" });
      this.mode = "dhcp";
      this.ctx = { ifaces: [], pool: a.name };
      this.commit();
    } }, isR);
    d({ modes: ["config"], syntax: ["ip dhcp excluded-address <a:ip>", "ip dhcp excluded-address <a:ip> <b:ip>"], no: true, help: { "excluded-address": "Prevent DHCP from assigning certain addresses" }, run: (a, neg) => {
      const r = this.router!;
      const e = { from: a.a, to: a.b ?? a.a };
      r.cfg.dhcpExcluded = r.cfg.dhcpExcluded.filter((x) => !(x.from === e.from && x.to === e.to));
      if (!neg) r.cfg.dhcpExcluded.push(e);
      this.commit();
    } }, isR);
    const pool = () => this.router!.cfg.dhcpPools.find((p) => p.name === this.ctx.pool)!;
    d({ modes: ["dhcp"], syntax: ["network <net:ip> <mask:mask>", "network <net:ip> /<len:num:0-32>"], no: true, help: { network: "Network number and mask" }, run: (a, neg) => {
      const p = pool();
      p.network = neg ? "" : networkOf(a.net, a.mask);
      p.mask = neg ? "" : a.mask;
      this.commit();
    } });
    d({ modes: ["dhcp"], syntax: "default-router <ip:ip>", no: true, help: { "default-router": "Default routers" }, run: (a, neg) => void (pool().defaultRouter = neg ? undefined : a.ip) });
    d({ modes: ["dhcp"], syntax: "dns-server <ip:ip>", no: true, help: { "dns-server": "DNS servers" }, run: (a, neg) => void (pool().dns = neg ? undefined : a.ip) });
    d({ modes: ["dhcp"], syntax: "domain-name <name:word>", no: true, help: { "domain-name": "Domain name" }, run: (a, neg) => void (pool().domain = neg ? undefined : a.name) });
    d({ modes: ["dhcp"], syntax: ["lease <d:num:0-365>", "lease <d:num:0-365> <h:num:0-23>", "lease infinite"], no: true, help: { lease: "Address lease time" }, run: (a, neg) => void (pool().lease = neg ? undefined : a.d ? Number(a.d) * 86400 + Number(a.h ?? 0) * 3600 : 0x7fffffff) });

    // ------------------------------------------------------------ ACLs
    const aclDev = () => this.dev as Router | Switch;
    d({ modes: ["config"], syntax: ["access-list <n:num:1-2699> <rest:line>"], no: true, help: { "access-list": "Add an access list entry" }, run: (a, neg) => {
      const type = aclTypeForNumber(Number(a.n));
      if (!type) throw new Error("Invalid access list number");
      const acls = aclDev().cfg.acls;
      if (neg && !a.rest) {
        delete acls[a.n];
        return;
      }
      const acl: Acl = acls[a.n] ?? { type, entries: [] };
      const e = parseAclEntry(type, tokenize(a.rest ?? ""), (acl.entries.at(-1)?.seq ?? 0) + 10);
      if (typeof e === "string") throw new Error(e);
      if (neg) acl.entries = acl.entries.filter((x) => JSON.stringify({ ...x, seq: 0, matches: 0 }) !== JSON.stringify({ ...e, seq: 0, matches: 0 }));
      else acl.entries.push(e);
      acls[a.n] = acl;
    } });
    d({ modes: ["config"], syntax: ["ip access-list {standard|extended} <name:word>"], no: true, help: { "access-list": "Named access-list", standard: "Standard Access List", extended: "Extended Access List" }, run: (a, neg) => {
      const type = this.lastLit("standard", "extended") as "standard" | "extended";
      const acls = aclDev().cfg.acls;
      if (neg) {
        delete acls[a.name];
        return;
      }
      acls[a.name] ??= { type, entries: [] };
      this.mode = type === "standard" ? "acl-std" : "acl-ext";
      this.ctx = { ifaces: [], acl: a.name };
    } });
    d({ modes: ["acl-std", "acl-ext"], syntax: ["{permit|deny} <rest:line>", "<seq:num:1-2147483647> {permit|deny} <rest:line>", "remark <text:line>"], no: true, help: { permit: "Specify packets to forward", deny: "Specify packets to reject", remark: "Access list entry comment" }, run: (a, neg) => {
      const acl = aclDev().cfg.acls[this.ctx.acl!];
      const last = this.history[this.history.length - 1] ?? "";
      const words = tokenize(last.replace(/^\s*no\s+/i, ""));
      if (neg && words.length === 1 && /^\d+$/.test(words[0])) {
        acl.entries = acl.entries.filter((e) => e.seq !== Number(words[0]));
        return;
      }
      const seq = a.seq ? Number(a.seq) : (acl.entries.at(-1)?.seq ?? 0) + 10;
      const body = a.seq ? words.slice(1) : words;
      const e = parseAclEntry(acl.type, body, seq);
      if (typeof e === "string") throw new Error(e);
      if (neg) acl.entries = acl.entries.filter((x) => formatKey(x) !== formatKey(e));
      else {
        acl.entries.push(e);
        acl.entries.sort((x, y) => x.seq - y.seq);
      }
    } });
    d({ modes: ["acl-std", "acl-ext"], syntax: "<seq:num:1-2147483647>", no: true, hidden: true, run: (a, neg) => {
      if (!neg) throw new Error("Incomplete command.");
      const acl = aclDev().cfg.acls[this.ctx.acl!];
      acl.entries = acl.entries.filter((e) => e.seq !== Number(a.seq));
    } });

    // ------------------------------------------------------------- NAT
    d({ modes: ["config"], syntax: ["ip nat inside source static <local:ip> <global:ip>", "ip nat inside source static {tcp|udp} <local:ip> <lport:num:1-65535> <global:ip> <gport:num:1-65535>"], no: true, help: { nat: "NAT configuration commands", inside: "Inside address translation", source: "Source address translation", static: "Specify static local->global mapping" }, run: (a, neg) => {
      const r = this.router!;
      const proto = a.lport ? (this.lastLit("tcp", "udp") as "tcp" | "udp") : undefined;
      r.cfg.nat.statics = r.cfg.nat.statics.filter((s) => !(s.inside === a.local && s.global === a.global && s.proto === proto));
      if (!neg) r.cfg.nat.statics.push({ inside: a.local, global: a.global, proto, insidePort: a.lport ? Number(a.lport) : undefined, globalPort: a.gport ? Number(a.gport) : undefined });
    } }, isR);
    d({ modes: ["config"], syntax: ["ip nat inside source list <acl:word> interface <if:if>", "ip nat inside source list <acl:word> interface <if:if> overload", "ip nat inside source list <acl:word> pool <pool:word>", "ip nat inside source list <acl:word> pool <pool:word> overload"], no: true, help: { list: "Specify access list describing local addresses", pool: "Name pool of global addresses", overload: "Overload an address translation" }, run: (a, neg) => {
      const r = this.router!;
      const iface = a.if ? this.canonicalIf(a.if) : undefined;
      const overload = /overload\s*$/i.test(this.history.at(-1) ?? "");
      r.cfg.nat.rules = r.cfg.nat.rules.filter((x) => x.acl !== a.acl);
      if (!neg) r.cfg.nat.rules.push({ acl: a.acl, iface, pool: a.pool, overload });
    } }, isR);
    d({ modes: ["config"], syntax: ["ip nat pool <name:word> <start:ip> <end:ip> netmask <mask:mask>", "ip nat pool <name:word> <start:ip> <end:ip> prefix-length <len:num:1-32>"], no: true, help: { pool: "Define pool of addresses" }, run: (a, neg) => {
      const r = this.router!;
      if (neg) delete r.cfg.nat.pools[a.name];
      else r.cfg.nat.pools[a.name] = { start: a.start, end: a.end, mask: a.mask ?? prefixToMask(Number(a.len)) };
    } }, isR);

    // ------------------------------------------------------------ VLAN
    d({ modes: ["config", "vlan"], syntax: "vlan <list:vlans>", no: true, help: { vlan: "Vlan commands" }, run: (a, neg) => {
      const sw = this.sw!;
      const list = expandVlans(a.list).filter((v) => v >= 1 && v <= 4094);
      if (neg) {
        for (const v of list) if (v !== 1 && !(v >= 1002 && v <= 1005)) delete sw.cfg.vlans[v];
        return this.commit();
      }
      for (const v of list) sw.cfg.vlans[v] ??= show.vlanNameDefault(v);
      this.mode = "vlan";
      this.ctx = { ifaces: [], vlans: list };
      this.commit();
    } }, isSw);
    d({ modes: ["vlan"], syntax: "name <name:word>", no: true, help: { name: "Ascii name of the VLAN" }, run: (a, neg) => {
      for (const v of this.ctx.vlans ?? []) this.sw!.cfg.vlans[v] = neg ? show.vlanNameDefault(v) : a.name;
    } }, isSw);
    d({ modes: ["vlan"], syntax: ["state {active|suspend}", "shutdown"], no: true, hidden: true, run: () => {} }, isSw);
    d({ modes: ["config"], syntax: ["vtp mode {server|client|transparent|off}", "vtp domain <name:word>", "vtp password <pw:word>", "vtp version <v:num:1-3>"], no: true, help: { vtp: "Configure global VTP state" }, run: (a) => {
      const sw = this.sw!;
      const m = this.lastLit("server", "client", "transparent", "off");
      if (a.name) {
        sw.cfg.vtp.domain = a.name;
        this.write(`Changing VTP domain name from NULL to ${a.name}\n`);
      } else if (m) {
        sw.cfg.vtp.mode = m === "off" ? "transparent" : (m as "server");
        this.write(`Setting device to VTP ${m.toUpperCase()} mode.\n`);
      }
    } }, isSw);
    d({ modes: ["config"], syntax: ["spanning-tree mode {pvst|rapid-pvst|mst}"], no: true, help: { "spanning-tree": "Spanning Tree Subsystem", mode: "Spanning tree operating mode" }, run: (_a, neg) => {
      const m = this.lastLit("pvst", "rapid-pvst", "mst");
      this.sw!.cfg.stp.mode = neg || m === "mst" ? "pvst" : (m as "pvst");
      this.commit();
    } }, isSw);
    d({ modes: ["config"], syntax: ["spanning-tree vlan <v:vlans> priority <p:num:0-61440>", "spanning-tree vlan <v:vlans> root {primary|secondary}", "spanning-tree vlan <v:vlans>"], no: true, help: { priority: "Set the bridge priority for the spanning tree", root: "Configure switch as root" }, run: (a, neg) => {
      const sw = this.sw!;
      if (a.p) {
        if (Number(a.p) % 4096) return this.write("% Bridge Priority must be in increments of 4096.\n% Allowed values are:\n  0     4096  8192  12288 16384 20480 24576 28672\n  32768 36864 40960 45056 49152 53248 57344 61440\n");
        sw.cfg.stp.priority = neg ? 32768 : Number(a.p);
      } else if (this.lastLit("primary", "secondary")) sw.cfg.stp.priority = neg ? 32768 : this.lastLit("primary", "secondary") === "primary" ? 24576 : 28672;
      else sw.cfg.stp.enabled = !neg;
      this.commit();
    } }, isSw);
    d({ modes: ["config"], syntax: ["spanning-tree portfast default", "spanning-tree portfast bpduguard default", "spanning-tree extend system-id"], no: true, hidden: true, run: () => {} }, isSw);
    d({ modes: ["config"], syntax: "mac address-table aging-time <s:num:0-1000000>", no: true, run: (a, neg) => void (this.sw!.cfg.macAging = neg ? 300 : Number(a.s)) }, isSw);
    d({ modes: ["config"], syntax: "mac address-table static <mac:mac> vlan <v:num:1-4094> interface <if:if>", no: true, run: (a, neg) => {
      const sw = this.sw!;
      const key = `${a.v}|${normalizeMac(a.mac)}`;
      const p = sw.port(this.canonicalIf(a.if));
      if (!p) return this.write("% Invalid interface\n");
      if (neg) sw.macTable.delete(key);
      else sw.macTable.set(key, { port: p, time: 0, type: "static" });
    } }, isSw);

    // ------------------------------------------------------------ lines
    d({ modes: ["config", "line"], syntax: ["line console <a:num:0-0>", "line vty <a:num:0-15> <b:num:0-15>", "line vty <a:num:0-15>", "line aux <a:num:0-0>"], help: { line: "Configure a terminal line", console: "Primary terminal line", vty: "Virtual terminal" }, run: () => {
      const which = this.lastLit("console", "vty", "aux");
      this.mode = "line";
      this.ctx = { ifaces: [], line: which === "vty" ? "vty" : "con" };
    } });
    d({ modes: ["line"], syntax: ["password <pw:word>", "password <enc:num:7-7> <pw:word>"], no: true, help: { password: "Set a password" }, run: (a, neg) => {
      const ios = this.dev.ios;
      const pw = neg ? undefined : this.pwArg(a);
      if (this.ctx.line === "vty") ios.vtyPassword = pw;
      else ios.consolePassword = pw;
    } });
    d({ modes: ["line"], syntax: ["login", "login local"], no: true, help: { login: "Enable password checking", local: "Local password checking" }, run: (_a, neg) => {
      const ios = this.dev.ios;
      const local = /local\s*$/i.test(this.history.at(-1) ?? "");
      if (this.ctx.line === "vty") ios.vtyLogin = neg ? "none" : local ? "local" : "password";
      else ios.consoleLogin = !neg;
      if (!neg && !local && this.ctx.line === "vty" && !ios.vtyPassword) this.write("% Login disabled on line 1, until 'password' is set\n");
    } });
    d({ modes: ["line"], syntax: ["transport input {telnet|ssh|all|none}", "transport input telnet ssh", "transport input ssh telnet"], no: true, help: { transport: "Define transport protocols for line", input: "Define which protocols to use when connecting to the terminal server" }, run: (_a, neg) => {
      const last = (this.history.at(-1) ?? "").toLowerCase();
      this.dev.ios.vtyTransport = neg ? "all" : /telnet/.test(last) && /ssh/.test(last) ? "all" : (this.lastLit("telnet", "ssh", "all", "none") as "telnet");
    } });
    d({ modes: ["line"], syntax: ["exec-timeout <m:num:0-35791>", "exec-timeout <m:num:0-35791> <s:num:0-2147483>"], no: true, help: { "exec-timeout": "Set the EXEC timeout" }, run: (a, neg) => void (this.dev.ios.execTimeout = neg ? 10 : Number(a.m)) });
    d({ modes: ["line"], syntax: "logging synchronous", no: true, help: { logging: "Modify message logging facilities" }, run: (_a, neg) => void (this.dev.ios.logging.synchronous = !neg) });
    d({ modes: ["line"], syntax: ["privilege level <n:num:0-15>", "history size <n:num:0-256>"], no: true, hidden: true, run: () => {} });
  }

  private sviOrSubUp(n: string): boolean {
    const st = this.stack();
    return st.ifByName(n)?.isUp() ?? false;
  }

  /** Which of the given literals appears in the last command line. */
  private lastLit(...opts: string[]): string | undefined {
    const words = tokenize((this.history.at(-1) ?? "").toLowerCase());
    for (let i = words.length - 1; i >= 0; i--) {
      const hit = opts.find((o) => o.startsWith(words[i]) && words[i].length > 0 && (o === words[i] || opts.filter((x) => x.startsWith(words[i])).length === 1));
      if (hit) return hit;
    }
    return undefined;
  }

  // --------------------------------------------------------- ping/trace

  private ping(a: Args) {
    this.busy = true;
    const count = Number(a.n ?? 5);
    const size = Number(a.size ?? 100);
    const timeout = Number(a.t ?? 2) * 1000;
    this.resolveHost(a.host, (ip) => {
      if (!ip) {
        this.write("% Unrecognized host or address, or protocol not running.\n\n");
        return this.finish();
      }
      const stack = this.stack();
      let src: string | undefined;
      if (a.src) {
        if (isValidIp(a.src)) src = a.src;
        else {
          const n = normalizeIfName(a.src);
          src = n ? stack.ifByName(this.canonicalIf(n))?.ip : undefined;
          if (!src) {
            this.write("% Invalid source interface - IP not enabled or interface is down\n");
            return this.finish();
          }
        }
      }
      this.write(`Type escape sequence to abort.\nSending ${count}, ${size}-byte ICMP Echos to ${ip}, timeout is ${timeout / 1000} seconds:\n${src ? `Packet sent with a source address of ${src}\n` : ""}`);
      let i = 0;
      let ok = 0;
      const rtts: number[] = [];
      let stopped = false;
      this.abortFn = () => (stopped = true);
      const ident = stack.newEchoIdent();
      const next = () => {
        if (stopped) return;
        if (i >= count) {
          const pct = Math.floor((ok * 100) / count);
          this.write(`\nSuccess rate is ${pct} percent (${ok}/${count})${ok ? `, round-trip min/avg/max = ${Math.floor(Math.min(...rtts))}/${Math.floor(rtts.reduce((x, y) => x + y, 0) / rtts.length)}/${Math.ceil(Math.max(...rtts))} ms` : ""}\n`);
          return this.finish();
        }
        i++;
        stack.sendEcho(ip, { timeout, seq: i, ident, src }, (r) => {
          if (stopped) return;
          if (r.kind === "reply") {
            ok++;
            rtts.push(r.rtt ?? 0);
            this.write("!");
          } else if (r.kind === "unreachable") this.write("U");
          else if (r.kind === "ttl-exceeded") this.write("&");
          else this.write(".");
          next();
        });
      };
      next();
    });
  }

  private traceroute(host: string) {
    this.busy = true;
    this.resolveHost(host, (ip) => {
      if (!ip) {
        this.write("% Unrecognized host or address, or protocol not running.\n\n");
        return this.finish();
      }
      const stack = this.stack();
      this.write(`Type escape sequence to abort.\nTracing the route to ${ip}\n\n`);
      let ttl = 1;
      let stopped = false;
      this.abortFn = () => (stopped = true);
      const ident = stack.newEchoIdent();
      const hop = () => {
        if (stopped) return;
        let probe = 0;
        let line = `  ${String(ttl).padStart(2)}  `;
        let from: string | undefined;
        let reached = false;
        const fire = () => {
          if (stopped) return;
          stack.sendEcho(ip, { ttl, timeout: 3000, seq: ttl * 10 + probe, ident }, (r) => {
            if (stopped) return;
            if (r.kind === "timeout") line += "*    ";
            else {
              if (!from) {
                from = r.from;
                line += `${(r.from ?? "").padEnd(16)}`;
              }
              line += `${Math.round(r.rtt ?? 0)} msec  `;
              if (r.kind === "reply" || r.kind === "unreachable") reached = true;
            }
            probe++;
            if (probe < 3) return fire();
            this.write(line.trimEnd() + "\n");
            ttl++;
            if (reached || ttl > 30) return this.finish();
            hop();
          });
        };
        fire();
      };
      hop();
    });
  }
}

function countPrefix(tokens: string[], s: Syntax): number {
  return Math.min(tokens.length, s.tokens.length);
}

function formatKey(e: AclEntry) {
  return JSON.stringify({ ...e, seq: 0, matches: 0 });
}

function sliceInterface(cfg: string, name: string): string {
  const lines = cfg.split("\n");
  const i = lines.findIndex((l) => l === `interface ${name}`);
  if (i < 0) return "% Invalid interface";
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && lines[j] !== "!"; j++) out.push(lines[j]);
  return `Building configuration...\n\nCurrent configuration : ${out.join("\n").length} bytes\n!\n${out.join("\n")}\nend`;
}

function showStartup(dev: IosDevice): string {
  // Render startup config by temporarily swapping in the saved configuration.
  const running = dev.serializeRunning();
  const hostname = dev.hostname;
  const ios = dev.ios;
  dev.loadRunning(structuredClone(dev.startup!));
  const text = show.runningConfig(dev).replace(/^Building configuration\.\.\.\n\nCurrent configuration : (\d+) bytes/, "Using $1 bytes");
  dev.loadRunning(running);
  dev.hostname = hostname;
  dev.ios = ios;
  return text;
}

function parseAddr(t: string[], i: number): { addr: string; wc: string; next: number } | null {
  if (t[i] === "any") return { addr: "0.0.0.0", wc: "255.255.255.255", next: i + 1 };
  if (t[i] === "host" && isValidIp(t[i + 1])) return { addr: t[i + 1], wc: "0.0.0.0", next: i + 2 };
  if (isValidIp(t[i])) {
    if (isValidIp(t[i + 1])) return { addr: t[i], wc: t[i + 1], next: i + 2 };
    return { addr: t[i], wc: "0.0.0.0", next: i + 1 };
  }
  return null;
}

function parsePortMatch(t: string[], i: number): { m?: PortMatch; next: number } {
  const op = t[i];
  if (!op || !["eq", "neq", "gt", "lt", "range"].includes(op)) return { next: i };
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : PORT_NAMES[s]);
  const a = num(t[i + 1]);
  if (a === undefined) return { next: i };
  if (op === "range") return { m: { op, a, b: num(t[i + 2]) }, next: i + 3 };
  return { m: { op: op as PortMatch["op"], a }, next: i + 2 };
}

export function parseAclEntry(type: "standard" | "extended", words: string[], seq: number): AclEntry | string {
  const t = words.map((w) => w.toLowerCase());
  if (t[0] === "remark") return { seq, action: "remark", protocol: "ip", src: { addr: "0.0.0.0", wc: "255.255.255.255" }, remark: words.slice(1).join(" ") };
  const action = t[0];
  if (action !== "permit" && action !== "deny") return "Invalid input detected: expected permit, deny or remark";
  if (type === "standard") {
    const src = parseAddr(t, 1);
    if (!src) return "Invalid input detected";
    return { seq, action, protocol: "ip", src: { addr: networkOfWc(src.addr, src.wc), wc: src.wc }, log: t[src.next] === "log" };
  }
  const proto = t[1];
  if (!["ip", "icmp", "tcp", "udp", "ospf", "eigrp"].includes(proto)) return "Invalid input detected: unknown protocol";
  const src = parseAddr(t, 2);
  if (!src) return "Invalid input detected at source address";
  let i = src.next;
  const sp = parsePortMatch(t, i);
  i = sp.next;
  const dst = parseAddr(t, i);
  if (!dst) return "Invalid input detected at destination address";
  i = dst.next;
  const dp = parsePortMatch(t, i);
  i = dp.next;
  const e: AclEntry = {
    seq,
    action,
    protocol: proto as AclEntry["protocol"],
    src: { addr: networkOfWc(src.addr, src.wc), wc: src.wc },
    dst: { addr: networkOfWc(dst.addr, dst.wc), wc: dst.wc },
    srcPort: sp.m,
    dstPort: dp.m,
  };
  for (; i < t.length; i++) {
    if (t[i] === "established") e.established = true;
    else if (t[i] === "log") e.log = true;
    else if (proto === "icmp" && ICMP_NAMES.includes(t[i])) e.icmpType = t[i];
    else return `Invalid input detected at '${words[i]}'`;
  }
  return e;
}

function networkOfWc(addr: string, wc: string): string {
  return networkOf(addr, wildcardToMask(wc));
}

const SHOW_HELP: Record<string, string> = {
  show: "Show running system information",
  "running-config": "Current operating configuration",
  "startup-config": "Contents of startup configuration",
  version: "System hardware and software status",
  ip: "IP information",
  interface: "IP interface status and configuration",
  interfaces: "Interface status and configuration",
  brief: "Brief summary of IP status and configuration",
  route: "IP routing table",
  arp: "ARP table",
  cdp: "CDP information",
  lldp: "LLDP information",
  neighbors: "neighbor entries",
  clock: "Display the system clock",
  history: "Display the session command history",
  "access-lists": "List access lists",
  protocols: "IP routing protocol process parameters and statistics",
  ospf: "OSPF information",
  eigrp: "IP-EIGRP show commands",
  dhcp: "Show items in the DHCP database",
  binding: "DHCP address bindings",
  nat: "IP NAT information",
  translations: "Translation entries",
  mac: "MAC configuration",
  "address-table": "MAC forwarding table",
  vlan: "VTP VLAN status",
  trunk: "Show interface trunk information",
  status: "Show interface line status",
  "spanning-tree": "Spanning tree topology",
  "port-security": "Show secure port information",
  ssh: "Information on SSH",
  flash: "display information about flash: file system",
  logging: "Show the contents of logging buffers",
  users: "Display information about terminal lines",
};

// ---------------------------------------------------------------------------
// Remote access server (telnet/SSH vty lines)

export function installRemoteServer(dev: IosDevice & { stack: IpStack }) {
  const sessions = new Map<string, { s: CliSession; stage: "password" | "user" | "ready"; user?: string; tries: number }>();
  const handler = (proto: "telnet" | "ssh") => (data: string, _ctx: unknown, reply: (r: string | null) => void) => {
    let req: RemoteRequest;
    try {
      req = JSON.parse(data);
    } catch {
      return reply(null);
    }
    const ios = dev.ios;
    const resp = (out: string, s?: CliSession, closed = false, promptOverride?: string, hidden = false) =>
      reply(JSON.stringify({ out, prompt: promptOverride ?? s?.prompt() ?? "", hidden: hidden || !!s?.hidden, closed } satisfies RemoteResponse));
    if (req.op === "open") {
      const allowed = ios.vtyTransport === "all" || ios.vtyTransport === proto;
      if (!allowed) return reply(null);
      if (proto === "ssh" && !ios.sshKeyBits) return reply(null);
      if (proto === "telnet" && ios.vtyLogin === "none" && !ios.vtyPassword) return resp("\nPassword required, but none set\n", undefined, true);
      if (proto === "telnet" && ios.vtyLogin === "password" && !ios.vtyPassword) return resp("\nPassword required, but none set\n", undefined, true);
      const s = new CliSession(dev);
      s.vty = true;
      let buf = "";
      s.attach((t) => (buf += t));
      s.open();
      const entry = { s, stage: "ready" as "password" | "user" | "ready", user: req.user, tries: 0 };
      sessions.set(req.sid, entry);
      const banner = buf;
      if (proto === "ssh" || ios.vtyLogin === "local") {
        if (proto === "telnet") {
          entry.stage = "user";
          return resp(`${banner}\nUser Access Verification\n\n`, s, false, "Username: ");
        }
        entry.stage = "password";
        return resp(`${banner}`, s, false, "Password: ", true);
      }
      if (ios.vtyLogin === "password") {
        entry.stage = "password";
        return resp(`${banner}\nUser Access Verification\n\n`, s, false, "Password: ", true);
      }
      return resp(banner, s);
    }
    const entry = sessions.get(req.sid);
    if (!entry) return resp("", undefined, true);
    if (req.op === "close") {
      sessions.delete(req.sid);
      return resp("", undefined, true);
    }
    const line = req.line ?? "";
    const s = entry.s;
    if (entry.stage === "user") {
      entry.user = line.trim();
      entry.stage = "password";
      return resp("", s, false, "Password: ", true);
    }
    if (entry.stage === "password") {
      const ok = proto === "ssh" || ios.vtyLogin === "local" ? ios.users.some((u) => u.name === entry.user && u.secret === line) : line === ios.vtyPassword;
      if (!ok) {
        if (++entry.tries >= 3) {
          sessions.delete(req.sid);
          return resp("% Bad passwords\n", undefined, true);
        }
        return resp(proto === "ssh" ? "% Login invalid\n\n" : "% Login invalid\n\n", s, false, entry.user && ios.vtyLogin === "local" && proto === "telnet" ? "Username: " : "Password: ", entry.user === undefined || ios.vtyLogin !== "local");
      }
      entry.stage = "ready";
      return resp("\n", s);
    }
    let buf = "";
    s.detach();
    s.attach((t) => (buf += t));
    s.input(line);
    const done = () => {
      // Strip the echoed command line and trailing prompt; the client prints its own.
      let out = buf;
      const nl = out.indexOf("\n");
      out = nl >= 0 ? out.slice(nl + 1) : "";
      const p = s.prompt();
      if (out.endsWith(p)) out = out.slice(0, out.length - p.length);
      if (s.closed) sessions.delete(req.sid);
      resp(out, s, s.closed);
    };
    if (!s.busy) return done();
    const wait = () => (s.busy ? dev.schedule(50, wait) : done());
    dev.schedule(50, wait);
  };
  dev.stack.tcp.set(23, handler("telnet"));
  dev.stack.tcp.set(22, handler("ssh"));
}
