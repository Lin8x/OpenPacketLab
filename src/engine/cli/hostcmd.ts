// Command prompt for end devices, modelled on a desktop OS shell, plus the
// web browser helper.

import { isValidIp, macDashed } from "../addr";
import type { Host } from "../devices/host";
import { parseHttpResponse } from "../services";
import { tokenize } from "./parser";
import { RemoteLink } from "./remote";

export class HostPrompt {
  buffer = "";
  busy = false;
  remote?: RemoteLink;
  history: string[] = [];
  private out: (s: string) => void = () => {};
  private abortFn?: () => void;
  onClear?: () => void;

  constructor(public host: Host) {}

  attach(out: (s: string) => void) {
    this.out = out;
  }

  detach() {
    this.out = () => {};
  }

  write(s: string) {
    this.buffer += s;
    if (this.buffer.length > 200000) this.buffer = this.buffer.slice(-150000);
    this.out(s);
  }

  get hidden() {
    return !!this.remote?.hidden;
  }

  prompt() {
    return this.remote ? this.remote.prompt : "C:\\>";
  }

  open() {
    if (!this.buffer) this.write(`OpenPacketLab Command Line 1.0\nType "help" for a list of commands.\n\n${this.prompt()}`);
  }

  private finish() {
    this.busy = false;
    this.abortFn = undefined;
    this.write(`\n${this.prompt()}`);
  }

  abort() {
    if (!this.abortFn) return;
    this.abortFn();
    this.write("^C\n");
    this.finish();
  }

  input(line: string) {
    if (this.busy) return;
    if (this.remote) return this.remoteInput(line);
    this.write(`${line}\n`);
    if (line.trim()) this.history.push(line.trim());
    this.exec(line.trim());
    if (!this.busy) this.write(`${this.prompt()}`);
  }

  private remoteInput(line: string) {
    const link = this.remote!;
    this.write(link.hidden ? "\n" : `${line}\n`);
    this.busy = true;
    link.send(line, (r, err) => {
      if (!r) {
        this.write(`\nConnection to host lost: ${err}\n`);
        this.remote = undefined;
        return this.finish();
      }
      this.write(r.out);
      if (r.closed) {
        this.write(`\n[Connection to ${link.ip} closed by foreign host]\n`);
        this.remote = undefined;
        this.busy = false;
        this.write(`${this.prompt()}`);
        return;
      }
      this.busy = false;
      this.write(this.prompt());
    });
  }

  private exec(line: string) {
    if (!line) return;
    const t = tokenize(line);
    const cmd = t[0].toLowerCase();
    const args = t.slice(1);
    const h = this.host;
    switch (cmd) {
      case "help":
      case "?":
        return this.write(HELP);
      case "cls":
      case "clear":
        this.buffer = "";
        this.onClear?.();
        return;
      case "hostname":
        return this.write(`${h.hostname}\n`);
      case "ipconfig":
        return this.ipconfig(args);
      case "ping":
        return this.ping(args);
      case "tracert":
      case "traceroute":
        return this.tracert(args);
      case "arp":
        return this.arp(args);
      case "nslookup":
        return this.nslookup(args);
      case "telnet":
        if (!args[0]) return this.write("Usage: telnet <host>\n");
        return this.connect(args[0], "telnet");
      case "ssh": {
        const li = args.indexOf("-l");
        const user = li >= 0 ? args[li + 1] : undefined;
        const target = args.filter((_, i) => i !== li && i !== li + 1)[0];
        if (!user || !target) return this.write("Usage: ssh -l <username> <host>\n");
        return this.connect(target, "ssh", user);
      }
      case "netstat":
        return this.write("\nActive Connections\n\n  Proto  Local Address          Foreign Address        State\n");
      case "exit":
        return;
      default:
        this.write(`Invalid Command.\n`);
    }
  }

  private ipconfig(args: string[]) {
    const h = this.host;
    const flag = args[0]?.toLowerCase();
    if (flag === "/release") {
      if (h.ipConfig.mode !== "dhcp") return this.write("The operation failed as no adapter is in the state permissible for this operation.\n");
      h.release();
      return this.write("\n   IP Address......................: 0.0.0.0\n   Subnet Mask.....................: 0.0.0.0\n   Default Gateway.................: 0.0.0.0\n   DNS Server......................: 0.0.0.0\n");
    }
    if (flag === "/renew") {
      if (h.ipConfig.mode !== "dhcp") return this.write("The operation failed as no adapter is in the state permissible for this operation.\n");
      h.renew();
      this.busy = true;
      let waited = 0;
      const check = () => {
        if (h.dhcp.state === "bound" || h.dhcp.state === "failed" || waited > 15000) {
          if (h.dhcp.state === "bound") {
            this.write(`\n   IP Address......................: ${h.active.ip}\n   Subnet Mask.....................: ${h.active.mask}\n   Default Gateway.................: ${h.active.gateway || "0.0.0.0"}\n   DNS Server......................: ${h.active.dns || "0.0.0.0"}\n`);
          } else this.write("\nAn error occurred while renewing interface FastEthernet0 : unable to contact your DHCP server. Request has timed out.\n");
          return this.finish();
        }
        waited += 250;
        h.schedule(250, check);
      };
      h.schedule(250, check);
      return;
    }
    const all = flag === "/all";
    const a = h.active;
    const lines = ["", `${h.nic.name} Connection:(default port)`, ""];
    lines.push(`   Connection-specific DNS Suffix..: ${""}`);
    if (all) {
      lines.push(`   Physical Address................: ${macDashed(h.nic.mac)}`);
      lines.push(`   DHCP Enabled....................: ${h.ipConfig.mode === "dhcp" ? "Yes" : "No"}`);
    }
    lines.push(`   IPv4 Address....................: ${a.ip || "0.0.0.0"}`);
    lines.push(`   Subnet Mask.....................: ${a.mask || "0.0.0.0"}`);
    lines.push(`   Default Gateway.................: ${a.gateway || "0.0.0.0"}`);
    if (all) {
      lines.push(`   DHCP Server.....................: ${h.dhcp.lease?.server ?? "0.0.0.0"}`);
      lines.push(`   DNS Servers.....................: ${a.dns || "0.0.0.0"}`);
    }
    if (!h.nic.isUp) lines.push("", "   Media State.....................: Media disconnected");
    this.write(lines.join("\n") + "\n\n");
  }

  private resolve(name: string, cb: (ip: string | null) => void) {
    if (isValidIp(name)) return cb(name);
    this.host.resolver.resolve(name, this.host.active.dns || undefined, (ip) => cb(ip));
  }

  private ping(args: string[]) {
    let count = 4;
    let size = 32;
    let forever = false;
    let target: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === "-n") count = Number(args[++i]) || 4;
      else if (a === "-l") size = Number(args[++i]) || 32;
      else if (a === "-t") forever = true;
      else target = args[i];
    }
    if (!target) return this.write("\nUsage: ping [-t] [-n count] [-l size] target_name\n");
    this.busy = true;
    this.resolve(target, (ip) => {
      if (!ip) {
        this.write(`Ping request could not find host ${target}. Please check the name and try again.\n`);
        return this.finish();
      }
      const h = this.host;
      this.write(`\nPinging ${ip} with ${size} bytes of data:\n\n`);
      let sent = 0;
      let recv = 0;
      const rtts: number[] = [];
      let stopped = false;
      const ident = h.stack.newEchoIdent();
      const summary = () => {
        const lost = sent - recv;
        this.write(`\nPing statistics for ${ip}:\n    Packets: Sent = ${sent}, Received = ${recv}, Lost = ${lost} (${sent ? Math.round((lost * 100) / sent) : 0}% loss),\n`);
        if (rtts.length) this.write(`Approximate round trip times in milli-seconds:\n    Minimum = ${Math.floor(Math.min(...rtts))}ms, Maximum = ${Math.ceil(Math.max(...rtts))}ms, Average = ${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)}ms\n`);
      };
      this.abortFn = () => {
        stopped = true;
        summary();
      };
      const one = () => {
        if (stopped) return;
        if (!forever && sent >= count) {
          summary();
          return this.finish();
        }
        sent++;
        if (!h.nic.isUp || !h.active.ip) {
          this.write("PING: transmit failed. General failure. \n");
          h.schedule(1000, one);
          return;
        }
        h.stack.sendEcho(ip, { seq: sent, ident, timeout: 4000 }, (r) => {
          if (stopped) return;
          if (r.kind === "reply") {
            recv++;
            rtts.push(r.rtt ?? 0);
            const t = r.rtt ?? 0;
            this.write(`Reply from ${r.from}: bytes=${size} time${t < 1 ? "<1" : "=" + Math.round(t)}ms TTL=${r.ttl}\n`);
          } else if (r.kind === "timeout") this.write("Request timed out.\n");
          else if (r.kind === "ttl-exceeded") this.write(`Reply from ${r.from}: TTL expired in transit.\n`);
          else if (r.from) this.write(`Reply from ${r.from}: Destination ${r.code === 13 ? "host unreachable" : r.code === 1 ? "host unreachable" : "host unreachable"}.\n`);
          else this.write("Request timed out.\n");
          h.schedule(r.kind === "timeout" ? 1 : 1000, one);
        });
      };
      one();
    });
  }

  private tracert(args: string[]) {
    const target = args.find((a) => !a.startsWith("-"));
    if (!target) return this.write("\nUsage: tracert target_name\n");
    this.busy = true;
    this.resolve(target, (ip) => {
      if (!ip) {
        this.write(`Unable to resolve target system name ${target}.\n`);
        return this.finish();
      }
      const h = this.host;
      this.write(`\nTracing route to ${ip} over a maximum of 30 hops: \n\n`);
      let ttl = 1;
      let stopped = false;
      this.abortFn = () => (stopped = true);
      const ident = h.stack.newEchoIdent();
      const hop = () => {
        if (stopped) return;
        let probe = 0;
        let cols = "";
        let from = "";
        let done = false;
        const fire = () => {
          h.stack.sendEcho(ip, { ttl, seq: ttl * 10 + probe, ident, timeout: 3000 }, (r) => {
            if (stopped) return;
            if (r.kind === "timeout") cols += "*         ";
            else {
              const t = r.rtt ?? 0;
              cols += `${(t < 1 ? "<1" : String(Math.round(t))).padStart(3)} ms    `;
              from = r.from ?? from;
              if (r.kind === "reply" || (r.kind === "unreachable" && r.from)) done = true;
            }
            probe++;
            if (probe < 3) return fire();
            this.write(`${String(ttl).padStart(3)}   ${cols}${from || "Request timed out."}\n`);
            ttl++;
            if (done || ttl > 30) {
              this.write("\nTrace complete.\n");
              return this.finish();
            }
            hop();
          });
        };
        fire();
      };
      hop();
    });
  }

  private arp(args: string[]) {
    const h = this.host;
    const f = args[0]?.toLowerCase();
    if (f === "-d") {
      h.stack.clearArp();
      return;
    }
    if (f !== "-a") return this.write("\nDisplays and modifies the IP-to-Physical address translation tables.\n\nARP -a\nARP -d\n");
    const rows = h.stack.arpTable();
    if (!rows.length) return this.write("No ARP Entries Found\n");
    this.write(`\nInterface: ${h.active.ip || "0.0.0.0"} --- 0x1\n  Internet Address      Physical Address      Type\n`);
    for (const r of rows) this.write(`  ${r.ip.padEnd(22)}${macDashed(r.mac).toLowerCase().padEnd(22)}${r.static ? "static" : "dynamic"}\n`);
    this.write("\n");
  }

  private nslookup(args: string[]) {
    const name = args[0];
    const h = this.host;
    const server = h.active.dns;
    if (!name) return this.write(`\nServer: ${server || "Unknown"}\nAddress: ${server || "0.0.0.0"}\n\n`);
    this.busy = true;
    h.resolver.cache.delete(name.toLowerCase());
    h.resolver.resolve(name, server || undefined, (ip, err) => {
      this.write(`\nServer: [${server || "0.0.0.0"}]\nAddress:  ${server || "0.0.0.0"}\n\n`);
      if (ip) this.write(`Non-authoritative answer:\nName:   ${name}\nAddress:  ${ip}\n`);
      else this.write(`*** ${err === "DNS request timed out" ? "Request to " + (server || "0.0.0.0") + " timed-out" : `UnKnown can't find ${name}: Non-existent domain`}\n`);
      this.finish();
    });
  }

  private connect(target: string, proto: "telnet" | "ssh", user?: string) {
    this.busy = true;
    this.resolve(target, (ip) => {
      if (!ip) {
        this.write(`% Unknown host ${target}\n`);
        return this.finish();
      }
      this.write(proto === "telnet" ? `Trying ${ip} ...` : "");
      const link = new RemoteLink(this.host.stack, ip, proto, user);
      this.abortFn = () => (link.closed = true);
      link.open((r, err) => {
        if (!r) {
          this.write(`\n% Connection ${err === "Connection refused" ? "refused by remote host" : "timed out; remote host not responding"}\n`);
          return this.finish();
        }
        if (proto === "telnet") this.write("Open\n");
        this.write(r.out);
        if (!r.closed) this.remote = link;
        else this.write(`\n[Connection to ${ip} closed by foreign host]\n`);
        this.busy = false;
        this.abortFn = undefined;
        this.write(this.prompt());
      });
    });
  }
}

const HELP = `
Available commands:
  arp -a | -d             Show or clear the ARP cache
  cls                     Clear the screen
  hostname                Show this computer's name
  ipconfig [/all]         Show IP configuration
  ipconfig /release       Release the DHCP lease
  ipconfig /renew         Renew the DHCP lease
  nslookup <name>         Query the DNS server
  ping [-n N] [-t] <host> Send ICMP echo requests
  ssh -l <user> <host>    Open an SSH session
  telnet <host>           Open a Telnet session
  tracert <host>          Trace the route to a host
  Ctrl+C                  Stop the running command

`;

/** Fetches a URL through the simulated network. */
export function browse(host: Host, url: string, cb: (r: { ok: boolean; status?: number; body: string; error?: string; resolved?: string }) => void) {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  const m = u.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i);
  if (!m) return cb({ ok: false, body: "", error: "Invalid address" });
  const scheme = m[1].toLowerCase();
  const name = m[2];
  const port = m[3] ? Number(m[3]) : scheme === "https" ? 443 : 80;
  const path = m[4] ?? "/";
  if (!host.active.ip) return cb({ ok: false, body: "", error: "This device has no IP address." });
  const go = (ip: string) => {
    host.stack.tcpRequest(ip, port, `GET ${path} HTTP/1.1\r\nHost: ${name}\r\nUser-Agent: OpenPacketLab-Browser\r\n\r\n`, (r) => {
      if (!r.ok) return cb({ ok: false, body: "", error: r.error === "Connection refused" ? "The server refused the connection." : "Request Timeout", resolved: ip });
      const res = parseHttpResponse(r.data);
      cb({ ok: res.status === 200, status: res.status, body: res.body, resolved: ip });
    });
  };
  if (isValidIp(name)) return go(name);
  host.resolver.resolve(name, host.active.dns || undefined, (ip, err) => {
    if (!ip) return cb({ ok: false, body: "", error: err === "No DNS server configured" ? "Host name lookup failed: no DNS server is set." : "Host Name Unresolved" });
    go(ip);
  });
}
