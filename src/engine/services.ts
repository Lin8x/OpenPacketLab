// Application services shared by servers and network devices: DHCP server and
// relay, DNS server and resolver, HTTP server.

import { BROADCAST_IP, inNetwork, intToIp, ipToInt, isValidIp, networkOf, broadcastOf, type MAC } from "./addr";
import type { IpStack, L3If } from "./ipstack";
import type { DhcpMessage, DnsMessage, Ipv4Packet, UdpDatagram } from "./packets";

// ---------------------------------------------------------------------------
// DHCP server

export interface DhcpPool {
  name: string;
  network: string;
  mask: string;
  defaultRouter?: string;
  dns?: string;
  domain?: string;
  /** Lease in seconds. */
  lease?: number;
  /** Server-style pools: first address and maximum number of clients. */
  start?: string;
  max?: number;
}

export interface DhcpBinding {
  ip: string;
  mac: MAC;
  pool: string;
  expires: number;
}

export class DhcpServer {
  pools: DhcpPool[] = [];
  excluded: { from: string; to: string }[] = [];
  bindings = new Map<MAC, DhcpBinding>();
  private offered = new Map<MAC, { ip: string; pool: DhcpPool; time: number }>();
  enabled = true;
  conflicts: string[] = [];

  constructor(private stack: IpStack) {}

  reset() {
    this.bindings.clear();
    this.offered.clear();
  }

  private isExcluded(ip: string): boolean {
    const n = ipToInt(ip);
    return this.excluded.some((e) => n >= ipToInt(e.from) && n <= ipToInt(e.to));
  }

  private inUse(ip: string, mac: MAC): boolean {
    for (const b of this.bindings.values()) if (b.ip === ip && b.mac !== mac) return true;
    for (const [m, o] of this.offered) if (o.ip === ip && m !== mac) return true;
    return false;
  }

  poolFor(addr: string): DhcpPool | undefined {
    return this.pools.find((p) => p.network && p.mask && inNetwork(addr, p.network, p.mask));
  }

  private allocate(pool: DhcpPool, mac: MAC, requested?: string): string | undefined {
    const existing = this.bindings.get(mac);
    if (existing && existing.pool === pool.name) return existing.ip;
    const net = ipToInt(networkOf(pool.network, pool.mask));
    const bc = ipToInt(broadcastOf(pool.network, pool.mask));
    let first = net + 1;
    let last = bc - 1;
    if (pool.start && isValidIp(pool.start)) {
      first = Math.max(first, ipToInt(pool.start));
      if (pool.max) last = Math.min(last, first + pool.max - 1);
    }
    const own = new Set(this.stack.interfaces().map((i) => i.ip));
    const ok = (ip: string) =>
      !this.isExcluded(ip) && !this.inUse(ip, mac) && !own.has(ip) && ip !== pool.defaultRouter && ip !== pool.dns;
    if (requested && isValidIp(requested)) {
      const r = ipToInt(requested);
      if (r >= first && r <= last && ok(requested)) return requested;
    }
    for (let n = first; n <= last && n - first < 65536; n++) {
      const ip = intToIp(n);
      if (ok(ip)) return ip;
    }
    return undefined;
  }

  /** Handles a DHCP message that arrived on UDP/67. Returns true if handled. */
  handle(iface: L3If, pkt: Ipv4Packet, msg: DhcpMessage): boolean {
    if (!this.enabled) return false;
    if (msg.type !== "discover" && msg.type !== "request" && msg.type !== "release") return false;
    const anchor = msg.relayIp ?? iface.ip;
    if (!anchor) return false;
    const pool = this.poolFor(anchor);
    if (!pool) return false;
    const now = this.stack.now;
    if (msg.type === "release") {
      this.bindings.delete(msg.clientMac);
      return true;
    }
    const reply = (type: DhcpMessage["type"], ip?: string) => {
      const m: DhcpMessage = {
        kind: "dhcp",
        type,
        xid: msg.xid,
        clientMac: msg.clientMac,
        yourIp: ip,
        serverIp: iface.ip,
        mask: pool.mask,
        router: pool.defaultRouter,
        dns: pool.dns,
        domain: pool.domain,
        lease: pool.lease ?? 86400,
        relayIp: msg.relayIp,
      };
      if (msg.relayIp) this.stack.sendUdp(msg.relayIp, 67, 67, m, { src: iface.ip });
      else this.stack.sendUdp(BROADCAST_IP, 67, 68, m, { src: iface.ip, iface });
    };
    if (msg.type === "discover") {
      const ip = this.allocate(pool, msg.clientMac, msg.requestedIp);
      if (!ip) return true; // pool exhausted
      this.offered.set(msg.clientMac, { ip, pool, time: now });
      reply("offer", ip);
      return true;
    }
    // request
    if (msg.serverIp && msg.serverIp !== iface.ip && !msg.relayIp) {
      this.offered.delete(msg.clientMac); // client chose another server
      return true;
    }
    const want = msg.requestedIp;
    const offer = this.offered.get(msg.clientMac);
    const ip = want && (offer?.ip === want || this.bindings.get(msg.clientMac)?.ip === want) ? want : this.allocate(pool, msg.clientMac, want);
    if (!ip || (want && ip !== want && !inNetwork(want, pool.network, pool.mask))) {
      reply("nak");
      return true;
    }
    this.offered.delete(msg.clientMac);
    this.bindings.set(msg.clientMac, { ip, mac: msg.clientMac, pool: pool.name, expires: now + (pool.lease ?? 86400) * 1000 });
    reply("ack", ip);
    return true;
  }
}

/** `ip helper-address` relay for routers. */
export function relayDhcp(stack: IpStack, iface: L3If, pkt: Ipv4Packet, helpers: string[]) {
  const udp = pkt.payload as UdpDatagram;
  if (udp.kind !== "udp" || udp.dstPort !== 67 || udp.data.kind !== "dhcp" || !iface.ip) return;
  const msg = udp.data;
  if (msg.type === "offer" || msg.type === "ack" || msg.type === "nak") return;
  for (const h of helpers) stack.sendUdp(h, 67, 67, { ...msg, relayIp: iface.ip }, { src: iface.ip });
}

/** Router side of the relay: a server reply addressed to our giaddr. */
export function relayDhcpReply(stack: IpStack, msg: DhcpMessage): boolean {
  if (!msg.relayIp) return false;
  if (msg.type !== "offer" && msg.type !== "ack" && msg.type !== "nak") return false;
  const iface = stack.interfaces().find((i) => i.ip === msg.relayIp);
  if (!iface) return false;
  stack.sendUdp(BROADCAST_IP, 67, 68, { ...msg }, { src: iface.ip, iface });
  return true;
}

// ---------------------------------------------------------------------------
// DHCP client

export interface DhcpLease {
  ip: string;
  mask: string;
  router?: string;
  dns?: string;
  domain?: string;
  server?: string;
}

export class DhcpClient {
  state: "idle" | "selecting" | "requesting" | "bound" | "failed" = "idle";
  xid = 0;
  lease?: DhcpLease;
  private attempts = 0;
  private offer?: DhcpMessage;
  onBound?: (l: DhcpLease) => void;
  onFail?: () => void;

  constructor(
    private stack: IpStack,
    private iface: () => L3If,
    private mac: () => MAC,
  ) {}

  start() {
    this.state = "selecting";
    this.attempts = 0;
    this.lease = undefined;
    this.discover();
  }

  stop() {
    this.state = "idle";
    this.xid = 0;
  }

  release() {
    if (this.lease?.server) {
      this.stack.sendUdp(this.lease.server, 68, 67, { kind: "dhcp", type: "release", xid: this.xid, clientMac: this.mac() });
    }
    this.lease = undefined;
    this.state = "idle";
  }

  private discover() {
    if (this.state !== "selecting") return;
    this.attempts++;
    this.xid = Math.floor(Math.random() * 0x7fffffff);
    const xid = this.xid;
    this.stack.sendUdp(BROADCAST_IP, 68, 67, { kind: "dhcp", type: "discover", xid, clientMac: this.mac() }, { src: "0.0.0.0", iface: this.iface() });
    this.stack.owner.schedule(this.attempts < 4 ? 2500 : 5000, () => {
      if (this.xid !== xid || this.state === "bound" || this.state === "idle") return;
      if (this.attempts >= 4) {
        this.state = "failed";
        this.onFail?.();
        return;
      }
      this.state = "selecting";
      this.discover();
    });
  }

  handle(msg: DhcpMessage) {
    if (msg.xid !== this.xid || msg.clientMac !== this.mac()) return;
    if (msg.type === "offer" && this.state === "selecting") {
      this.offer = msg;
      this.state = "requesting";
      this.stack.sendUdp(
        BROADCAST_IP,
        68,
        67,
        { kind: "dhcp", type: "request", xid: this.xid, clientMac: this.mac(), requestedIp: msg.yourIp, serverIp: msg.serverIp, relayIp: undefined },
        { src: "0.0.0.0", iface: this.iface() },
      );
    } else if (msg.type === "ack" && this.state === "requesting") {
      this.state = "bound";
      this.lease = { ip: msg.yourIp!, mask: msg.mask!, router: msg.router, dns: msg.dns, domain: msg.domain, server: msg.serverIp ?? this.offer?.serverIp };
      this.onBound?.(this.lease);
    } else if (msg.type === "nak") {
      this.state = "selecting";
      this.stack.owner.schedule(1000, () => this.discover());
    }
  }
}

// ---------------------------------------------------------------------------
// DNS

export interface DnsRecord {
  name: string;
  type: "A" | "CNAME";
  value: string;
}

export function dnsAnswer(records: DnsRecord[], name: string): DnsMessage["answers"] {
  const out: DnsMessage["answers"] = [];
  let n = name.toLowerCase().replace(/\.$/, "");
  for (let depth = 0; depth < 8; depth++) {
    const r = records.find((x) => x.name.toLowerCase().replace(/\.$/, "") === n);
    if (!r) break;
    out.push({ name: n, type: r.type, value: r.value });
    if (r.type === "A") break;
    n = r.value.toLowerCase();
  }
  return out;
}

export function serveDns(stack: IpStack, records: () => DnsRecord[]) {
  stack.udp.set(53, (pkt, udp) => {
    const q = udp.data;
    if (q.kind !== "dns" || q.response) return;
    const answers = dnsAnswer(records(), q.name);
    const resp: DnsMessage = { ...q, response: true, answers, rcode: answers.some((a) => a.type === "A") ? "ok" : "nxdomain" };
    stack.sendUdp(pkt.src, 53, udp.srcPort, resp, { src: pkt.dst });
  });
}

export class DnsResolver {
  cache = new Map<string, { ip: string; time: number }>();
  private waiting = new Map<number, (ip: string | null, err?: string) => void>();
  private port = 0;
  constructor(private stack: IpStack) {}

  attach() {
    this.port = this.stack.ephemeralPort();
    this.stack.udp.set(this.port, (_pkt, udp) => {
      const r = udp.data;
      if (r.kind !== "dns" || !r.response) return;
      const cb = this.waiting.get(r.id);
      if (!cb) return;
      this.waiting.delete(r.id);
      const a = r.answers.find((x) => x.type === "A");
      if (a) this.cache.set(r.name.toLowerCase(), { ip: a.value, time: this.stack.now });
      cb(a ? a.value : null, a ? undefined : "Non-existent domain");
    });
  }

  resolve(name: string, server: string | undefined, cb: (ip: string | null, err?: string) => void) {
    if (isValidIp(name)) return cb(name);
    const cached = this.cache.get(name.toLowerCase());
    if (cached) return cb(cached.ip);
    if (!server) return cb(null, "No DNS server configured");
    if (!this.port) this.attach();
    const id = Math.floor(Math.random() * 65535);
    this.waiting.set(id, cb);
    this.stack.sendUdp(server, this.port, 53, { kind: "dns", id, response: false, name, qtype: "A", answers: [], rcode: "ok" });
    this.stack.owner.schedule(3000, () => {
      if (!this.waiting.has(id)) return;
      this.waiting.delete(id);
      cb(null, "DNS request timed out");
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP

export function parseHttpRequest(data: string): { method: string; path: string; host: string } {
  const [line, ...headers] = data.split("\r\n");
  const [method, path] = line.split(" ");
  const host = headers.find((h) => h.toLowerCase().startsWith("host:"))?.slice(5).trim() ?? "";
  return { method: method ?? "GET", path: path ?? "/", host };
}

export function httpResponse(status: number, body: string, type = "text/html"): string {
  const reason = status === 200 ? "OK" : status === 404 ? "Not Found" : status === 403 ? "Forbidden" : "Error";
  return `HTTP/1.1 ${status} ${reason}\r\nServer: OpenPacketLab\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
}

export function parseHttpResponse(data: string): { status: number; body: string } {
  const idx = data.indexOf("\r\n\r\n");
  const head = idx >= 0 ? data.slice(0, idx) : data;
  const body = idx >= 0 ? data.slice(idx + 4) : "";
  const status = Number(head.split(" ")[1]) || 0;
  return { status, body };
}
