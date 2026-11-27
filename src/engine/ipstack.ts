// IPv4 stack shared by end devices, routers and multilayer switches:
// ARP, routing table, ICMP, UDP/TCP demultiplexing and a small TCP model.

import {
  BROADCAST_IP,
  BROADCAST_MAC,
  ZERO_IP,
  broadcastOf,
  inNetwork,
  ipToInt,
  isMulticast,
  maskToPrefix,
  networkOf,
  type MAC,
} from "./addr";
import type { Device } from "./network";
import {
  nextIpId,
  nextUid,
  type ArpPacket,
  type EthernetFrame,
  type IcmpMessage,
  type Ipv4Packet,
  type TcpSegment,
  type UdpDatagram,
} from "./packets";

/** A layer-3 interface: physical routed port, subinterface, SVI or host NIC. */
export interface L3If {
  name: string;
  ip?: string;
  mask?: string;
  mac: MAC;
  /** Line protocol up. */
  isUp(): boolean;
  /** Puts a frame on the wire (tagging/flooding is the interface's job). */
  output(frame: EthernetFrame): void;
  ospfCost?: number;
  /** Serial point-to-point links need no address resolution. */
  pointToPoint?: boolean;
}

export type RouteCode = "C" | "L" | "S" | "R" | "O" | "D";

export interface Route {
  code: RouteCode;
  network: string;
  mask: string;
  prefix: number;
  ad: number;
  metric: number;
  nextHop?: string;
  iface?: string;
  /** For default static route marked S*. */
  candidateDefault?: boolean;
  age?: number;
  /** EIGRP path attributes. */
  eigrp?: { bw: number; delay: number };
}

export interface StaticRoute {
  network: string;
  mask: string;
  nextHop?: string;
  iface?: string;
  ad: number;
}

export interface EchoResult {
  kind: "reply" | "timeout" | "ttl-exceeded" | "unreachable";
  from?: string;
  rtt?: number;
  ttl?: number;
  code?: number;
}

interface ArpEntry {
  mac: MAC;
  iface: string;
  time: number;
  static?: boolean;
}

interface PendingArp {
  iface: L3If;
  packets: Ipv4Packet[];
  tries: number;
}

interface EchoWaiter {
  sent: number;
  cb: (r: EchoResult) => void;
  timer?: { cancel(): void };
}

interface TcpClientConn {
  dst: string;
  dstPort: number;
  srcPort: number;
  state: "syn-sent" | "established" | "closing";
  payload: string;
  cb: (r: { ok: true; data: string } | { ok: false; error: string }) => void;
  timer?: { cancel(): void };
  seq: number;
}

export type TcpHandler = (data: string, ctx: { src: string; srcPort: number; dstIp: string }, reply: (resp: string | null) => void) => void;
export type UdpHandler = (pkt: Ipv4Packet, udp: UdpDatagram, iface: L3If) => void;

export interface StackHooks {
  /** Return false to drop (ACLs). */
  filter?(dir: "in" | "out", iface: L3If, pkt: Ipv4Packet): boolean;
  /** Translate a packet entering from `iface` before routing (NAT outside→inside). */
  preRoute?(iface: L3If, pkt: Ipv4Packet): Ipv4Packet;
  /** Translate a packet after routing decision (NAT inside→outside). */
  postRoute?(inIface: L3If | null, outIface: L3If, pkt: Ipv4Packet): Ipv4Packet | null;
  /** Packet that a router will not forward but may relay (DHCP helper). */
  onBroadcast?(iface: L3If, pkt: Ipv4Packet): void;
  /** Called for routing protocol packets (OSPF). */
  onProtocol?(iface: L3If, pkt: Ipv4Packet): void;
}

const ARP_TIMEOUT = 4 * 60 * 60 * 1000;

export class IpStack {
  arp = new Map<string, ArpEntry>();
  private pending = new Map<string, PendingArp>();
  staticRoutes: StaticRoute[] = [];
  dynamic = new Map<string, Route[]>(); // by protocol
  defaultGateway?: string;
  udp = new Map<number, UdpHandler>();
  tcp = new Map<number, TcpHandler>();
  private echo = new Map<string, EchoWaiter>();
  private tcpClients = new Map<number, TcpClientConn>();
  private nextPort = 49152 + Math.floor(Math.random() * 1000);
  hooks: StackHooks = {};
  /** Routers drop the packet that triggers ARP resolution (like IOS). */
  dropOnArpMiss = false;
  /** Joined multicast groups. */
  groups = new Set<string>();
  /** Last time (sim ms) a given ICMP unreachable was sent, for rate limiting. */
  private lastUnreach = 0;

  constructor(
    public owner: Device,
    public forwarding: boolean,
    public interfaces: () => L3If[],
  ) {}

  get now() {
    return this.owner.net?.time ?? 0;
  }

  reset() {
    this.arp.clear();
    this.pending.clear();
    this.echo.clear();
    this.tcpClients.clear();
    for (const k of this.dynamic.keys()) this.dynamic.set(k, []);
  }

  ifByName(name: string): L3If | undefined {
    const n = name.toLowerCase();
    return this.interfaces().find((i) => i.name.toLowerCase() === n);
  }

  /** Interfaces that are up and have an address. */
  activeIfs(): L3If[] {
    return this.interfaces().filter((i) => i.ip && i.mask && i.isUp());
  }

  isLocalIp(ip: string): boolean {
    return this.interfaces().some((i) => i.ip === ip);
  }

  // --- routing table --------------------------------------------------------

  connectedRoutes(): Route[] {
    const out: Route[] = [];
    for (const i of this.activeIfs()) {
      const prefix = maskToPrefix(i.mask!);
      out.push({ code: "C", network: networkOf(i.ip!, i.mask!), mask: i.mask!, prefix, ad: 0, metric: 0, iface: i.name });
      if (this.forwarding)
        out.push({ code: "L", network: i.ip!, mask: "255.255.255.255", prefix: 32, ad: 0, metric: 0, iface: i.name });
    }
    return out;
  }

  /** The full routing table as `show ip route` would display. */
  routingTable(): Route[] {
    const connected = this.connectedRoutes();
    const candidates: Route[] = [...connected];
    for (const s of this.staticRoutes) {
      const prefix = maskToPrefix(s.mask);
      if (s.iface) {
        const i = this.ifByName(s.iface);
        if (!i || !i.isUp()) continue;
      } else if (s.nextHop) {
        if (!this.resolveNextHop(s.nextHop, connected, 0)) continue;
      }
      candidates.push({
        code: "S",
        network: networkOf(s.network, s.mask),
        mask: s.mask,
        prefix,
        ad: s.ad,
        metric: 0,
        nextHop: s.nextHop,
        iface: s.iface,
        candidateDefault: prefix === 0,
      });
    }
    for (const routes of this.dynamic.values()) candidates.push(...routes);
    // Keep the lowest administrative distance per prefix (ties: keep all for ECMP).
    const best = new Map<string, Route[]>();
    for (const r of candidates) {
      const key = `${r.network}/${r.prefix}`;
      const cur = best.get(key);
      if (!cur || r.ad < cur[0].ad || (r.ad === cur[0].ad && r.metric < cur[0].metric)) best.set(key, [r]);
      else if (r.ad === cur[0].ad && r.metric === cur[0].metric && !(r.code === "C" || r.code === "L")) cur.push(r);
    }
    const out = [...best.values()].flat();
    out.sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefix - b.prefix);
    return out;
  }

  private resolveNextHop(nh: string, connected: Route[], depth: number): Route | undefined {
    for (const r of connected) if (r.code === "C" && inNetwork(nh, r.network, r.mask)) return r;
    if (depth > 3) return undefined;
    return undefined;
  }

  /** Longest prefix match. Returns route and egress interface + next hop. */
  lookup(dst: string): { route: Route; iface: L3If; nextHop: string } | undefined {
    const table = this.routingTable();
    let best: Route | undefined;
    for (const r of table) {
      if (r.code === "L") continue;
      if (!inNetwork(dst, r.network, r.mask)) continue;
      if (!best || r.prefix > best.prefix) best = r;
    }
    if (!best && !this.forwarding && this.defaultGateway) {
      const gwRoute = table.find((r) => r.code === "C" && inNetwork(this.defaultGateway!, r.network, r.mask));
      if (gwRoute) {
        const iface = this.ifByName(gwRoute.iface!)!;
        return {
          route: { code: "S", network: ZERO_IP, mask: ZERO_IP, prefix: 0, ad: 1, metric: 0, nextHop: this.defaultGateway },
          iface,
          nextHop: this.defaultGateway,
        };
      }
    }
    if (!best) return undefined;
    return this.resolveRoute(best, dst, table, 0);
  }

  private resolveRoute(r: Route, dst: string, table: Route[], depth: number): { route: Route; iface: L3If; nextHop: string } | undefined {
    if (r.code === "C") {
      const iface = this.ifByName(r.iface!);
      return iface ? { route: r, iface, nextHop: dst } : undefined;
    }
    if (r.iface && !r.nextHop) {
      const iface = this.ifByName(r.iface);
      return iface ? { route: r, iface, nextHop: dst } : undefined;
    }
    if (!r.nextHop || depth > 4) return undefined;
    if (r.iface) {
      const iface = this.ifByName(r.iface);
      return iface ? { route: r, iface, nextHop: r.nextHop } : undefined;
    }
    // Recursive lookup of next hop.
    let via: Route | undefined;
    for (const c of table) {
      if (c.code === "L" || c === r) continue;
      if (!inNetwork(r.nextHop, c.network, c.mask)) continue;
      if (!via || c.prefix > via.prefix) via = c;
    }
    if (!via) return undefined;
    if (via.code === "C") {
      const iface = this.ifByName(via.iface!);
      return iface ? { route: r, iface, nextHop: r.nextHop } : undefined;
    }
    const res = this.resolveRoute(via, r.nextHop, table, depth + 1);
    return res ? { route: r, iface: res.iface, nextHop: res.nextHop } : undefined;
  }

  // --- sending --------------------------------------------------------------

  /** Sends a locally generated packet. Fills in the source address if empty. */
  send(pkt: Ipv4Packet, opts: { iface?: L3If; nextHop?: string } = {}): boolean {
    // Loopback to self.
    if (this.isLocalIp(pkt.dst)) {
      const iface = this.interfaces().find((i) => i.ip === pkt.dst)!;
      const p = { ...pkt, src: pkt.src || pkt.dst };
      this.owner.schedule(0.01, () => this.deliverLocal(iface, p));
      return true;
    }
    if (pkt.dst === BROADCAST_IP || opts.iface) {
      const iface = opts.iface ?? this.activeIfs()[0] ?? this.interfaces().find((i) => i.isUp());
      if (!iface) return false;
      const p = { ...pkt, src: pkt.src || iface.ip || ZERO_IP };
      if (pkt.dst === BROADCAST_IP || (iface.ip && iface.mask && pkt.dst === broadcastOf(iface.ip, iface.mask))) {
        return this.emitFrame(iface, BROADCAST_MAC, p);
      }
      if (isMulticast(pkt.dst)) return this.emitFrame(iface, multicastMac(pkt.dst), p);
      return this.resolveAndSend(iface, opts.nextHop ?? pkt.dst, p);
    }
    if (isMulticast(pkt.dst)) {
      let ok = false;
      for (const i of this.activeIfs()) ok = this.emitFrame(i, multicastMac(pkt.dst), { ...pkt, src: pkt.src || i.ip! }) || ok;
      return ok;
    }
    const hop = this.lookup(pkt.dst);
    if (!hop) return false;
    let p: Ipv4Packet | null = { ...pkt, src: pkt.src || hop.iface.ip || ZERO_IP };
    if (this.hooks.filter && !this.hooks.filter("out", hop.iface, p)) return false;
    if (this.hooks.postRoute) {
      p = this.hooks.postRoute(null, hop.iface, p);
      if (!p) return false;
    }
    if (hop.iface.ip && hop.iface.mask && p.dst === broadcastOf(hop.iface.ip, hop.iface.mask))
      return this.emitFrame(hop.iface, BROADCAST_MAC, p);
    return this.resolveAndSend(hop.iface, hop.nextHop, p);
  }

  private emitFrame(iface: L3If, dstMac: MAC, pkt: Ipv4Packet): boolean {
    if (!iface.isUp()) return false;
    iface.output({ uid: nextUid(), src: iface.mac, dst: dstMac, type: "ipv4", payload: pkt });
    return true;
  }

  private resolveAndSend(iface: L3If, nextHop: string, pkt: Ipv4Packet): boolean {
    if (iface.pointToPoint) return this.emitFrame(iface, BROADCAST_MAC, pkt);
    const e = this.arp.get(nextHop);
    if (e && e.iface === iface.name && (e.static || this.now - e.time < ARP_TIMEOUT)) {
      return this.emitFrame(iface, e.mac, pkt);
    }
    const key = `${iface.name}|${nextHop}`;
    const p = this.pending.get(key);
    if (p) {
      if (!this.dropOnArpMiss) p.packets.push(pkt);
      else this.owner.drop({ uid: 0, src: iface.mac, dst: BROADCAST_MAC, type: "ipv4", payload: pkt }, "ARP resolution in progress");
      return true;
    }
    const entry: PendingArp = { iface, packets: this.dropOnArpMiss ? [] : [pkt], tries: 0 };
    if (this.dropOnArpMiss)
      this.owner.drop({ uid: 0, src: iface.mac, dst: BROADCAST_MAC, type: "ipv4", payload: pkt }, "Packet dropped while resolving ARP");
    this.pending.set(key, entry);
    this.sendArpRequest(iface, nextHop, key);
    return true;
  }

  private sendArpRequest(iface: L3If, target: string, key: string) {
    const entry = this.pending.get(key);
    if (!entry) return;
    entry.tries++;
    const arp: ArpPacket = {
      kind: "arp",
      op: "request",
      senderMac: iface.mac,
      senderIp: iface.ip ?? ZERO_IP,
      targetMac: "00:00:00:00:00:00",
      targetIp: target,
    };
    if (iface.isUp()) iface.output({ uid: nextUid(), src: iface.mac, dst: BROADCAST_MAC, type: "arp", payload: arp });
    this.owner.schedule(1000, () => {
      const still = this.pending.get(key);
      if (!still || still !== entry) return;
      if (entry.tries >= 3) {
        this.pending.delete(key);
        for (const p of entry.packets)
          this.owner.drop({ uid: 0, src: iface.mac, dst: BROADCAST_MAC, type: "ipv4", payload: p }, `ARP for ${target} failed`);
        return;
      }
      this.sendArpRequest(iface, target, key);
    });
  }

  /** Sends a gratuitous ARP announcing our address. */
  gratuitousArp(iface: L3If) {
    if (!iface.ip || !iface.isUp()) return;
    iface.output({
      uid: nextUid(),
      src: iface.mac,
      dst: BROADCAST_MAC,
      type: "arp",
      payload: { kind: "arp", op: "request", senderMac: iface.mac, senderIp: iface.ip, targetMac: "00:00:00:00:00:00", targetIp: iface.ip },
    });
  }

  // --- receiving ------------------------------------------------------------

  receive(iface: L3If, frame: EthernetFrame) {
    if (frame.dst !== BROADCAST_MAC && frame.dst !== iface.mac && !frame.dst.startsWith("01:00:5e")) {
      this.owner.drop(frame, "Frame not addressed to this interface");
      return;
    }
    const p = frame.payload;
    if (p.kind === "arp") return this.handleArp(iface, p);
    if (p.kind !== "ipv4") return;
    this.handleIp(iface, p, frame);
  }

  private handleArp(iface: L3If, a: ArpPacket) {
    const forMe = iface.ip && a.targetIp === iface.ip;
    // Learn/refresh sender (only if for us or already known, like real stacks).
    if (a.senderIp !== ZERO_IP && (forMe || this.arp.has(a.senderIp))) {
      const prev = this.arp.get(a.senderIp);
      if (!prev?.static) this.arp.set(a.senderIp, { mac: a.senderMac, iface: iface.name, time: this.now });
      this.flushPending(iface, a.senderIp);
    }
    if (a.op === "request" && forMe && a.senderIp !== a.targetIp) {
      iface.output({
        uid: nextUid(),
        src: iface.mac,
        dst: a.senderMac,
        type: "arp",
        payload: { kind: "arp", op: "reply", senderMac: iface.mac, senderIp: iface.ip!, targetMac: a.senderMac, targetIp: a.senderIp },
      });
    } else if (a.op === "request" && !forMe && this.proxyArp(iface, a)) {
      // proxy ARP answered
    }
  }

  /** Routers answer ARP for remote networks they can route to (proxy ARP). */
  proxyArpEnabled = false;
  private proxyArp(iface: L3If, a: ArpPacket): boolean {
    if (!this.forwarding || !this.proxyArpEnabled || !iface.ip || !iface.mask) return false;
    if (inNetwork(a.targetIp, iface.ip, iface.mask)) return false;
    const hop = this.lookup(a.targetIp);
    if (!hop || hop.iface.name === iface.name) return false;
    iface.output({
      uid: nextUid(),
      src: iface.mac,
      dst: a.senderMac,
      type: "arp",
      payload: { kind: "arp", op: "reply", senderMac: iface.mac, senderIp: a.targetIp, targetMac: a.senderMac, targetIp: a.senderIp },
    });
    return true;
  }

  private flushPending(iface: L3If, ip: string) {
    const key = `${iface.name}|${ip}`;
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    const mac = this.arp.get(ip)!.mac;
    for (const pkt of entry.packets) this.emitFrame(iface, mac, pkt);
  }

  private handleIp(iface: L3If, pkt0: Ipv4Packet, frame: EthernetFrame) {
    if (this.hooks.filter && !this.hooks.filter("in", iface, pkt0)) {
      this.owner.drop(frame, `Denied by inbound access list on ${iface.name}`);
      return;
    }
    let pkt = pkt0;
    if (this.hooks.preRoute) pkt = this.hooks.preRoute(iface, pkt);
    const isBcast =
      pkt.dst === BROADCAST_IP || (iface.ip && iface.mask && pkt.dst === broadcastOf(iface.ip, iface.mask));
    if (isBcast) {
      this.deliverLocal(iface, pkt);
      this.hooks.onBroadcast?.(iface, pkt);
      return;
    }
    if (isMulticast(pkt.dst)) {
      if (this.groups.has(pkt.dst)) this.deliverLocal(iface, pkt);
      return;
    }
    if (this.isLocalIp(pkt.dst)) {
      this.deliverLocal(iface, pkt);
      return;
    }
    // DHCP clients without an address still need replies addressed to the offered IP.
    if (!iface.ip && pkt.protocol === "udp" && (pkt.payload as UdpDatagram).dstPort === 68) {
      this.deliverLocal(iface, pkt);
      return;
    }
    if (!this.forwarding) {
      this.owner.drop(frame, "Not the destination and IP routing is disabled");
      return;
    }
    this.forward(iface, pkt, frame);
  }

  private forward(inIface: L3If, pkt: Ipv4Packet, frame: EthernetFrame) {
    if (pkt.ttl <= 1) {
      this.owner.drop(frame, "TTL expired in transit");
      this.sendIcmpError(pkt, "time-exceeded", 0, inIface);
      return;
    }
    const hop = this.lookup(pkt.dst);
    if (!hop) {
      this.owner.drop(frame, `No route to ${pkt.dst}`);
      this.sendIcmpError(pkt, "dest-unreachable", 0, inIface);
      return;
    }
    let out: Ipv4Packet | null = { ...pkt, ttl: pkt.ttl - 1 };
    if (this.hooks.filter && !this.hooks.filter("out", hop.iface, out)) {
      this.owner.drop(frame, `Denied by outbound access list on ${hop.iface.name}`);
      this.sendIcmpError(pkt, "dest-unreachable", 13, inIface);
      return;
    }
    if (this.hooks.postRoute) {
      out = this.hooks.postRoute(inIface, hop.iface, out);
      if (!out) {
        this.owner.drop(frame, "NAT translation failed");
        return;
      }
    }
    if (hop.iface.ip && hop.iface.mask && out.dst === broadcastOf(hop.iface.ip, hop.iface.mask)) {
      this.owner.drop(frame, "Directed broadcast not forwarded");
      return;
    }
    this.resolveAndSend(hop.iface, hop.nextHop, out);
  }

  sendIcmpError(orig: Ipv4Packet, type: "time-exceeded" | "dest-unreachable", code: number, via?: L3If) {
    if (orig.protocol === "icmp") {
      const m = orig.payload as IcmpMessage;
      if (m.type !== "echo-request") return; // never answer errors with errors
    }
    if (orig.src === ZERO_IP) return;
    if (type === "dest-unreachable" && this.now - this.lastUnreach < 1 && code !== 13) return;
    this.lastUnreach = this.now;
    const m0 = orig.payload as IcmpMessage;
    const icmp: IcmpMessage = {
      kind: "icmp",
      type,
      code,
      ident: m0.kind === "icmp" ? m0.ident : 0,
      seq: m0.kind === "icmp" ? m0.seq : 0,
      original: { src: orig.src, dst: orig.dst, protocol: orig.protocol, ident: m0.ident, seq: m0.seq },
    };
    this.send({ kind: "ipv4", id: nextIpId(), src: via?.ip ?? "", dst: orig.src, ttl: 255, protocol: "icmp", payload: icmp });
  }

  deliverLocal(iface: L3If, pkt: Ipv4Packet) {
    const q = pkt.payload;
    if (q.kind === "icmp") return this.handleIcmp(iface, pkt, q);
    if (q.kind === "udp") {
      const h = this.udp.get(q.dstPort);
      if (h) h(pkt, q, iface);
      return;
    }
    if (q.kind === "tcp") return this.handleTcp(iface, pkt, q);
    if (q.kind === "ospf" || q.kind === "eigrp") this.hooks.onProtocol?.(iface, pkt);
  }

  // --- ICMP -----------------------------------------------------------------

  private handleIcmp(iface: L3If, pkt: Ipv4Packet, m: IcmpMessage) {
    if (m.type === "echo-request") {
      const src = this.isLocalIp(pkt.dst) ? pkt.dst : iface.ip ?? "";
      this.send({
        kind: "ipv4",
        id: nextIpId(),
        src,
        dst: pkt.src,
        ttl: 255,
        protocol: "icmp",
        payload: { kind: "icmp", type: "echo-reply", code: 0, ident: m.ident, seq: m.seq },
      });
      return;
    }
    const key = `${m.ident}:${m.seq}`;
    const w = this.echo.get(key);
    if (!w) return;
    this.echo.delete(key);
    w.timer?.cancel();
    const rtt = this.now - w.sent;
    if (m.type === "echo-reply") w.cb({ kind: "reply", from: pkt.src, rtt, ttl: pkt.ttl });
    else if (m.type === "time-exceeded") w.cb({ kind: "ttl-exceeded", from: pkt.src, rtt });
    else w.cb({ kind: "unreachable", from: pkt.src, code: m.code, rtt });
  }

  private echoIdent = Math.floor(Math.random() * 30000) + 1;

  /** Sends one ICMP echo. Callback fires exactly once. */
  sendEcho(dst: string, opts: { ttl?: number; timeout?: number; seq?: number; ident?: number; src?: string }, cb: (r: EchoResult) => void) {
    const ident = opts.ident ?? this.echoIdent;
    const seq = opts.seq ?? 0;
    const key = `${ident}:${seq}`;
    const w: EchoWaiter = { sent: this.now, cb };
    this.echo.set(key, w);
    w.timer = this.owner.schedule(opts.timeout ?? 2000, () => {
      if (this.echo.get(key) !== w) return;
      this.echo.delete(key);
      cb({ kind: "timeout" });
    });
    const ok = this.send({
      kind: "ipv4",
      id: nextIpId(),
      src: opts.src ?? "",
      dst,
      ttl: opts.ttl ?? (this.forwarding ? 255 : 128),
      protocol: "icmp",
      payload: { kind: "icmp", type: "echo-request", code: 0, ident, seq },
    });
    if (!ok) {
      // No route at all: report unreachable immediately (after a tick for async consistency).
      w.timer?.cancel();
      this.echo.delete(key);
      this.owner.schedule(0.01, () => cb({ kind: "unreachable", code: 0 }));
    }
  }

  newEchoIdent() {
    this.echoIdent = (this.echoIdent % 60000) + 1;
    return this.echoIdent;
  }

  // --- UDP ------------------------------------------------------------------

  sendUdp(dst: string, srcPort: number, dstPort: number, data: UdpDatagram["data"], opts: { src?: string; iface?: L3If; ttl?: number } = {}) {
    return this.send(
      {
        kind: "ipv4",
        id: nextIpId(),
        src: opts.src ?? "",
        dst,
        ttl: opts.ttl ?? 64,
        protocol: "udp",
        payload: { kind: "udp", srcPort, dstPort, data },
      },
      { iface: opts.iface },
    );
  }

  ephemeralPort() {
    this.nextPort = this.nextPort >= 65000 ? 49152 : this.nextPort + 1;
    return this.nextPort;
  }

  // --- TCP (request/response model) ----------------------------------------

  private handleTcp(iface: L3If, pkt: Ipv4Packet, s: TcpSegment) {
    // Client side?
    const c = this.tcpClients.get(s.dstPort);
    if (c && c.dst === pkt.src && c.dstPort === s.srcPort) {
      if (s.flags.rst) {
        c.timer?.cancel();
        this.tcpClients.delete(s.dstPort);
        c.cb({ ok: false, error: "Connection refused" });
        return;
      }
      if (c.state === "syn-sent" && s.flags.syn && s.flags.ack) {
        c.state = "established";
        this.tcpSend(pkt.dst, c.dst, c.srcPort, c.dstPort, { ack: true }, c.seq + 1, s.seq + 1);
        this.tcpSend(pkt.dst, c.dst, c.srcPort, c.dstPort, { ack: true, psh: true }, c.seq + 1, s.seq + 1, c.payload);
        return;
      }
      if (c.state === "established" && s.data !== undefined) {
        c.timer?.cancel();
        this.tcpClients.delete(s.dstPort);
        this.tcpSend(pkt.dst, c.dst, c.srcPort, c.dstPort, { ack: true, fin: true }, s.ack, s.seq + 1);
        c.cb({ ok: true, data: s.data });
      }
      return;
    }
    // Server side.
    const h = this.tcp.get(s.dstPort);
    if (!h) {
      if (!s.flags.rst) this.tcpSend(pkt.dst, pkt.src, s.dstPort, s.srcPort, { rst: true, ack: true }, 0, s.seq + 1);
      return;
    }
    if (s.flags.syn && !s.flags.ack) {
      this.tcpSend(pkt.dst, pkt.src, s.dstPort, s.srcPort, { syn: true, ack: true }, 1000, s.seq + 1);
      return;
    }
    if (s.data !== undefined && s.flags.psh) {
      h(s.data, { src: pkt.src, srcPort: s.srcPort, dstIp: pkt.dst }, (resp) => {
        if (resp === null) this.tcpSend(pkt.dst, pkt.src, s.dstPort, s.srcPort, { rst: true }, s.ack, s.seq + 1);
        else this.tcpSend(pkt.dst, pkt.src, s.dstPort, s.srcPort, { ack: true, psh: true, fin: true }, s.ack, s.seq + s.data!.length, resp);
      });
    }
  }

  private tcpSend(src: string, dst: string, srcPort: number, dstPort: number, flags: TcpSegment["flags"], seq: number, ack: number, data?: string) {
    this.send({
      kind: "ipv4",
      id: nextIpId(),
      src,
      dst,
      ttl: 64,
      protocol: "tcp",
      payload: { kind: "tcp", srcPort, dstPort, seq, ack, flags, data },
    });
  }

  /** Opens a TCP connection, sends `payload`, waits for one response, closes. */
  tcpRequest(dst: string, dstPort: number, payload: string, cb: TcpClientConn["cb"], timeout = 5000) {
    const srcPort = this.ephemeralPort();
    const c: TcpClientConn = { dst, dstPort, srcPort, state: "syn-sent", payload, cb, seq: Math.floor(Math.random() * 10000) };
    this.tcpClients.set(srcPort, c);
    c.timer = this.owner.schedule(timeout, () => {
      if (this.tcpClients.get(srcPort) !== c) return;
      this.tcpClients.delete(srcPort);
      cb({ ok: false, error: "Connection timed out" });
    });
    const syn = () =>
      this.send({
        kind: "ipv4",
        id: nextIpId(),
        src: "",
        dst,
        ttl: 64,
        protocol: "tcp",
        payload: { kind: "tcp", srcPort, dstPort, seq: c.seq, ack: 0, flags: { syn: true } },
      });
    const ok = syn();
    // Retransmit the SYN like a real stack (1 s, then 2 s).
    let tries = 0;
    const retry = () => {
      if (this.tcpClients.get(srcPort) !== c || c.state !== "syn-sent" || tries >= 2) return;
      tries++;
      syn();
      this.owner.schedule(1000 * (tries + 1), retry);
    };
    if (ok) this.owner.schedule(1000, retry);
    if (!ok) {
      c.timer?.cancel();
      this.tcpClients.delete(srcPort);
      this.owner.schedule(0.01, () => cb({ ok: false, error: "No route to host" }));
    }
  }

  /** Source IP the stack would use to reach `dst`. */
  sourceFor(dst: string): string | undefined {
    return this.lookup(dst)?.iface.ip;
  }

  arpTable(): { ip: string; mac: MAC; iface: string; age: number; static: boolean }[] {
    return [...this.arp.entries()]
      .filter(([, e]) => e.static || this.now - e.time < ARP_TIMEOUT)
      .map(([ip, e]) => ({ ip, mac: e.mac, iface: e.iface, age: Math.floor((this.now - e.time) / 60000), static: !!e.static }))
      .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  }

  clearArp() {
    for (const [k, v] of this.arp) if (!v.static) this.arp.delete(k);
  }
}

export function multicastMac(ip: string): MAC {
  const p = ip.split(".").map(Number);
  return ["01", "00", "5e", (p[1] & 0x7f).toString(16).padStart(2, "0"), p[2].toString(16).padStart(2, "0"), p[3].toString(16).padStart(2, "0")].join(":");
}
