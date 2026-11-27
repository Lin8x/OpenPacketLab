// Dynamic routing: RIPv2 and OSPF (single LSDB, point-to-point and broadcast
// segments), plus EIGRP (simplified distance vector with composite metric).

import { classfulMask, inNetwork, ipToInt, matchesWildcard, maskToPrefix, networkOf, wildcardToMask } from "../addr";
import type { IpStack, L3If, Route } from "../ipstack";
import type { Device } from "../network";
import { nextIpId, type EigrpPacket, type Ipv4Packet, type OspfLsa, type OspfPacket, type RipMessage } from "../packets";

export interface RipConfig {
  version: 1 | 2;
  networks: string[];
  passive: string[];
  autoSummary: boolean;
  defaultOriginate: boolean;
  redistributeStatic: boolean;
  redistributeConnected: boolean;
}

export interface OspfConfig {
  pid: number;
  routerId?: string;
  networks: { network: string; wildcard: string; area: number }[];
  passive: string[];
  defaultOriginate: boolean;
  refBandwidth: number; // Mbps
}

export interface EigrpConfig {
  asn: number;
  routerId?: string;
  networks: { network: string; wildcard?: string }[];
  passive: string[];
  autoSummary: boolean;
  redistributeStatic: boolean;
}

export interface RoutingConfig {
  rip?: RipConfig;
  ospf?: OspfConfig;
  eigrp?: EigrpConfig;
}

export function defaultRouting(): RoutingConfig {
  return {};
}

export function defaultRip(): RipConfig {
  return { version: 1, networks: [], passive: [], autoSummary: true, defaultOriginate: false, redistributeStatic: false, redistributeConnected: false };
}

export function defaultOspf(pid: number): OspfConfig {
  return { pid, networks: [], passive: [], defaultOriginate: false, refBandwidth: 100 };
}

export function defaultEigrp(asn: number): EigrpConfig {
  return { asn, networks: [], passive: [], autoSummary: false, redistributeStatic: false };
}

const RIP_GROUP = "224.0.0.9";
const OSPF_GROUP = "224.0.0.5";
const EIGRP_GROUP = "224.0.0.10";

interface OspfNeighbor {
  rid: string;
  ip: string;
  iface: string;
  state: "INIT" | "2WAY" | "FULL";
  lastHello: number;
  priority: number;
}

interface EigrpNeighbor {
  ip: string;
  iface: string;
  lastHello: number;
  uptime: number;
  routes: NonNullable<EigrpPacket["routes"]>;
}

/** Bandwidth (kbps) and delay (tens of µs) used for the EIGRP metric. */
function eigrpIfMetric(speedMbps: number) {
  const bw = speedMbps > 0 ? speedMbps * 1000 : 1544;
  const delay = speedMbps >= 1000 ? 1 : speedMbps >= 100 ? 10 : speedMbps >= 10 ? 100 : 2000;
  return { bw, delay };
}

export class RoutingProcesses {
  private ripTimer = false;
  private ripTrigger?: { cancel(): void };
  ospfNeighbors = new Map<string, OspfNeighbor>(); // key iface|rid
  lsdb = new Map<string, OspfLsa>();
  private ospfSeq = 1;
  private spfPending?: { cancel(): void };
  eigrpNeighbors = new Map<string, EigrpNeighbor>(); // key iface|ip
  private running = false;
  /** Interface speed lookup supplied by the owning device. */
  speedOf: (iface: string) => number = () => 100;

  constructor(
    private dev: Device,
    private stack: IpStack,
    private cfg: () => RoutingConfig,
  ) {
    stack.udp.set(520, (pkt, udp, iface) => {
      if (udp.data.kind === "rip") this.onRip(iface, pkt, udp.data);
    });
    stack.hooks.onProtocol = (iface, pkt) => this.onOspfOrEigrp(iface, pkt);
  }

  get now() {
    return this.dev.net?.time ?? 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.dev.every(30000, () => this.ripPeriodic(), 2000);
    this.dev.every(1000, () => this.ripAge());
    this.dev.every(10000, () => this.ospfHello(), 200);
    this.dev.every(5000, () => this.eigrpHello(), 200);
    this.apply();
  }

  stop() {
    this.running = false;
    this.stack.dynamic.set("rip", []);
    this.stack.dynamic.set("ospf", []);
    this.stack.dynamic.set("eigrp", []);
    this.ospfNeighbors.clear();
    this.lsdb.clear();
    this.eigrpNeighbors.clear();
  }

  /** Called after configuration changes. */
  apply() {
    const c = this.cfg();
    if (c.rip) this.stack.groups.add(RIP_GROUP);
    else {
      this.stack.groups.delete(RIP_GROUP);
      this.stack.dynamic.set("rip", []);
    }
    if (c.ospf) this.stack.groups.add(OSPF_GROUP);
    else {
      this.stack.groups.delete(OSPF_GROUP);
      this.stack.dynamic.set("ospf", []);
      this.ospfNeighbors.clear();
      this.lsdb.clear();
    }
    if (c.eigrp) this.stack.groups.add(EIGRP_GROUP);
    else {
      this.stack.groups.delete(EIGRP_GROUP);
      this.stack.dynamic.set("eigrp", []);
      this.eigrpNeighbors.clear();
    }
    if (!this.running || !this.dev.net) return;
    if (c.rip) this.triggerRip();
    if (c.ospf) {
      this.dev.schedule(50, () => this.ospfHello());
      this.originateLsa();
    }
    if (c.eigrp) this.dev.schedule(50, () => this.eigrpHello());
  }

  linkChanged() {
    if (!this.running) return;
    const c = this.cfg();
    if (c.rip) {
      // Drop routes learned through interfaces that went down.
      const up = new Set(this.stack.activeIfs().map((i) => i.name));
      const routes = (this.stack.dynamic.get("rip") ?? []).filter((r) => up.has(r.iface!));
      this.stack.dynamic.set("rip", routes);
      this.triggerRip();
    }
    if (c.ospf) {
      const up = new Set(this.stack.activeIfs().map((i) => i.name));
      for (const [k, n] of this.ospfNeighbors) if (!up.has(n.iface)) this.ospfNeighbors.delete(k);
      this.originateLsa();
    }
    if (c.eigrp) {
      const up = new Set(this.stack.activeIfs().map((i) => i.name));
      for (const [k, n] of this.eigrpNeighbors) if (!up.has(n.iface)) this.eigrpNeighbors.delete(k);
      this.eigrpCompute();
      this.dev.schedule(20, () => this.eigrpUpdate());
    }
  }

  // ---------------------------------------------------------------- RIP

  private ripIfs(): L3If[] {
    const c = this.cfg().rip;
    if (!c) return [];
    return this.stack.activeIfs().filter((i) =>
      c.networks.some((n) => inNetwork(i.ip!, n, classfulMask(n)) || inNetwork(i.ip!, n, classfulMask(i.ip!))),
    );
  }

  private triggerRip() {
    if (this.ripTrigger) return;
    this.ripTrigger = this.dev.schedule(800 + Math.random() * 400, () => {
      this.ripTrigger = undefined;
      this.ripSend();
    });
  }

  private ripPeriodic() {
    if (this.cfg().rip) this.ripSend();
  }

  private ripSend() {
    const c = this.cfg().rip;
    if (!c) return;
    const ifs = this.ripIfs();
    const learned = this.stack.dynamic.get("rip") ?? [];
    for (const out of ifs) {
      if (c.passive.includes(out.name)) continue;
      const routes: RipMessage["routes"] = [];
      const seen = new Set<string>();
      const add = (network: string, mask: string, metric: number) => {
        let net = network;
        let m = mask;
        if (c.autoSummary || c.version === 1) {
          const cm = classfulMask(network);
          if (!inNetwork(out.ip!, network, cm) && maskToPrefix(mask) >= maskToPrefix(cm)) {
            net = networkOf(network, cm);
            m = cm;
          }
        }
        const k = `${net}/${m}`;
        if (seen.has(k)) return;
        seen.add(k);
        routes.push({ network: net, mask: m, metric });
      };
      for (const i of ifs) add(networkOf(i.ip!, i.mask!), i.mask!, 1);
      if (c.redistributeConnected)
        for (const i of this.stack.activeIfs()) add(networkOf(i.ip!, i.mask!), i.mask!, 1);
      for (const r of learned) {
        if (r.iface === out.name) {
          // Split horizon with poison reverse.
          continue;
        }
        add(r.network, r.mask, Math.min(16, r.metric + 1));
      }
      const table = this.stack.routingTable();
      if (c.redistributeStatic) for (const r of table) if (r.code === "S" && r.prefix > 0) add(r.network, r.mask, 1);
      if (c.defaultOriginate && table.some((r) => r.code === "S" && r.prefix === 0)) add("0.0.0.0", "0.0.0.0", 1);
      if (!routes.length) continue;
      this.stack.sendUdp(RIP_GROUP, 520, 520, { kind: "rip", command: "response", version: 2, routes }, { iface: out, src: out.ip, ttl: 1 });
    }
  }

  private onRip(iface: L3If, pkt: Ipv4Packet, msg: RipMessage) {
    const c = this.cfg().rip;
    if (!c || msg.command !== "response") return;
    if (!this.ripIfs().some((i) => i.name === iface.name)) return;
    if (!iface.ip || !iface.mask || !inNetwork(pkt.src, iface.ip, iface.mask)) return;
    const routes = [...(this.stack.dynamic.get("rip") ?? [])];
    let changed = false;
    const connected = this.stack.connectedRoutes();
    for (const r of msg.routes) {
      if (connected.some((cr) => cr.network === r.network && cr.mask === r.mask)) continue;
      const metric = Math.min(16, r.metric);
      const idx = routes.findIndex((x) => x.network === r.network && x.mask === r.mask);
      const cur = idx >= 0 ? routes[idx] : undefined;
      if (metric >= 16) {
        if (cur && cur.nextHop === pkt.src) {
          routes.splice(idx, 1);
          changed = true;
        }
        continue;
      }
      const entry: Route = {
        code: "R",
        network: r.network,
        mask: r.mask,
        prefix: maskToPrefix(r.mask),
        ad: 120,
        metric,
        nextHop: pkt.src,
        iface: iface.name,
        age: this.now,
      };
      if (!cur) {
        routes.push(entry);
        changed = true;
      } else if (cur.nextHop === pkt.src) {
        if (cur.metric !== metric) changed = true;
        routes[idx] = entry;
      } else if (metric < cur.metric) {
        routes[idx] = entry;
        changed = true;
      } else if (metric === cur.metric) {
        // Equal-cost path: keep both.
        if (!routes.some((x) => x.network === r.network && x.mask === r.mask && x.nextHop === pkt.src)) {
          routes.push(entry);
        } else {
          const j = routes.findIndex((x) => x.network === r.network && x.mask === r.mask && x.nextHop === pkt.src);
          routes[j] = entry;
        }
      }
    }
    this.stack.dynamic.set("rip", routes);
    if (changed) this.triggerRip();
  }

  private ripAge() {
    const routes = this.stack.dynamic.get("rip");
    if (!routes?.length) return;
    const fresh = routes.filter((r) => this.now - (r.age ?? 0) < 180000);
    if (fresh.length !== routes.length) {
      this.stack.dynamic.set("rip", fresh);
      this.triggerRip();
    }
  }

  // ---------------------------------------------------------------- OSPF

  routerId(): string {
    const c = this.cfg();
    const explicit = c.ospf?.routerId ?? c.eigrp?.routerId;
    if (explicit) return explicit;
    const ips = this.stack
      .interfaces()
      .filter((i) => i.ip)
      .map((i) => i.ip!);
    const loop = this.stack.interfaces().filter((i) => i.ip && /^loopback/i.test(i.name)).map((i) => i.ip!);
    const pool = loop.length ? loop : ips;
    if (!pool.length) return "0.0.0.0";
    return pool.reduce((a, b) => (ipToInt(b) > ipToInt(a) ? b : a));
  }

  ospfIfs(): { iface: L3If; area: number }[] {
    const c = this.cfg().ospf;
    if (!c) return [];
    const out: { iface: L3If; area: number }[] = [];
    for (const i of this.stack.activeIfs()) {
      const n = c.networks.find((n) => matchesWildcard(i.ip!, n.network, n.wildcard));
      if (n) out.push({ iface: i, area: n.area });
    }
    return out;
  }

  ospfCost(i: L3If): number {
    if (i.ospfCost) return i.ospfCost;
    if (/^loopback/i.test(i.name)) return 1;
    const ref = this.cfg().ospf?.refBandwidth ?? 100;
    return Math.max(1, Math.floor(ref / Math.max(0.001, this.speedOf(i.name))));
  }

  private ospfSendTo(iface: L3If, p: OspfPacket) {
    this.stack.send(
      { kind: "ipv4", id: nextIpId(), src: iface.ip!, dst: OSPF_GROUP, ttl: 1, protocol: "ospf", payload: p },
      { iface },
    );
  }

  private ospfHello() {
    const c = this.cfg().ospf;
    if (!c) return;
    const rid = this.routerId();
    let changed = false;
    for (const [k, n] of this.ospfNeighbors) {
      if (this.now - n.lastHello > 40000) {
        this.ospfNeighbors.delete(k);
        this.dev.log(`%OSPF-5-ADJCHG: Process ${c.pid}, Nbr ${n.rid} on ${n.iface} from FULL to DOWN, Neighbor Down: Dead timer expired`);
        changed = true;
      }
    }
    for (const { iface, area } of this.ospfIfs()) {
      if (c.passive.includes(iface.name)) continue;
      const neighbors = [...this.ospfNeighbors.values()].filter((n) => n.iface === iface.name).map((n) => n.rid);
      this.ospfSendTo(iface, { kind: "ospf", type: "hello", routerId: rid, area, neighbors, helloInterval: 10, deadInterval: 40 });
    }
    if (changed) this.originateLsa();
  }

  private onOspfOrEigrp(iface: L3If, pkt: Ipv4Packet) {
    const p = pkt.payload;
    if (p.kind === "eigrp") return this.onEigrp(iface, pkt, p);
    if (p.kind !== "ospf") return;
    const c = this.cfg().ospf;
    if (!c) return;
    const mine = this.ospfIfs().find((x) => x.iface.name === iface.name);
    if (!mine) return;
    const rid = this.routerId();
    if (p.type === "hello") {
      if (c.passive.includes(iface.name)) return;
      if (p.area !== mine.area) return;
      if (p.routerId === rid) return;
      const key = `${iface.name}|${p.routerId}`;
      let n = this.ospfNeighbors.get(key);
      const seesMe = (p.neighbors ?? []).includes(rid);
      if (!n) {
        n = { rid: p.routerId, ip: pkt.src, iface: iface.name, state: "INIT", lastHello: this.now, priority: 1 };
        this.ospfNeighbors.set(key, n);
        // Reply quickly so the adjacency forms without waiting a full interval.
        this.dev.schedule(5, () => this.ospfHello());
      }
      n.lastHello = this.now;
      n.ip = pkt.src;
      if (seesMe && n.state !== "FULL") {
        n.state = "FULL";
        this.dev.log(`%OSPF-5-ADJCHG: Process ${c.pid}, Nbr ${n.rid} on ${iface.name} from LOADING to FULL, Loading Done`);
        this.originateLsa();
        // Database synchronisation: send everything we know.
        for (const lsa of this.lsdb.values()) this.ospfSendTo(iface, { kind: "ospf", type: "lsu", routerId: rid, area: mine.area, lsa });
      }
      return;
    }
    if (p.type === "lsu" && p.lsa) {
      const cur = this.lsdb.get(p.lsa.routerId);
      if (p.lsa.routerId === rid) {
        // Our own old LSA came back: bump sequence so ours wins.
        if (!cur || p.lsa.seq >= cur.seq) {
          this.ospfSeq = p.lsa.seq + 1;
          this.originateLsa();
        }
        return;
      }
      if (cur && cur.seq >= p.lsa.seq) return;
      this.lsdb.set(p.lsa.routerId, p.lsa);
      this.flood(p.lsa, iface.name);
      this.scheduleSpf();
    }
  }

  private flood(lsa: OspfLsa, except?: string) {
    const rid = this.routerId();
    for (const { iface, area } of this.ospfIfs()) {
      if (iface.name === except) continue;
      if (![...this.ospfNeighbors.values()].some((n) => n.iface === iface.name && n.state === "FULL")) continue;
      this.ospfSendTo(iface, { kind: "ospf", type: "lsu", routerId: rid, area, lsa });
    }
  }

  private originateLsa() {
    const c = this.cfg().ospf;
    if (!c) return;
    const rid = this.routerId();
    const links: OspfLsa["links"] = [];
    for (const { iface } of this.ospfIfs()) {
      const cost = this.ospfCost(iface);
      links.push({ network: networkOf(iface.ip!, iface.mask!), mask: iface.mask!, cost });
      for (const n of this.ospfNeighbors.values())
        if (n.iface === iface.name && n.state === "FULL") links.push({ network: n.ip, mask: "255.255.255.255", cost, neighbor: n.rid });
    }
    if (c.defaultOriginate && this.stack.staticRoutes.some((s) => s.mask === "0.0.0.0")) links.push({ network: "0.0.0.0", mask: "0.0.0.0", cost: 1 });
    const lsa: OspfLsa = { routerId: rid, seq: this.ospfSeq++, area: this.ospfIfs()[0]?.area ?? 0, links };
    this.lsdb.set(rid, lsa);
    this.flood(lsa);
    this.scheduleSpf();
  }

  private scheduleSpf() {
    if (this.spfPending) return;
    this.spfPending = this.dev.schedule(50, () => {
      this.spfPending = undefined;
      this.spf();
    });
  }

  private spf() {
    const rid = this.routerId();
    const dist = new Map<string, number>([[rid, 0]]);
    const first = new Map<string, OspfNeighbor | undefined>([[rid, undefined]]);
    const done = new Set<string>();
    for (;;) {
      let u: string | undefined;
      let best = Infinity;
      for (const [k, d] of dist) if (!done.has(k) && d < best) ((best = d), (u = k));
      if (!u) break;
      done.add(u);
      const lsa = this.lsdb.get(u);
      if (!lsa) continue;
      for (const l of lsa.links) {
        if (!l.neighbor) continue;
        const peer = this.lsdb.get(l.neighbor);
        if (!peer || !peer.links.some((x) => x.neighbor === u)) continue; // two-way check
        const nd = best + l.cost;
        if (nd < (dist.get(l.neighbor) ?? Infinity)) {
          dist.set(l.neighbor, nd);
          if (u === rid) {
            const nb = [...this.ospfNeighbors.values()].find((n) => n.rid === l.neighbor && n.ip === l.network && n.state === "FULL");
            first.set(l.neighbor, nb);
          } else first.set(l.neighbor, first.get(u));
        }
      }
    }
    const connected = this.stack.connectedRoutes();
    const routes = new Map<string, Route>();
    for (const [node, d] of dist) {
      if (node === rid) continue;
      const nb = first.get(node);
      if (!nb) continue;
      const lsa = this.lsdb.get(node)!;
      for (const l of lsa.links) {
        if (l.neighbor) continue;
        if (connected.some((c) => c.network === l.network && c.mask === l.mask)) continue;
        const key = `${l.network}/${l.mask}`;
        const metric = d + l.cost;
        const cur = routes.get(key);
        if (cur && cur.metric <= metric) continue;
        routes.set(key, {
          code: "O",
          network: l.network,
          mask: l.mask,
          prefix: maskToPrefix(l.mask),
          ad: 110,
          metric: l.mask === "0.0.0.0" ? 1 : metric + (this.ifCostTo(nb) - this.ifCostTo(nb)),
          nextHop: nb.ip,
          iface: nb.iface,
        });
      }
    }
    this.stack.dynamic.set("ospf", [...routes.values()]);
  }

  private ifCostTo(_n: OspfNeighbor) {
    return 0;
  }

  // ---------------------------------------------------------------- EIGRP

  private eigrpIfs(): L3If[] {
    const c = this.cfg().eigrp;
    if (!c) return [];
    return this.stack.activeIfs().filter((i) =>
      c.networks.some((n) =>
        n.wildcard ? matchesWildcard(i.ip!, n.network, n.wildcard) : inNetwork(i.ip!, n.network, classfulMask(n.network)),
      ),
    );
  }

  private eigrpSend(iface: L3If, p: EigrpPacket) {
    this.stack.send(
      { kind: "ipv4", id: nextIpId(), src: iface.ip!, dst: EIGRP_GROUP, ttl: 1, protocol: "eigrp", payload: p },
      { iface },
    );
  }

  private eigrpHello() {
    const c = this.cfg().eigrp;
    if (!c) return;
    let changed = false;
    for (const [k, n] of this.eigrpNeighbors)
      if (this.now - n.lastHello > 15000) {
        this.eigrpNeighbors.delete(k);
        this.dev.log(`%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${c.asn}: Neighbor ${n.ip} (${n.iface}) is down: holding time expired`);
        changed = true;
      }
    for (const i of this.eigrpIfs()) {
      if (c.passive.includes(i.name)) continue;
      this.eigrpSend(i, { kind: "eigrp", type: "hello", asn: c.asn, routerId: this.routerId() });
    }
    if (changed) {
      this.eigrpCompute();
      this.eigrpUpdate();
    }
  }

  private eigrpUpdate() {
    const c = this.cfg().eigrp;
    if (!c) return;
    const learned = this.stack.dynamic.get("eigrp") ?? [];
    for (const out of this.eigrpIfs()) {
      if (c.passive.includes(out.name)) continue;
      const routes: NonNullable<EigrpPacket["routes"]> = [];
      for (const i of this.eigrpIfs()) {
        const { bw, delay } = eigrpIfMetric(this.speedOf(i.name));
        routes.push({ network: networkOf(i.ip!, i.mask!), mask: i.mask!, bw, delay });
      }
      for (const r of learned) if (r.iface !== out.name && r.eigrp) routes.push({ network: r.network, mask: r.mask, bw: r.eigrp.bw, delay: r.eigrp.delay });
      if (c.redistributeStatic)
        for (const s of this.stack.routingTable()) if (s.code === "S") routes.push({ network: s.network, mask: s.mask, bw: 1544, delay: 2000 });
      this.eigrpSend(out, { kind: "eigrp", type: "update", asn: c.asn, routerId: this.routerId(), routes });
    }
  }

  private onEigrp(iface: L3If, pkt: Ipv4Packet, p: EigrpPacket) {
    const c = this.cfg().eigrp;
    if (!c || p.asn !== c.asn) return;
    if (!this.eigrpIfs().some((i) => i.name === iface.name) || c.passive.includes(iface.name)) return;
    const key = `${iface.name}|${pkt.src}`;
    let n = this.eigrpNeighbors.get(key);
    if (!n) {
      n = { ip: pkt.src, iface: iface.name, lastHello: this.now, uptime: this.now, routes: [] };
      this.eigrpNeighbors.set(key, n);
      this.dev.log(`%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${c.asn}: Neighbor ${pkt.src} (${iface.name}) is up: new adjacency`);
      this.dev.schedule(10, () => {
        this.eigrpHello();
        this.eigrpUpdate();
      });
    }
    n.lastHello = this.now;
    if (p.type === "update" && p.routes) {
      const before = JSON.stringify(n.routes);
      n.routes = p.routes;
      if (before !== JSON.stringify(n.routes)) {
        const changed = this.eigrpCompute();
        if (changed) this.dev.schedule(20, () => this.eigrpUpdate());
      }
    }
  }

  /** Recomputes EIGRP routes from neighbor advertisements. Returns true if changed. */
  private eigrpCompute(): boolean {
    const c = this.cfg().eigrp;
    if (!c) return false;
    const connected = this.stack.connectedRoutes();
    const best = new Map<string, Route>();
    for (const n of this.eigrpNeighbors.values()) {
      const { bw, delay } = eigrpIfMetric(this.speedOf(n.iface));
      for (const r of n.routes) {
        if (connected.some((x) => x.network === r.network && x.mask === r.mask)) continue;
        const pbw = Math.min(bw, r.bw);
        const pdelay = r.delay + delay;
        const metric = eigrpMetric(pbw, pdelay);
        const key = `${r.network}/${r.mask}`;
        const cur = best.get(key);
        if (cur && cur.metric <= metric) continue;
        if (pdelay > 0xffffff) continue;
        best.set(key, {
          code: "D",
          network: r.network,
          mask: r.mask,
          prefix: maskToPrefix(r.mask),
          ad: 90,
          metric,
          nextHop: n.ip,
          iface: n.iface,
          eigrp: { bw: pbw, delay: pdelay },
        });
      }
    }
    const next = [...best.values()];
    const prev = this.stack.dynamic.get("eigrp") ?? [];
    const changed = JSON.stringify(prev.map((r) => [r.network, r.mask, r.metric, r.nextHop])) !== JSON.stringify(next.map((r) => [r.network, r.mask, r.metric, r.nextHop]));
    this.stack.dynamic.set("eigrp", next);
    return changed;
  }
}


/** Classic EIGRP composite metric with default K values. */
export function eigrpMetric(bwKbps: number, delayTensUs: number): number {
  return Math.floor((1e7 / bwKbps + delayTensUs) * 256);
}

export { wildcardToMask };
