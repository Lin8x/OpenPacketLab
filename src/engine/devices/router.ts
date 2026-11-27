// Router: routed Ethernet and serial interfaces, 802.1Q subinterfaces,
// loopbacks, static and dynamic routing, DHCP server/relay, ACLs and NAT/PAT.

import { isValidIp, isValidMask, matchesWildcard, ipToInt, intToIp, type MAC } from "../addr";
import { IpStack, type L3If, type StaticRoute } from "../ipstack";
import { Port, type DeviceConfig, type DeviceKind } from "../network";
import type { EthernetFrame, Ipv4Packet } from "../packets";
import { DhcpServer, relayDhcp, relayDhcpReply, type DhcpPool } from "../services";
import { AclEngine, type AclConfig } from "./acl";
import { IosDevice, LLDP_MAC, defaultIos, type IosCommon } from "./ios";
import { RoutingProcesses, defaultRouting, type RoutingConfig } from "./routing";

export interface RouterIfConfig {
  ip?: string;
  mask?: string;
  shutdown: boolean;
  description: string;
  helpers: string[];
  aclIn?: string;
  aclOut?: string;
  nat?: "inside" | "outside";
  ospfCost?: number;
  bandwidth?: number; // kbps
  clockRate?: number;
  encapsulation?: "hdlc" | "ppp";
  /** Subinterfaces: dot1Q VLAN and whether it is the native VLAN. */
  dot1q?: number;
  native?: boolean;
  mac?: MAC;
  dhcpClient?: boolean;
}

export interface NatConfig {
  statics: { inside: string; global: string; proto?: "tcp" | "udp"; insidePort?: number; globalPort?: number }[];
  pools: Record<string, { start: string; end: string; mask: string }>;
  rules: { acl: string; pool?: string; iface?: string; overload: boolean }[];
}

export interface RouterConfig extends DeviceConfig {
  hostname: string;
  ios: IosCommon;
  interfaces: Record<string, RouterIfConfig>;
  routes: StaticRoute[];
  routing: RoutingConfig;
  dhcpPools: DhcpPool[];
  dhcpExcluded: { from: string; to: string }[];
  acls: AclConfig;
  nat: NatConfig;
  nameServers: string[];
  hosts: Record<string, string>;
  ipRouting: boolean;
}

export function defaultIfConfig(): RouterIfConfig {
  return { shutdown: true, description: "", helpers: [] };
}

export interface NatEntry {
  proto: "icmp" | "tcp" | "udp" | "any";
  insideLocal: string;
  insideLocalPort?: number;
  insideGlobal: string;
  insideGlobalPort?: number;
  outside?: string;
  outsidePort?: number;
  static: boolean;
  time: number;
}

export type RouterModel = "router" | "isr";

const MODELS: Record<RouterModel, { model: string; eth: string[]; serial: string[]; speed: number }> = {
  router: {
    model: "Router R3G",
    eth: ["GigabitEthernet0/0", "GigabitEthernet0/1", "GigabitEthernet0/2"],
    serial: ["Serial0/0/0", "Serial0/0/1"],
    speed: 1000,
  },
  isr: {
    model: "Branch Router 4G",
    eth: ["GigabitEthernet0/0/0", "GigabitEthernet0/0/1", "GigabitEthernet0/0/2", "GigabitEthernet0/0/3"],
    serial: ["Serial0/1/0", "Serial0/1/1"],
    speed: 1000,
  },
};

export function shortIfName(name: string): string {
  return name
    .replace(/^GigabitEthernet/i, "Gi")
    .replace(/^FastEthernet/i, "Fa")
    .replace(/^Ethernet/i, "Eth")
    .replace(/^Serial/i, "Se")
    .replace(/^Loopback/i, "Lo")
    .replace(/^Vlan/i, "Vlan")
    .replace(/^Tunnel/i, "Tu");
}

export class Router extends IosDevice {
  readonly kind: DeviceKind = "router";
  readonly model: string;
  readonly capabilities = "R";
  readonly variant: RouterModel;
  cfg: RouterConfig;
  stack: IpStack;
  routing: RoutingProcesses;
  dhcpServer: DhcpServer;
  acl: AclEngine;
  natTable: NatEntry[] = [];
  private natPortNext = 1024;
  private ifCache = new Map<string, L3If>();

  constructor(id: string, hostname: string, variant: RouterModel = "router") {
    super(id, hostname);
    this.variant = variant;
    const m = MODELS[variant];
    this.model = m.model;
    for (const n of m.eth) this.ports.push(new Port(this, n, shortIfName(n), "copper", m.speed));
    for (const n of m.serial) this.ports.push(new Port(this, n, shortIfName(n), "serial", 1.544));
    this.ports.push(new Port(this, "Console", "Con0", "console", 0));
    this.cfg = this.defaultConfig();
    this.stack = new IpStack(this, true, () => this.l3Interfaces());
    this.stack.dropOnArpMiss = true;
    this.routing = new RoutingProcesses(this, this.stack, () => this.cfg.routing);
    this.routing.speedOf = (n) => this.ifSpeed(n);
    this.dhcpServer = new DhcpServer(this.stack);
    this.acl = new AclEngine(() => this.cfg.acls);
    this.stack.hooks.filter = (dir, iface, pkt) => {
      const c = this.cfg.interfaces[iface.name];
      const name = dir === "in" ? c?.aclIn : c?.aclOut;
      return name ? this.acl.permits(name, pkt) : true;
    };
    this.stack.hooks.onBroadcast = (iface, pkt) => {
      const helpers = this.cfg.interfaces[iface.name]?.helpers ?? [];
      if (helpers.length) relayDhcp(this.stack, iface, pkt, helpers);
    };
    this.stack.hooks.preRoute = (iface, pkt) => this.natInbound(iface, pkt);
    this.stack.hooks.postRoute = (inIf, outIf, pkt) => this.natOutbound(inIf, outIf, pkt);
    this.stack.udp.set(67, (pkt, udp, iface) => {
      if (udp.data.kind !== "dhcp") return;
      if (relayDhcpReply(this.stack, udp.data)) return;
      this.dhcpServer.handle(iface, pkt, udp.data);
    });
    this.applyConfig();
  }

  defaultConfig(): RouterConfig {
    const interfaces: Record<string, RouterIfConfig> = {};
    for (const p of this.ports) if (p.media !== "console") interfaces[p.name] = defaultIfConfig();
    return {
      hostname: this.hostname,
      ios: defaultIos(),
      interfaces,
      routes: [],
      routing: defaultRouting(),
      dhcpPools: [],
      dhcpExcluded: [],
      acls: {},
      nat: { statics: [], pools: {}, rules: [] },
      nameServers: [],
      hosts: {},
      ipRouting: true,
    };
  }

  ifCfg(name: string): RouterIfConfig {
    let c = this.cfg.interfaces[name];
    if (!c) {
      c = this.cfg.interfaces[name] = defaultIfConfig();
      // Loopbacks and subinterfaces start enabled.
      if (/^loopback/i.test(name) || name.includes(".")) c.shutdown = false;
    }
    return c;
  }

  parentPort(name: string): Port | undefined {
    return this.port(name.split(".")[0]);
  }

  ifSpeed(name: string): number {
    const c = this.cfg.interfaces[name];
    if (c?.bandwidth) return c.bandwidth / 1000;
    if (/^loopback/i.test(name)) return 8000;
    return this.parentPort(name)?.speed ?? 100;
  }

  override portPhysicallyUp(p: Port) {
    if (p.media === "console") return true;
    return !this.ifCfg(p.name).shutdown;
  }

  /** Line protocol for serial links: clock on DCE end, matching encapsulation. */
  serialProtocolUp(p: Port): boolean {
    const link = p.link;
    if (!link || !p.isUp) return false;
    const peer = link.other(p);
    const dce = link.a; // the end the cable was started from is DCE
    const dceDev = dce.device;
    if (dceDev instanceof Router && !dceDev.ifCfg(dce.name).clockRate) return false;
    const enc = (r: Port) => (r.device instanceof Router ? r.device.ifCfg(r.name).encapsulation ?? "hdlc" : "hdlc");
    return enc(p) === enc(peer);
  }

  isDce(p: Port): boolean {
    return !!p.link && p.link.a === p;
  }

  l3Interfaces(): L3If[] {
    const out: L3If[] = [];
    for (const name of Object.keys(this.cfg.interfaces)) {
      let i = this.ifCache.get(name);
      if (!i) {
        i = this.makeIf(name);
        if (!i) continue;
        this.ifCache.set(name, i);
      }
      out.push(i);
    }
    return out;
  }

  private makeIf(name: string): L3If | undefined {
    const self = this;
    const isLoop = /^loopback/i.test(name);
    const parent = isLoop ? undefined : this.parentPort(name);
    if (!isLoop && !parent) return undefined;
    const isSub = name.includes(".");
    const isSerial = parent?.media === "serial";
    return {
      name,
      get ip() {
        const c = self.cfg.interfaces[name];
        return c && isValidIp(c.ip) ? c.ip : undefined;
      },
      get mask() {
        const c = self.cfg.interfaces[name];
        return c && isValidMask(c.mask) ? c.mask : undefined;
      },
      get mac() {
        const c = self.cfg.interfaces[name];
        return c?.mac ?? parent?.mac ?? "00:00:00:00:00:00";
      },
      get ospfCost() {
        return self.cfg.interfaces[name]?.ospfCost;
      },
      pointToPoint: isSerial,
      isUp: () => {
        const c = self.cfg.interfaces[name];
        if (!c || c.shutdown) return false;
        if (isLoop) return true;
        if (!parent!.isUp) return false;
        if (isSub && c.dot1q === undefined) return false;
        if (isSerial) return self.serialProtocolUp(parent!);
        return true;
      },
      output: (f: EthernetFrame) => {
        if (isLoop || !parent) return;
        const c = self.cfg.interfaces[name];
        if (isSub && c?.dot1q !== undefined && !c.native) f = { ...f, vlan: c.dot1q };
        self.send(parent, f);
      },
    } as L3If;
  }

  applyConfig() {
    this.hostname = this.cfg.hostname;
    for (const p of this.ports) {
      if (p.media === "console") continue;
      const c = this.ifCfg(p.name);
      p.adminUp = !c.shutdown;
      p.description = c.description;
      if (c.mac) p.mac = c.mac;
    }
    for (const k of [...this.ifCache.keys()]) if (!(k in this.cfg.interfaces)) this.ifCache.delete(k);
    this.stack.forwarding = this.cfg.ipRouting;
    this.stack.staticRoutes = this.cfg.routes;
    this.dhcpServer.pools = this.cfg.dhcpPools;
    this.dhcpServer.excluded = this.cfg.dhcpExcluded;
    this.routing.apply();
  }

  override mgmtIp() {
    for (const i of this.l3Interfaces()) if (i.ip && i.isUp() && !/^loopback/i.test(i.name)) return i.ip;
    return undefined;
  }

  override receive(port: Port, frame: EthernetFrame) {
    if (port.media === "console") return;
    if (frame.dst === LLDP_MAC) {
      this.handleLldp(port, frame);
      return;
    }
    if (frame.type === "stp") return;
    let ifName = port.name;
    if (frame.vlan !== undefined) {
      const sub = Object.entries(this.cfg.interfaces).find(([n, c]) => n.startsWith(port.name + ".") && c.dot1q === frame.vlan);
      if (!sub) {
        this.drop(frame, `No subinterface for VLAN ${frame.vlan}`);
        return;
      }
      ifName = sub[0];
    } else {
      const native = Object.entries(this.cfg.interfaces).find(([n, c]) => n.startsWith(port.name + ".") && c.native);
      if (native) ifName = native[0];
    }
    const iface = this.l3Interfaces().find((i) => i.name === ifName);
    if (!iface || !iface.isUp()) {
      this.drop(frame, `Interface ${ifName} is down`);
      return;
    }
    const inner = frame.vlan !== undefined ? { ...frame, vlan: undefined } : frame;
    this.stack.receive(iface, inner);
  }

  // --- NAT ----------------------------------------------------------------

  private natRole(i: L3If | null) {
    return i ? this.cfg.interfaces[i.name]?.nat : undefined;
  }

  private l4(pkt: Ipv4Packet): { proto: NatEntry["proto"]; port?: number; dport?: number } {
    const q = pkt.payload;
    if (q.kind === "tcp") return { proto: "tcp", port: q.srcPort, dport: q.dstPort };
    if (q.kind === "udp") return { proto: "udp", port: q.srcPort, dport: q.dstPort };
    if (q.kind === "icmp") return { proto: "icmp", port: q.ident, dport: q.ident };
    return { proto: "any" };
  }

  private rewrite(pkt: Ipv4Packet, which: "src" | "dst", ip: string, port?: number): Ipv4Packet {
    const q = pkt.payload;
    let payload = q;
    if (port !== undefined) {
      if (q.kind === "tcp" || q.kind === "udp") payload = which === "src" ? { ...q, srcPort: port } : { ...q, dstPort: port };
      else if (q.kind === "icmp") payload = { ...q, ident: port };
    }
    return { ...pkt, [which]: ip, payload } as Ipv4Packet;
  }

  private natInbound(iface: L3If, pkt: Ipv4Packet): Ipv4Packet {
    if (this.natRole(iface) !== "outside") return pkt;
    const { proto, dport } = this.l4(pkt);
    // Dynamic/PAT translations.
    for (const e of this.natTable) {
      if (e.insideGlobal !== pkt.dst) continue;
      if (e.insideGlobalPort !== undefined && (e.proto !== proto || e.insideGlobalPort !== dport)) continue;
      e.time = this.net?.time ?? 0;
      return this.rewrite(pkt, "dst", e.insideLocal, e.insideGlobalPort !== undefined ? e.insideLocalPort : undefined);
    }
    for (const s of this.cfg.nat.statics) {
      if (s.global !== pkt.dst) continue;
      if (s.proto && (s.proto !== proto || s.globalPort !== dport)) continue;
      return this.rewrite(pkt, "dst", s.inside, s.proto ? s.insidePort : undefined);
    }
    return pkt;
  }

  private natOutbound(inIf: L3If | null, outIf: L3If, pkt: Ipv4Packet): Ipv4Packet | null {
    if (this.natRole(outIf) !== "outside") return pkt;
    if (inIf && this.natRole(inIf) !== "inside") return pkt;
    if (!inIf) return pkt;
    const now = this.net?.time ?? 0;
    const { proto, port } = this.l4(pkt);
    // Reply traffic from a static port mapping.
    for (const s of this.cfg.nat.statics) {
      if (s.inside !== pkt.src) continue;
      if (s.proto) {
        if (s.proto !== proto || s.insidePort !== port) continue;
        return this.rewrite(pkt, "src", s.global, s.globalPort);
      }
      this.touch({ proto: "any", insideLocal: s.inside, insideGlobal: s.global, outside: pkt.dst, static: true, time: now });
      return this.rewrite(pkt, "src", s.global);
    }
    // Existing dynamic entry.
    for (const e of this.natTable) {
      if (e.static || e.insideLocal !== pkt.src) continue;
      if (e.insideLocalPort !== undefined) {
        if (e.proto !== proto || e.insideLocalPort !== port) continue;
        e.time = now;
        return this.rewrite(pkt, "src", e.insideGlobal, e.insideGlobalPort);
      }
      e.time = now;
      return this.rewrite(pkt, "src", e.insideGlobal);
    }
    for (const r of this.cfg.nat.rules) {
      if (!this.acl.matches(r.acl, pkt)) continue;
      let global: string | undefined;
      if (r.iface) global = this.stack.ifByName(r.iface)?.ip;
      else if (r.pool) global = this.allocPoolAddress(r.pool, r.overload);
      if (!global) return null;
      if (r.overload && port !== undefined) {
        const gport = this.allocNatPort(global, proto, port);
        this.natTable.push({ proto, insideLocal: pkt.src, insideLocalPort: port, insideGlobal: global, insideGlobalPort: gport, outside: pkt.dst, outsidePort: this.l4(pkt).dport, static: false, time: now });
        return this.rewrite(pkt, "src", global, gport);
      }
      this.natTable.push({ proto: "any", insideLocal: pkt.src, insideGlobal: global, outside: pkt.dst, static: false, time: now });
      return this.rewrite(pkt, "src", global);
    }
    return pkt;
  }

  private touch(e: NatEntry) {
    if (!this.natTable.some((x) => x.static && x.insideLocal === e.insideLocal)) this.natTable.push(e);
  }

  private allocNatPort(global: string, proto: string, wanted: number): number {
    const used = (p: number) => this.natTable.some((e) => e.insideGlobal === global && e.proto === proto && e.insideGlobalPort === p);
    if (!used(wanted)) return wanted;
    for (let i = 0; i < 64000; i++) {
      this.natPortNext = this.natPortNext >= 65000 ? 1024 : this.natPortNext + 1;
      if (!used(this.natPortNext)) return this.natPortNext;
    }
    return wanted;
  }

  private allocPoolAddress(name: string, overload: boolean): string | undefined {
    const pool = this.cfg.nat.pools[name];
    if (!pool) return undefined;
    const a = ipToInt(pool.start);
    const b = ipToInt(pool.end);
    if (overload) return pool.start;
    for (let n = a; n <= b; n++) {
      const ip = intToIp(n);
      if (!this.natTable.some((e) => e.insideGlobal === ip)) return ip;
    }
    return undefined;
  }

  clearNat() {
    this.natTable = this.natTable.filter((e) => e.static);
  }

  // --- lifecycle ------------------------------------------------------------

  override start() {
    super.start();
    this.routing.start();
    this.every(10000, () => {
      const now = this.net?.time ?? 0;
      this.natTable = this.natTable.filter((e) => e.static || now - e.time < (e.insideLocalPort !== undefined ? 60000 : 86400000));
    });
  }

  override stop() {
    super.stop();
    this.stack.reset();
    this.dhcpServer.reset();
    this.routing.stop();
    this.natTable = [];
  }

  override onLinkChange(port: Port) {
    super.onLinkChange(port);
    if (port.media === "console") return;
    if (port.isUp) {
      this.schedule(5, () => {
        for (const i of this.l3Interfaces()) if (i.name.split(".")[0] === port.name && i.isUp()) this.stack.gratuitousArp(i);
      });
    }
    this.routing.linkChanged();
  }

  serializeRunning(): DeviceConfig {
    const cfg = structuredClone({ ...this.cfg, hostname: this.hostname, ios: this.ios });
    for (const p of this.ports) if (p.media !== "console") cfg.interfaces[p.name] = { ...cfg.interfaces[p.name], mac: p.mac };
    return cfg;
  }

  loadRunning(cfg: DeviceConfig) {
    const base = this.defaultConfig();
    const c = structuredClone(cfg) as Partial<RouterConfig>;
    this.cfg = {
      ...base,
      ...c,
      interfaces: { ...base.interfaces },
      nat: { ...base.nat, ...(c.nat ?? {}) },
      routing: { ...base.routing, ...(c.routing ?? {}) },
    } as RouterConfig;
    for (const [k, v] of Object.entries(c.interfaces ?? {})) this.cfg.interfaces[k] = { ...defaultIfConfig(), ...v };
    if (c.ios) this.ios = { ...defaultIos(), ...c.ios };
    this.ifCache.clear();
    this.applyConfig();
  }

  factoryReset() {
    const macs = new Map(this.ports.map((p) => [p.name, p.mac]));
    this.cfg = this.defaultConfig();
    this.ios = defaultIos();
    this.hostname = "Router";
    this.cfg.hostname = "Router";
    for (const [n, m] of macs) if (this.cfg.interfaces[n]) this.cfg.interfaces[n].mac = m;
    this.ifCache.clear();
    this.applyConfig();
  }
}

export { matchesWildcard };
