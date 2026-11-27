// Layer 2 access switch and multilayer switch: MAC learning, VLANs, 802.1Q
// trunks, spanning tree (802.1D), port security, SVIs and optional routing.

import { BROADCAST_MAC, isValidIp, isValidMask, macDotted, type MAC } from "../addr";
import { IpStack, type L3If, type StaticRoute } from "../ipstack";
import { Device, Port, type DeviceConfig, type DeviceKind } from "../network";
import { nextUid, type Bpdu, type EthernetFrame } from "../packets";
import { IosDevice, LLDP_MAC, STP_MAC, defaultIos, isBroadcastOrMulticast, type IosCommon } from "./ios";
import { RoutingProcesses, type RoutingConfig, defaultRouting } from "./routing";
import { DhcpServer, relayDhcp, relayDhcpReply } from "../services";
import { AclEngine, type AclConfig } from "./acl";

export interface SwitchPortConfig {
  mode: "access" | "trunk" | "dynamic";
  accessVlan: number;
  voiceVlan?: number;
  nativeVlan: number;
  allowed: number[] | "all";
  shutdown: boolean;
  description: string;
  portfast: boolean;
  bpduguard: boolean;
  /** Multilayer only: routed port. */
  routed: boolean;
  ip?: string;
  mask?: string;
  security: {
    enabled: boolean;
    max: number;
    sticky: boolean;
    violation: "shutdown" | "restrict" | "protect";
    macs: MAC[];
  };
  stpCost?: number;
  channelGroup?: number;
  speed: "auto" | "10" | "100" | "1000";
  duplex: "auto" | "full" | "half";
  /** err-disabled by port security or BPDU guard. */
  errDisabled?: string;
}

export interface SviConfig {
  ip?: string;
  mask?: string;
  shutdown: boolean;
  description: string;
  helpers: string[];
  aclIn?: string;
  aclOut?: string;
}

export interface SwitchConfig extends DeviceConfig {
  hostname: string;
  ios: IosCommon;
  vlans: Record<number, string>;
  ports: Record<string, SwitchPortConfig>;
  svis: Record<number, SviConfig>;
  defaultGateway?: string;
  stp: { enabled: boolean; priority: number; mode: "pvst" | "rapid-pvst" };
  ipRouting: boolean;
  routes: StaticRoute[];
  routing: RoutingConfig;
  vtp: { mode: "server" | "client" | "transparent"; domain: string };
  macAging: number;
  acls: AclConfig;
  macs: Record<string, MAC>;
}

export function defaultPortConfig(): SwitchPortConfig {
  return {
    mode: "dynamic",
    accessVlan: 1,
    nativeVlan: 1,
    allowed: "all",
    shutdown: false,
    description: "",
    portfast: false,
    bpduguard: false,
    routed: false,
    security: { enabled: false, max: 1, sticky: false, violation: "shutdown", macs: [] },
    speed: "auto",
    duplex: "auto",
  };
}

interface MacEntry {
  port: Port;
  time: number;
  type: "dynamic" | "static" | "secure";
}

interface StpPortInfo {
  role: "root" | "designated" | "alternate" | "disabled";
  best?: Bpdu & { age: number };
  timer?: { cancel(): void };
  id: number;
}

const DEFAULT_VLANS: Record<number, string> = {
  1: "default",
  1002: "fddi-default",
  1003: "token-ring-default",
  1004: "fddinet-default",
  1005: "trnet-default",
};

export class Switch extends IosDevice {
  readonly kind: DeviceKind;
  readonly model: string;
  override readonly mdi = "mdix" as const;
  override readonly autoMdix = false;
  readonly layer3: boolean;
  get capabilities() {
    return this.layer3 && this.cfg.ipRouting ? "R S" : "S";
  }
  cfg: SwitchConfig;
  macTable = new Map<string, MacEntry>(); // key `${vlan}|${mac}`
  stp = new Map<Port, StpPortInfo>();
  sviMacs = new Map<number, MAC>();
  stack: IpStack;
  routing: RoutingProcesses;
  dhcpServer: DhcpServer;
  acl: AclEngine;
  private sviIfs = new Map<number, L3If>();
  private routedIfs = new Map<string, L3If>();
  forwardDelay = 15000;
  helloTime = 2000;
  maxAge = 20000;

  constructor(id: string, hostname: string, layer3 = false, portCount = 24) {
    super(id, hostname);
    this.layer3 = layer3;
    this.kind = layer3 ? "l3switch" : "switch";
    this.model = layer3 ? "Multilayer Switch 24G" : "Access Switch 24";
    if (layer3) {
      for (let i = 1; i <= portCount; i++) this.ports.push(new Port(this, `GigabitEthernet1/0/${i}`, `Gi1/0/${i}`, "copper", 1000));
      for (let i = 1; i <= 4; i++) this.ports.push(new Port(this, `GigabitEthernet1/1/${i}`, `Gi1/1/${i}`, "fiber", 1000));
    } else {
      for (let i = 1; i <= portCount; i++) this.ports.push(new Port(this, `FastEthernet0/${i}`, `Fa0/${i}`, "copper", 100));
      for (let i = 1; i <= 2; i++) this.ports.push(new Port(this, `GigabitEthernet0/${i}`, `Gi0/${i}`, "copper", 1000));
    }
    this.ports.push(new Port(this, "Console", "Con0", "console", 0));
    this.cfg = this.defaultConfig();
    this.stack = new IpStack(this, false, () => this.l3Interfaces());
    this.stack.dropOnArpMiss = false;
    this.routing = new RoutingProcesses(this, this.stack, () => this.cfg.routing);
    this.dhcpServer = new DhcpServer(this.stack);
    this.acl = new AclEngine(() => this.cfg.acls);
    this.stack.hooks.filter = (dir, iface, pkt) => {
      const vlan = Number(iface.name.replace(/^Vlan/, ""));
      const svi = this.cfg.svis[vlan];
      const name = dir === "in" ? svi?.aclIn : svi?.aclOut;
      return name ? this.acl.permits(name, pkt) : true;
    };
    this.stack.hooks.onBroadcast = (iface, pkt) => {
      const vlan = Number(iface.name.replace(/^Vlan/, ""));
      const helpers = this.cfg.svis[vlan]?.helpers ?? [];
      if (helpers.length && this.cfg.ipRouting) relayDhcp(this.stack, iface, pkt, helpers);
    };
    this.stack.udp.set(67, (pkt, udp, iface) => {
      if (udp.data.kind !== "dhcp") return;
      if (relayDhcpReply(this.stack, udp.data)) return;
      this.dhcpServer.handle(iface, pkt, udp.data);
    });
    this.applyConfig();
  }

  defaultConfig(): SwitchConfig {
    const ports: Record<string, SwitchPortConfig> = {};
    for (const p of this.ports) if (p.media !== "console") ports[p.name] = defaultPortConfig();
    return {
      hostname: this.hostname,
      ios: defaultIos(),
      vlans: { ...DEFAULT_VLANS },
      ports,
      svis: { 1: { shutdown: true, description: "", helpers: [] } },
      stp: { enabled: true, priority: 32768, mode: "pvst" },
      ipRouting: false,
      routes: [],
      routing: defaultRouting(),
      vtp: { mode: "server", domain: "" },
      macAging: 300,
      acls: {},
      macs: {},
    };
  }

  portCfg(p: Port | string): SwitchPortConfig {
    const name = typeof p === "string" ? p : p.name;
    let c = this.cfg.ports[name];
    if (!c) c = this.cfg.ports[name] = defaultPortConfig();
    return c;
  }

  /** Effective operational mode, resolving dynamic auto/desirable negotiation. */
  opMode(p: Port): "access" | "trunk" | "routed" {
    const c = this.portCfg(p);
    if (this.layer3 && c.routed) return "routed";
    if (c.mode === "dynamic") {
      // Dynamic ports become trunks when the peer is a switch with a trunk port.
      const peer = p.peer;
      if (peer && peer.device instanceof Switch) {
        const pc = peer.device.portCfg(peer);
        if (pc.mode === "trunk") return "trunk";
      }
      return "access";
    }
    return c.mode;
  }

  vlanAllowed(p: Port, vlan: number): boolean {
    const c = this.portCfg(p);
    if (!(vlan in this.cfg.vlans)) return false;
    return c.allowed === "all" || c.allowed.includes(vlan);
  }

  /** VLANs a port carries. */
  portVlans(p: Port): number[] {
    const mode = this.opMode(p);
    if (mode === "routed") return [];
    const c = this.portCfg(p);
    if (mode === "access") return [c.accessVlan, ...(c.voiceVlan ? [c.voiceVlan] : [])];
    return Object.keys(this.cfg.vlans)
      .map(Number)
      .filter((v) => this.vlanAllowed(p, v));
  }

  override portPhysicallyUp(p: Port) {
    if (p.media === "console") return true;
    const c = this.portCfg(p);
    return !c.shutdown && !c.errDisabled;
  }

  // --- configuration application --------------------------------------------

  applyConfig() {
    this.hostname = this.cfg.hostname;
    for (const p of this.ports) {
      if (p.media === "console") continue;
      const c = this.portCfg(p);
      p.adminUp = !c.shutdown;
      p.description = c.description;
      if (this.cfg.macs[p.name]) p.mac = this.cfg.macs[p.name];
    }
    this.stack.forwarding = this.layer3 && this.cfg.ipRouting;
    this.stack.defaultGateway = !this.stack.forwarding && this.cfg.defaultGateway && isValidIp(this.cfg.defaultGateway) ? this.cfg.defaultGateway : undefined;
    this.stack.staticRoutes = this.layer3 ? this.cfg.routes : [];
    this.routing.apply();
  }

  private sviMac(vlan: number): MAC {
    let m = this.sviMacs.get(vlan);
    if (!m) {
      const base = this.ports[0].mac.split(":");
      base[5] = ((parseInt(base[5], 16) + 0x40 + vlan) & 255).toString(16).padStart(2, "0");
      base[4] = ((parseInt(base[4], 16) + 0x80) & 255).toString(16).padStart(2, "0");
      m = base.join(":");
      this.sviMacs.set(vlan, m);
    }
    return m;
  }

  sviUp(vlan: number): boolean {
    const s = this.cfg.svis[vlan];
    if (!s || s.shutdown || !(vlan in this.cfg.vlans)) return false;
    return this.ports.some((p) => p.media !== "console" && p.isUp && p.stpState === "forwarding" && this.portVlans(p).includes(vlan));
  }

  l3Interfaces(): L3If[] {
    const out: L3If[] = [];
    for (const [k] of Object.entries(this.cfg.svis)) {
      const vlan = Number(k);
      let i = this.sviIfs.get(vlan);
      if (!i) {
        const self = this;
        i = {
          name: `Vlan${vlan}`,
          get ip() {
            const s = self.cfg.svis[vlan];
            return s && isValidIp(s.ip) ? s.ip : undefined;
          },
          get mask() {
            const s = self.cfg.svis[vlan];
            return s && isValidMask(s.mask) ? s.mask : undefined;
          },
          mac: this.sviMac(vlan),
          isUp: () => this.sviUp(vlan),
          output: (f) => this.sviOutput(vlan, f),
        };
        this.sviIfs.set(vlan, i);
      }
      out.push(i);
    }
    if (this.layer3) {
      for (const p of this.ports) {
        const c = this.cfg.ports[p.name];
        if (!c?.routed) continue;
        let i = this.routedIfs.get(p.name);
        if (!i) {
          const self = this;
          i = {
            name: p.name,
            get ip() {
              const cc = self.cfg.ports[p.name];
              return cc && isValidIp(cc.ip) ? cc.ip : undefined;
            },
            get mask() {
              const cc = self.cfg.ports[p.name];
              return cc && isValidMask(cc.mask) ? cc.mask : undefined;
            },
            get mac() {
              return p.mac;
            },
            isUp: () => p.isUp && !!self.cfg.ports[p.name]?.routed,
            output: (f) => this.send(p, f),
          };
          this.routedIfs.set(p.name, i);
        }
        out.push(i);
      }
    }
    return out;
  }

  override mgmtIp() {
    for (const i of this.l3Interfaces()) if (i.ip && i.isUp()) return i.ip;
    return undefined;
  }

  // --- forwarding -----------------------------------------------------------

  override receive(port: Port, frame: EthernetFrame) {
    if (port.media === "console") return;
    if (frame.dst === STP_MAC) {
      if (frame.payload.kind === "bpdu") this.handleBpdu(port, frame.payload);
      return;
    }
    if (frame.dst === LLDP_MAC) {
      this.handleLldp(port, frame);
      return;
    }
    const mode = this.opMode(port);
    if (mode === "routed") {
      const i = this.routedIfs.get(port.name);
      if (i) this.stack.receive(i, frame);
      return;
    }
    if (port.stpState === "blocking" || port.stpState === "listening" || port.stpState === "disabled") {
      this.drop(frame, `Port ${port.short} is in spanning-tree ${port.stpState} state`);
      return;
    }
    const c = this.portCfg(port);
    let vlan: number;
    if (mode === "access") {
      if (frame.vlan !== undefined && frame.vlan !== c.voiceVlan) {
        this.drop(frame, "Tagged frame received on access port");
        return;
      }
      vlan = frame.vlan ?? c.accessVlan;
    } else {
      vlan = frame.vlan ?? c.nativeVlan;
      if (!this.vlanAllowed(port, vlan)) {
        this.drop(frame, `VLAN ${vlan} not allowed on trunk ${port.short}`);
        return;
      }
    }
    if (!(vlan in this.cfg.vlans)) {
      this.drop(frame, `VLAN ${vlan} does not exist`);
      return;
    }
    if (!this.checkSecurity(port, frame.src)) {
      this.drop(frame, `Port security violation on ${port.short}`);
      return;
    }
    // Learn.
    if (!isBroadcastOrMulticast(frame.src)) {
      const key = `${vlan}|${frame.src}`;
      const prev = this.macTable.get(key);
      if (!prev || prev.type === "dynamic") this.macTable.set(key, { port, time: this.net?.time ?? 0, type: "dynamic" });
    }
    if (port.stpState === "learning") return;
    const inner: EthernetFrame = frame.vlan !== undefined ? { ...frame, vlan: undefined } : frame;
    // To the switch itself?
    const svi = this.sviIfs.get(vlan);
    const toSelf = svi && (frame.dst === svi.mac || this.ports.some((p) => p.mac === frame.dst));
    if (toSelf) {
      if (svi.isUp()) this.stack.receive(svi, { ...inner, dst: svi.mac });
      return;
    }
    if (isBroadcastOrMulticast(frame.dst) && svi && svi.isUp()) this.stack.receive(svi, inner);
    this.forwardInVlan(vlan, inner, port);
  }

  private forwardInVlan(vlan: number, frame: EthernetFrame, ingress?: Port) {
    const now = this.net?.time ?? 0;
    if (!isBroadcastOrMulticast(frame.dst)) {
      const e = this.macTable.get(`${vlan}|${frame.dst}`);
      if (e && (e.type !== "dynamic" || now - e.time < this.cfg.macAging * 1000)) {
        if (e.port === ingress) {
          this.drop(frame, "Destination is on the ingress port (filtered)");
          return;
        }
        this.egress(e.port, vlan, frame);
        return;
      }
    }
    for (const p of this.ports) {
      if (p === ingress || p.media === "console" || !p.isUp) continue;
      if (!this.portVlans(p).includes(vlan)) continue;
      this.egress(p, vlan, frame);
    }
  }

  private egress(p: Port, vlan: number, frame: EthernetFrame) {
    if (p.stpState !== "forwarding") return;
    const mode = this.opMode(p);
    if (mode === "routed") return;
    const c = this.portCfg(p);
    if (mode === "access") {
      if (vlan === c.voiceVlan) return this.send(p, { ...frame, vlan });
      if (vlan !== c.accessVlan) return;
      return this.send(p, frame.vlan === undefined ? frame : { ...frame, vlan: undefined });
    }
    if (!this.vlanAllowed(p, vlan)) return;
    this.send(p, vlan === c.nativeVlan ? { ...frame, vlan: undefined } : { ...frame, vlan });
  }

  private sviOutput(vlan: number, frame: EthernetFrame) {
    this.forwardInVlan(vlan, frame);
  }

  private checkSecurity(port: Port, src: MAC): boolean {
    const c = this.portCfg(port);
    const s = c.security;
    if (!s.enabled || this.opMode(port) !== "access") return true;
    if (s.macs.includes(src)) return true;
    if (s.macs.length < s.max) {
      s.macs.push(src);
      return true;
    }
    if (s.violation === "shutdown") {
      c.errDisabled = "psecure-violation";
      this.log(`%PM-4-ERR_DISABLE: psecure-violation error detected on ${port.name}, putting ${port.name} in err-disable state`);
      this.log(`%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${macDotted(src)} on port ${port.name}.`);
      if (port.link) this.net?.linkChanged(port.link);
    }
    return false;
  }

  // --- spanning tree ----------------------------------------------------------

  bridgeId(): string {
    return `${this.cfg.stp.priority + 1}.${macDotted(this.ports[0].mac)}`;
  }

  private bidKey(id: string): string {
    const [pri, mac] = id.split(".", 2).length === 2 ? [id.split(".")[0], id.slice(id.indexOf(".") + 1)] : ["0", id];
    return pri.padStart(6, "0") + mac;
  }

  private portCost(p: Port): number {
    const c = this.portCfg(p);
    if (c.stpCost) return c.stpCost;
    return p.speed >= 1000 ? 4 : p.speed >= 100 ? 19 : 100;
  }

  private stpPorts(): Port[] {
    return this.ports.filter((p) => p.media !== "console" && this.opMode(p) !== "routed");
  }

  /** Compares BPDU vectors; negative if a is better. */
  private cmpVec(a: { rootId: string; rootCost: number; bridgeId: string; portId: number }, b: { rootId: string; rootCost: number; bridgeId: string; portId: number }) {
    const ra = this.bidKey(a.rootId);
    const rb = this.bidKey(b.rootId);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (a.rootCost !== b.rootCost) return a.rootCost - b.rootCost;
    const ba = this.bidKey(a.bridgeId);
    const bb = this.bidKey(b.bridgeId);
    if (ba !== bb) return ba < bb ? -1 : 1;
    return a.portId - b.portId;
  }

  rootInfo(): { rootId: string; rootCost: number; rootPort?: Port } {
    const now = this.net?.time ?? 0;
    let best: { rootId: string; rootCost: number; bridgeId: string; portId: number } = { rootId: this.bridgeId(), rootCost: 0, bridgeId: this.bridgeId(), portId: 0 };
    let rootPort: Port | undefined;
    for (const p of this.stpPorts()) {
      const info = this.stp.get(p);
      const b = info?.best;
      if (!b || !p.isUp || now - b.age > this.maxAge) continue;
      const vec = { rootId: b.rootId, rootCost: b.rootCost + this.portCost(p), bridgeId: b.bridgeId, portId: b.portId };
      if (this.cmpVec(vec, best) < 0 && this.bidKey(b.rootId) < this.bidKey(this.bridgeId())) {
        best = vec;
        rootPort = p;
      } else if (rootPort && this.cmpVec(vec, best) === 0 && this.stp.get(p)!.id < this.stp.get(rootPort)!.id) {
        rootPort = p;
      }
    }
    return { rootId: best.rootId, rootCost: rootPort ? best.rootCost : 0, rootPort };
  }

  private recomputeStp() {
    if (!this.cfg.stp.enabled) {
      for (const p of this.stpPorts()) {
        this.setStpState(p, p.isUp ? "forwarding" : "disabled");
        const info = this.stpInfo(p);
        info.role = p.isUp ? "designated" : "disabled";
      }
      return;
    }
    const now = this.net?.time ?? 0;
    const { rootId, rootCost, rootPort } = this.rootInfo();
    const myBid = this.bridgeId();
    for (const p of this.stpPorts()) {
      const info = this.stpInfo(p);
      if (!p.isUp) {
        info.role = "disabled";
        this.setStpState(p, "disabled");
        continue;
      }
      let role: StpPortInfo["role"];
      if (p === rootPort) role = "root";
      else {
        const b = info.best && now - info.best.age <= this.maxAge ? info.best : undefined;
        const mine = { rootId, rootCost, bridgeId: myBid, portId: info.id };
        role = !b || this.cmpVec(mine, b) < 0 ? "designated" : "alternate";
      }
      const prevRole = info.role;
      info.role = role;
      if (role === "alternate") {
        this.setStpState(p, "blocking");
      } else if (prevRole !== role || p.stpState === "disabled" || p.stpState === "blocking") {
        if (p.stpState !== "forwarding" || prevRole === "alternate" || prevRole === "disabled") this.beginTransition(p);
      }
    }
  }

  private stpInfo(p: Port): StpPortInfo {
    let i = this.stp.get(p);
    if (!i) {
      i = { role: "disabled", id: 128 * 256 + this.ports.indexOf(p) + 1 };
      this.stp.set(p, i);
    }
    return i;
  }

  private beginTransition(p: Port) {
    const info = this.stpInfo(p);
    info.timer?.cancel();
    const c = this.portCfg(p);
    if (c.portfast && this.opMode(p) === "access") {
      this.setStpState(p, "forwarding");
      return;
    }
    const fast = this.cfg.stp.mode === "rapid-pvst";
    const fd = fast ? Math.min(this.forwardDelay, 1500) : this.forwardDelay;
    this.setStpState(p, "listening");
    info.timer = this.schedule(fd, () => {
      if (info.role === "alternate" || !p.isUp) return;
      this.setStpState(p, "learning");
      info.timer = this.schedule(fd, () => {
        if (info.role === "alternate" || !p.isUp) return;
        this.setStpState(p, "forwarding");
      });
    });
  }

  private setStpState(p: Port, s: Port["stpState"]) {
    if (p.stpState === s) return;
    const wasForwarding = p.stpState === "forwarding";
    p.stpState = s;
    if (wasForwarding && s !== "forwarding") {
      for (const [k, e] of this.macTable) if (e.port === p && e.type === "dynamic") this.macTable.delete(k);
    }
    if (p.link) this.net?.emit({ type: "link", link: p.link });
  }

  private sendBpdus() {
    if (!this.cfg.stp.enabled) return;
    const { rootId, rootCost } = this.rootInfo();
    for (const p of this.stpPorts()) {
      if (!p.isUp) continue;
      const info = this.stpInfo(p);
      if (info.role !== "designated") continue;
      const bpdu: Bpdu = { kind: "bpdu", rootId, rootCost, bridgeId: this.bridgeId(), portId: info.id };
      this.send(p, { uid: nextUid(), src: p.mac, dst: STP_MAC, type: "stp", payload: bpdu });
    }
  }

  private handleBpdu(p: Port, b: Bpdu) {
    if (!this.cfg.stp.enabled || this.opMode(p) === "routed") return;
    const c = this.portCfg(p);
    if (c.bpduguard && c.portfast) {
      c.errDisabled = "bpduguard";
      this.log(`%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${p.name} with BPDU Guard enabled. Disabling port.`);
      this.log(`%PM-4-ERR_DISABLE: bpduguard error detected on ${p.name}, putting ${p.name} in err-disable state`);
      if (p.link) this.net?.linkChanged(p.link);
      return;
    }
    const info = this.stpInfo(p);
    const prevRoot = this.rootInfo().rootId;
    info.best = { ...b, age: this.net?.time ?? 0 };
    this.recomputeStp();
    const nowRoot = this.rootInfo();
    if (nowRoot.rootId !== prevRoot || nowRoot.rootPort === p) {
      // Relay superior information promptly instead of waiting for the hello.
      if (nowRoot.rootId !== prevRoot) this.sendBpdus();
    }
  }

  // --- lifecycle --------------------------------------------------------------

  override start() {
    super.start();
    for (const p of this.stpPorts()) {
      const info = this.stpInfo(p);
      info.role = "disabled";
      p.stpState = "disabled";
    }
    this.recomputeStp();
    this.every(this.helloTime, () => {
      this.recomputeStp();
      this.sendBpdus();
    });
    this.routing.start();
  }

  override stop() {
    super.stop();
    this.macTable.clear();
    for (const i of this.stp.values()) {
      i.timer?.cancel();
      i.best = undefined;
    }
    this.stack.reset();
    this.dhcpServer.reset();
    this.routing.stop();
  }

  override onLinkChange(port: Port) {
    super.onLinkChange(port);
    if (port.media === "console") return;
    if (!port.isUp) {
      for (const [k, e] of this.macTable) if (e.port === port && e.type === "dynamic") this.macTable.delete(k);
      const info = this.stp.get(port);
      if (info) {
        info.best = undefined;
        info.timer?.cancel();
      }
    }
    if (this.net) {
      this.recomputeStp();
      if (port.isUp) this.schedule(5, () => this.sendBpdus());
    }
    this.routing.linkChanged();
  }

  // --- persistence ------------------------------------------------------------

  serializeRunning(): DeviceConfig {
    const macs: Record<string, MAC> = {};
    for (const p of this.ports) macs[p.name] = p.mac;
    return structuredClone({ ...this.cfg, hostname: this.hostname, ios: this.ios, macs });
  }

  loadRunning(cfg: DeviceConfig) {
    const base = this.defaultConfig();
    const c = cfg as Partial<SwitchConfig>;
    this.cfg = {
      ...base,
      ...structuredClone(c),
      ports: { ...base.ports },
      routing: { ...base.routing, ...(c.routing ?? {}) },
    } as SwitchConfig;
    for (const [k, v] of Object.entries(c.ports ?? {})) this.cfg.ports[k] = { ...defaultPortConfig(), ...v, security: { ...defaultPortConfig().security, ...(v.security ?? {}) } };
    if (c.ios) this.ios = { ...defaultIos(), ...structuredClone(c.ios) };
    if (c.macs) for (const p of this.ports) if (c.macs[p.name]) p.mac = c.macs[p.name];
    this.sviIfs.clear();
    this.routedIfs.clear();
    this.applyConfig();
  }

  factoryReset() {
    this.cfg = this.defaultConfig();
    this.ios = defaultIos();
    this.hostname = this.layer3 ? "Switch" : "Switch";
    this.cfg.hostname = this.hostname;
    this.sviIfs.clear();
    this.routedIfs.clear();
    this.applyConfig();
  }

  macTableEntries(): { vlan: number; mac: MAC; type: string; port: string }[] {
    const now = this.net?.time ?? 0;
    const out: { vlan: number; mac: MAC; type: string; port: string }[] = [];
    for (const [k, e] of this.macTable) {
      if (e.type === "dynamic" && now - e.time >= this.cfg.macAging * 1000) continue;
      const [v, mac] = k.split("|");
      out.push({ vlan: Number(v), mac, type: e.type.toUpperCase(), port: e.port.short });
    }
    return out.sort((a, b) => a.vlan - b.vlan || a.port.localeCompare(b.port, undefined, { numeric: true }));
  }

  clearMacTable() {
    for (const [k, e] of this.macTable) if (e.type === "dynamic") this.macTable.delete(k);
  }

  /** Re-enables an err-disabled port (shutdown/no shutdown). */
  clearErrDisable(p: Port) {
    const c = this.portCfg(p);
    if (c.errDisabled) {
      c.errDisabled = undefined;
      if (c.security.enabled && !c.security.sticky) c.security.macs = [];
    }
  }
}

// ---------------------------------------------------------------------------

/** A hub repeats every frame out of every other port. */
export class Hub extends Device {
  readonly kind = "hub" as const;
  readonly model = "Hub 8";
  override readonly mdi = "mdix" as const;
  constructor(id: string, hostname: string) {
    super(id, hostname);
    for (let i = 0; i < 8; i++) this.ports.push(new Port(this, `Port${i}`, `P${i}`, "copper", 10));
  }
  override receive(port: Port, frame: EthernetFrame) {
    for (const p of this.ports) if (p !== port && p.isUp) this.send(p, frame);
  }
  override serialize(): DeviceConfig {
    return { hostname: this.hostname, macs: this.ports.map((p) => p.mac) };
  }
  override load(cfg: DeviceConfig) {
    if (typeof cfg.hostname === "string") this.hostname = cfg.hostname;
  }
}

export { BROADCAST_MAC };
