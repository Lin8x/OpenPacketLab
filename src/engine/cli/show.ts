// Output of `show` commands and running-config generation.

import { macDotted, maskToPrefix, networkOf, wildcardToMask } from "../addr";
import type { Route } from "../ipstack";
import { formatEntry } from "../devices/acl";
import type { IosDevice } from "../devices/ios";
import { Router, shortIfName } from "../devices/router";
import { Switch } from "../devices/switch";
import { compressVlans } from "./parser";
import { encodeType7, hashSecret } from "./passwords";

const pad = (s: string | number, n: number) => String(s).padEnd(n);

export function uptime(dev: IosDevice): string {
  const ms = (dev.net?.time ?? 0) - dev.bootTime;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d > 1 ? "s" : ""}`);
  if (h) parts.push(`${h} hour${h > 1 ? "s" : ""}`);
  parts.push(`${m} minute${m !== 1 ? "s" : ""}`);
  if (!d && !h && !m) return `${s % 60} seconds`;
  return parts.join(", ");
}

export function showVersion(dev: IosDevice): string {
  const isR = dev instanceof Router;
  const ifs = dev.ports.filter((p) => p.media !== "console");
  return [
    `OpenPacketLab Network Operating System, ${dev.model}, Version 1.0`,
    "Technical support: https://github.com/Lin8x/OpenPacketLab",
    "Copyright (c) The OpenPacketLab contributors. Licensed under Apache 2.0.",
    "",
    `${dev.hostname} uptime is ${uptime(dev)}`,
    "System returned to ROM by power-on",
    "",
    `${dev.model} with 512K bytes of memory.`,
    `${ifs.filter((p) => p.media === "copper" || p.media === "fiber").length} Ethernet interfaces`,
    ...(isR ? [`${ifs.filter((p) => p.media === "serial").length} Serial interfaces`] : []),
    "256K bytes of non-volatile configuration memory.",
    "",
    `Configuration register is 0x2102`,
  ].join("\n");
}

function ifStatus(dev: IosDevice, name: string): { status: string; protocol: string; ip: string; method: string } {
  if (dev instanceof Router) {
    const c = dev.cfg.interfaces[name];
    const l3 = dev.l3Interfaces().find((i) => i.name === name);
    const ip = c?.ip ?? "unassigned";
    const isLoop = /^loopback/i.test(name);
    const parent = dev.parentPort(name);
    let status = "down";
    if (c?.shutdown) status = "administratively down";
    else if (isLoop || (parent && parent.isUp)) status = "up";
    return { status, protocol: l3?.isUp() ? "up" : "down", ip, method: c?.ip ? "manual" : "unset" };
  }
  const sw = dev as Switch;
  if (name.startsWith("Vlan")) {
    const v = Number(name.slice(4));
    const s = sw.cfg.svis[v];
    const up = sw.sviUp(v);
    return {
      status: s?.shutdown ? "administratively down" : v in sw.cfg.vlans ? "up" : "down",
      protocol: up ? "up" : "down",
      ip: s?.ip ?? "unassigned",
      method: s?.ip ? "manual" : "unset",
    };
  }
  const p = sw.port(name)!;
  const c = sw.portCfg(p);
  return {
    status: c.shutdown ? "administratively down" : p.isUp ? "up" : "down",
    protocol: p.isUp ? "up" : "down",
    ip: c.routed && c.ip ? c.ip : "unassigned",
    method: c.routed && c.ip ? "manual" : "unset",
  };
}

export function allIfNames(dev: IosDevice): string[] {
  if (dev instanceof Router) {
    return Object.keys(dev.cfg.interfaces).sort(ifSort);
  }
  const sw = dev as Switch;
  const names = sw.ports.filter((p) => p.media !== "console").map((p) => p.name);
  for (const v of Object.keys(sw.cfg.svis)) names.push(`Vlan${v}`);
  return names;
}

function ifSort(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true });
}

export function showIpIntBrief(dev: IosDevice): string {
  const lines = [`${pad("Interface", 23)}${pad("IP-Address", 16)}OK? ${pad("Method", 7)}${pad("Status", 22)}Protocol`];
  for (const n of allIfNames(dev)) {
    const s = ifStatus(dev, n);
    lines.push(`${pad(n, 23)}${pad(s.ip, 16)}YES ${pad(s.method, 7)}${pad(s.status, 22)}${s.protocol}`);
  }
  return lines.join("\n");
}

export function showInterfaces(dev: IosDevice, only?: string): string {
  const out: string[] = [];
  for (const n of allIfNames(dev)) {
    if (only && n.toLowerCase() !== only.toLowerCase()) continue;
    const s = ifStatus(dev, n);
    const p = dev instanceof Router ? dev.parentPort(n) : dev.port(n);
    const mac = dev instanceof Router ? dev.l3Interfaces().find((i) => i.name === n)?.mac : p?.mac;
    const typ = n.startsWith("Serial") ? "Serial" : n.startsWith("Loopback") ? "Loopback" : n.startsWith("Vlan") ? "EtherSVI" : p?.speed === 1000 ? "Gigabit Ethernet" : "Fast Ethernet";
    out.push(`${n} is ${s.status}, line protocol is ${s.protocol}${s.protocol === "down" && s.status === "up" && dev instanceof Switch ? " (notconnect)" : ""}`);
    out.push(`  Hardware is ${typ}${mac && !n.startsWith("Serial") && !n.startsWith("Loopback") ? `, address is ${macDotted(mac)} (bia ${macDotted(mac)})` : ""}`);
    if (p?.description) out.push(`  Description: ${p.description}`);
    if (s.ip !== "unassigned") {
      const mask = dev instanceof Router ? dev.cfg.interfaces[n]?.mask : n.startsWith("Vlan") ? (dev as Switch).cfg.svis[Number(n.slice(4))]?.mask : (dev as Switch).cfg.ports[n]?.mask;
      if (mask) out.push(`  Internet address is ${s.ip}/${maskToPrefix(mask)}`);
    }
    const bw = p ? (p.speed >= 1 ? p.speed * 1000 : 1544) : 8000000;
    out.push(`  MTU 1500 bytes, BW ${bw} Kbit/sec, DLY ${p && p.speed >= 1000 ? 10 : p?.media === "serial" ? 20000 : 100} usec,`);
    out.push(`     reliability 255/255, txload 1/255, rxload 1/255`);
    if (n.startsWith("Serial")) {
      const r = dev as Router;
      out.push(`  Encapsulation ${(r.cfg.interfaces[n]?.encapsulation ?? "hdlc").toUpperCase()}, loopback not set, keepalive set (10 sec)`);
      if (p?.link) out.push(`  ${r.isDce(p) ? "DCE" : "DTE"} V.35, clock rate ${r.cfg.interfaces[n]?.clockRate ?? "not set"}`);
    } else if (p && !n.startsWith("Vlan")) {
      out.push(`  Encapsulation ARPA, loopback not set`);
      out.push(`  ${p.speed === 1000 ? "Full-duplex, 1000Mb/s" : "Full-duplex, 100Mb/s"}, media type is ${p.media === "fiber" ? "SFP" : "RJ45"}`);
    }
    out.push(`  Last input never, output never, output hang never`);
    out.push(`  Queueing strategy: fifo`);
  }
  return out.join("\n") || "% Invalid interface";
}

const ROUTE_CODES = `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP
       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area
       * - candidate default, U - per-user static route, o - ODR
       P - periodic downloaded static route`;

export function showIpRoute(dev: IosDevice, filter?: string): string {
  const stack = dev instanceof Router ? dev.stack : (dev as Switch).stack;
  if (!stack.forwarding) {
    const gw = stack.defaultGateway;
    return gw ? `Default gateway is ${gw}\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty` : "Default gateway is not set\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty";
  }
  let routes = stack.routingTable();
  if (filter === "connected") routes = routes.filter((r) => r.code === "C" || r.code === "L");
  else if (filter === "static") routes = routes.filter((r) => r.code === "S");
  else if (filter === "rip") routes = routes.filter((r) => r.code === "R");
  else if (filter === "ospf") routes = routes.filter((r) => r.code === "O");
  else if (filter === "eigrp") routes = routes.filter((r) => r.code === "D");
  const def = routes.find((r) => r.prefix === 0);
  const lines = [ROUTE_CODES, ""];
  lines.push(def ? `Gateway of last resort is ${def.nextHop ?? "0.0.0.0"} to network 0.0.0.0` : "Gateway of last resort is not set");
  lines.push("");
  // Group by classful major network like IOS does.
  const groups = new Map<string, Route[]>();
  for (const r of routes) {
    const first = Number(r.network.split(".")[0]);
    const cm = first < 128 ? 8 : first < 192 ? 16 : 24;
    const major = networkOf(r.network, ["0.0.0.0", "255.0.0.0", "255.255.0.0", "255.255.255.0"][cm / 8]);
    const key = r.prefix === 0 ? "0.0.0.0/0" : `${major}/${cm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  for (const [key, rs] of groups) {
    const subnetted = rs.length > 1 || (rs[0].prefix !== Number(key.split("/")[1]) && rs[0].prefix !== 0);
    if (subnetted) {
      const masks = new Set(rs.map((r) => r.prefix));
      lines.push(`     ${key.split("/")[0]}/${key.split("/")[1]} is ${masks.size > 1 ? "variably " : ""}subnetted, ${rs.length} subnets${masks.size > 1 ? `, ${masks.size} masks` : ""}`);
    }
    for (const r of rs) lines.push(formatRoute(r, subnetted));
  }
  return lines.join("\n");
}

function formatRoute(r: Route, indent: boolean): string {
  const code = r.code === "S" && r.prefix === 0 ? "S*" : r.code === "O" && r.prefix === 0 ? "O*E2" : r.code;
  const dest = `${r.network}/${r.prefix}`;
  const head = `${pad(code, 9)}${dest}`;
  void indent;
  if (r.code === "C") return `${head} is directly connected, ${r.iface}`;
  if (r.code === "L") return `${head} is directly connected, ${r.iface}`;
  if (r.code === "S" && !r.nextHop) return `${head} is directly connected, ${r.iface}`;
  return `${head} [${r.ad}/${r.metric}] via ${r.nextHop}${r.iface && r.code !== "S" ? `, 00:00:${String(Math.floor(Math.random() * 30)).padStart(2, "0")}, ${r.iface}` : r.iface ? `, ${r.iface}` : ""}`;
}

export function showArp(dev: IosDevice): string {
  const stack = dev instanceof Router ? dev.stack : (dev as Switch).stack;
  const lines = ["Protocol  Address          Age (min)  Hardware Addr   Type   Interface"];
  for (const i of stack.interfaces()) {
    if (i.ip && i.isUp() && !/^loopback/i.test(i.name)) lines.push(`Internet  ${pad(i.ip, 17)}${pad("-", 11)}${pad(macDotted(i.mac), 16)}ARPA   ${i.name}`);
  }
  for (const e of stack.arpTable()) lines.push(`Internet  ${pad(e.ip, 17)}${pad(e.static ? "-" : e.age, 11)}${pad(macDotted(e.mac), 16)}ARPA   ${e.iface}`);
  return lines.join("\n");
}

export function showMacTable(sw: Switch): string {
  const lines = ["          Mac Address Table", "-------------------------------------------", "", "Vlan    Mac Address       Type        Ports", "----    -----------       --------    -----"];
  for (const e of sw.macTableEntries()) lines.push(`${pad(e.vlan, 8)}${pad(macDotted(e.mac), 18)}${pad(e.type, 12)}${e.port}`);
  lines.push(`Total Mac Addresses for this criterion: ${sw.macTableEntries().length}`);
  return lines.join("\n");
}

export function showVlanBrief(sw: Switch, brief = true): string {
  const lines = [`${pad("VLAN", 5)}${pad("Name", 33)}${pad("Status", 10)}Ports`, `${"-".repeat(4)} ${"-".repeat(32)} ${"-".repeat(9)} ${"-".repeat(31)}`];
  for (const [k, name] of Object.entries(sw.cfg.vlans).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const v = Number(k);
    const ports = sw.ports.filter((p) => p.media !== "console" && sw.opMode(p) === "access" && sw.portCfg(p).accessVlan === v).map((p) => p.short);
    const status = v >= 1002 && v <= 1005 ? "act/unsup" : "active";
    const chunks: string[] = [];
    for (let i = 0; i < ports.length; i += 4) chunks.push(ports.slice(i, i + 4).join(", "));
    lines.push(`${pad(v, 5)}${pad(name, 33)}${pad(status, 10)}${chunks[0] ?? ""}`);
    for (const c of chunks.slice(1)) lines.push(`${" ".repeat(48)}${c}`);
  }
  if (!brief) {
    lines.push("", "VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2");
    for (const k of Object.keys(sw.cfg.vlans)) lines.push(`${pad(k, 5)}enet  ${pad(100000 + Number(k), 11)}1500  -      -      -        -    -        0      0`);
  }
  return lines.join("\n");
}

export function showTrunk(sw: Switch): string {
  const trunks = sw.ports.filter((p) => p.media !== "console" && sw.opMode(p) === "trunk" && p.isUp);
  if (!trunks.length) return "";
  const lines = [`${pad("Port", 12)}${pad("Mode", 13)}${pad("Encapsulation", 15)}${pad("Status", 13)}Native vlan`];
  for (const p of trunks) {
    const c = sw.portCfg(p);
    lines.push(`${pad(p.short, 12)}${pad(c.mode === "trunk" ? "on" : "auto", 13)}${pad("802.1q", 15)}${pad("trunking", 13)}${c.nativeVlan}`);
  }
  lines.push("", `${pad("Port", 12)}Vlans allowed on trunk`);
  for (const p of trunks) {
    const c = sw.portCfg(p);
    lines.push(`${pad(p.short, 12)}${c.allowed === "all" ? "1-4094" : compressVlans(c.allowed)}`);
  }
  lines.push("", `${pad("Port", 12)}Vlans allowed and active in management domain`);
  for (const p of trunks) lines.push(`${pad(p.short, 12)}${compressVlans(sw.portVlans(p))}`);
  lines.push("", `${pad("Port", 12)}Vlans in spanning tree forwarding state and not pruned`);
  for (const p of trunks) lines.push(`${pad(p.short, 12)}${p.stpState === "forwarding" ? compressVlans(sw.portVlans(p)) : "none"}`);
  return lines.join("\n");
}

export function showSpanningTree(sw: Switch): string {
  if (!sw.cfg.stp.enabled) return "No spanning tree instance exists.";
  const { rootId, rootCost, rootPort } = sw.rootInfo();
  const bid = sw.bridgeId();
  const [rp, rmac] = [rootId.split(".")[0], rootId.slice(rootId.indexOf(".") + 1)];
  const [bp, bmac] = [bid.split(".")[0], bid.slice(bid.indexOf(".") + 1)];
  const lines = [
    "VLAN0001",
    `  Spanning tree enabled protocol ${sw.cfg.stp.mode === "rapid-pvst" ? "rstp" : "ieee"}`,
    `  Root ID    Priority    ${rp}`,
    `             Address     ${rmac}`,
    rootId === bid ? "             This bridge is the root" : `             Cost        ${rootCost}\n             Port        ${rootPort ? sw.ports.indexOf(rootPort) + 1 : 0} (${rootPort?.name ?? ""})`,
    "             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec",
    "",
    `  Bridge ID  Priority    ${bp}  (priority ${sw.cfg.stp.priority} sys-id-ext 1)`,
    `             Address     ${bmac}`,
    "             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec",
    "             Aging Time  20",
    "",
    `${pad("Interface", 20)}${pad("Role", 5)}${pad("Sts", 4)}${pad("Cost", 10)}${pad("Prio.Nbr", 9)}Type`,
    `${"-".repeat(19)} ${"-".repeat(4)} ${"-".repeat(3)} ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(24)}`,
  ];
  for (const p of sw.ports) {
    if (p.media === "console" || !p.isUp || sw.opMode(p) === "routed") continue;
    const info = sw.stp.get(p);
    const role = { root: "Root", designated: "Desg", alternate: "Altn", disabled: "Disa" }[info?.role ?? "disabled"];
    const sts = { forwarding: "FWD", blocking: "BLK", listening: "LIS", learning: "LRN", disabled: "DIS" }[p.stpState];
    const cost = p.speed >= 1000 ? 4 : p.speed >= 100 ? 19 : 100;
    lines.push(`${pad(p.short, 20)}${pad(role, 5)}${pad(sts, 4)}${pad(cost, 10)}${pad(`128.${sw.ports.indexOf(p) + 1}`, 9)}P2p${sw.portCfg(p).portfast ? " Edge" : ""}`);
  }
  return lines.join("\n");
}

export function showNeighbors(dev: IosDevice, detail = false): string {
  if (detail) {
    const out: string[] = [];
    for (const n of dev.neighbors.values()) {
      out.push("-------------------------", `Device ID: ${n.device}`, "Entry address(es):", ...(n.ip ? [`  IP address: ${n.ip}`] : []), `Platform: ${n.model},  Capabilities: ${n.capabilities === "R" ? "Router" : n.capabilities === "S" ? "Switch" : "Router Switch"}`, `Interface: ${n.localPort},  Port ID (outgoing port): ${n.remotePort}`, "Holdtime: 120 sec", "");
    }
    return out.join("\n");
  }
  const lines = [
    "Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge",
    "                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone",
    `${pad("Device ID", 17)}${pad("Local Intrfce", 18)}${pad("Holdtme", 10)}${pad("Capability", 12)}${pad("Platform", 22)}Port ID`,
  ];
  for (const n of dev.neighbors.values()) {
    lines.push(`${pad(n.device, 17)}${pad(shortIfName(n.localPort), 18)}${pad(120, 10)}${pad(n.capabilities, 12)}${pad(n.model, 22)}${shortIfName(n.remotePort)}`);
  }
  return lines.join("\n");
}

export function showAccessLists(dev: Router | Switch, only?: string): string {
  const out: string[] = [];
  for (const [name, acl] of Object.entries(dev.cfg.acls)) {
    if (only && only !== name) continue;
    const numbered = /^\d+$/.test(name);
    out.push(`${acl.type === "standard" ? "Standard" : "Extended"} IP access list ${name}`);
    for (const e of acl.entries) {
      if (e.action === "remark") continue;
      out.push(`    ${e.seq} ${formatEntry(acl, e)}${e.matches ? ` (${e.matches} match(es))` : ""}`);
    }
    void numbered;
  }
  return out.join("\n");
}

export function showDhcpBinding(dev: Router | Switch): string {
  const lines = ["IP address       Client-ID/              Lease expiration        Type", "                 Hardware address"];
  for (const b of dev.dhcpServer.bindings.values()) lines.push(`${pad(b.ip, 17)}${pad(macDotted(b.mac), 24)}${pad("--", 24)}Automatic`);
  return lines.join("\n");
}

export function showNat(r: Router): string {
  const lines = [`${pad("Pro", 5)}${pad("Inside global", 22)}${pad("Inside local", 22)}${pad("Outside local", 22)}Outside global`];
  for (const s of r.cfg.nat.statics) lines.push(`${pad(s.proto ?? "---", 5)}${pad(s.global + (s.globalPort ? ":" + s.globalPort : ""), 22)}${pad(s.inside + (s.insidePort ? ":" + s.insidePort : ""), 22)}${pad("---", 22)}---`);
  for (const e of r.natTable) {
    if (e.static) continue;
    const ig = e.insideGlobal + (e.insideGlobalPort !== undefined ? `:${e.insideGlobalPort}` : "");
    const il = e.insideLocal + (e.insideLocalPort !== undefined ? `:${e.insideLocalPort}` : "");
    const o = e.outside ? e.outside + (e.outsidePort !== undefined && e.proto !== "icmp" ? `:${e.outsidePort}` : e.proto === "icmp" ? `:${e.insideLocalPort}` : "") : "---";
    lines.push(`${pad(e.proto === "any" ? "---" : e.proto, 5)}${pad(ig, 22)}${pad(il, 22)}${pad(o, 22)}${o}`);
  }
  return lines.join("\n");
}

export function showOspfNeighbor(r: Router | Switch): string {
  const lines = [`${pad("Neighbor ID", 16)}${pad("Pri", 5)}${pad("State", 17)}${pad("Dead Time", 11)}${pad("Address", 16)}Interface`];
  const now = r.net?.time ?? 0;
  for (const n of r.routing.ospfNeighbors.values()) {
    const dead = Math.max(0, 40 - Math.floor((now - n.lastHello) / 1000));
    lines.push(`${pad(n.rid, 16)}${pad(n.priority, 5)}${pad(n.state === "FULL" ? "FULL/  -" : n.state + "/  -", 17)}${pad(`00:00:${String(dead).padStart(2, "0")}`, 11)}${pad(n.ip, 16)}${n.iface}`);
  }
  return lines.join("\n");
}

export function showOspfDatabase(r: Router | Switch): string {
  const c = r.cfg.routing.ospf;
  if (!c) return "";
  const lines = [`            OSPF Router with ID (${r.routing.routerId()}) (Process ID ${c.pid})`, "", "                Router Link States (Area 0)", "", "Link ID         ADV Router      Age         Seq#       Checksum Link count"];
  for (const l of r.routing.lsdb.values()) lines.push(`${pad(l.routerId, 16)}${pad(l.routerId, 16)}${pad(1, 12)}0x${(0x80000000 + l.seq).toString(16)} 0x00${(l.seq * 7919 % 65535).toString(16).padStart(4, "0")} ${l.links.length}`);
  return lines.join("\n");
}

export function showEigrpNeighbors(r: Router | Switch): string {
  const c = r.cfg.routing.eigrp;
  const lines = [`EIGRP-IPv4 Neighbors for AS(${c?.asn ?? 0})`, "H   Address         Interface       Hold Uptime    SRTT   RTO   Q   Seq", "                                    (sec)          (ms)        Cnt Num"];
  let h = 0;
  const now = r.net?.time ?? 0;
  for (const n of r.routing.eigrpNeighbors.values()) {
    const up = Math.floor((now - n.uptime) / 1000);
    lines.push(`${pad(h++, 4)}${pad(n.ip, 16)}${pad(shortIfName(n.iface), 16)}${pad(15 - Math.floor((now - n.lastHello) / 1000), 5)}${pad(`00:${String(Math.floor(up / 60)).padStart(2, "0")}:${String(up % 60).padStart(2, "0")}`, 10)}${pad(1, 7)}${pad(200, 6)}${pad(0, 4)}${n.routes.length}`);
  }
  return lines.join("\n");
}

export function showIpProtocols(r: Router | Switch): string {
  const out: string[] = [];
  const c = r.cfg.routing;
  if (c.rip) {
    out.push(`Routing Protocol is "rip"`, "  Sending updates every 30 seconds", "  Invalid after 180 seconds, hold down 180, flushed after 240", `  Redistributing: rip${c.rip.redistributeStatic ? ", static" : ""}`, `  Default version control: send version ${c.rip.version}, receive ${c.rip.version === 2 ? "2" : "any version"}`, `  Automatic network summarization is ${c.rip.autoSummary ? "in effect" : "not in effect"}`, "  Maximum path: 4", "  Routing for Networks:", ...c.rip.networks.map((n) => `\t${n}`), ...(c.rip.passive.length ? ["  Passive Interface(s):", ...c.rip.passive.map((p) => `\t${p}`)] : []), "  Distance: (default is 120)", "");
  }
  if (c.ospf) {
    out.push(`Routing Protocol is "ospf ${c.ospf.pid}"`, `  Router ID ${r.routing.routerId()}`, "  Number of areas in this router is 1. 1 normal 0 stub 0 nssa", "  Maximum path: 4", "  Routing for Networks:", ...c.ospf.networks.map((n) => `    ${n.network} ${n.wildcard} area ${n.area}`), ...(c.ospf.passive.length ? ["  Passive Interface(s):", ...c.ospf.passive.map((p) => `    ${p}`)] : []), "  Distance: (default is 110)", "");
  }
  if (c.eigrp) {
    out.push(`Routing Protocol is "eigrp ${c.eigrp.asn}"`, "  EIGRP-IPv4 Protocol for AS(" + c.eigrp.asn + ")", "    Metric weight K1=1, K2=0, K3=1, K4=0, K5=0", `    Router-ID: ${r.routing.routerId()}`, `  Automatic Summarization: ${c.eigrp.autoSummary ? "enabled" : "disabled"}`, "  Maximum path: 4", "  Routing for Networks:", ...c.eigrp.networks.map((n) => `     ${n.network}${n.wildcard ? " " + n.wildcard : ""}`), "  Distance: internal 90 external 170", "");
  }
  return out.join("\n");
}

export function showPortSecurity(sw: Switch, port?: string): string {
  if (port) {
    const p = sw.port(port);
    if (!p) return "% Invalid interface";
    const c = sw.portCfg(p);
    return [
      `Port Security              : ${c.security.enabled ? "Enabled" : "Disabled"}`,
      `Port Status                : ${c.errDisabled ? "Secure-shutdown" : c.security.enabled && p.isUp ? "Secure-up" : "Secure-down"}`,
      `Violation Mode             : ${c.security.violation[0].toUpperCase() + c.security.violation.slice(1)}`,
      "Aging Time                 : 0 mins",
      "Aging Type                 : Absolute",
      "SecureStatic Address Aging : Disabled",
      `Maximum MAC Addresses      : ${c.security.max}`,
      `Total MAC Addresses        : ${c.security.macs.length}`,
      "Configured MAC Addresses   : 0",
      `Sticky MAC Addresses       : ${c.security.sticky ? c.security.macs.length : 0}`,
      `Last Source Address:Vlan   : ${c.security.macs.length ? macDotted(c.security.macs[c.security.macs.length - 1]) + ":" + c.accessVlan : "0000.0000.0000:0"}`,
      `Security Violation Count   : ${c.errDisabled ? 1 : 0}`,
    ].join("\n");
  }
  const lines = ["Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action", "                (Count)       (Count)          (Count)", "----------------------------------------------------------------------------"];
  for (const p of sw.ports) {
    const c = sw.cfg.ports[p.name];
    if (!c?.security.enabled) continue;
    lines.push(`${pad(p.short, 13)}${pad(c.security.max, 15)}${pad(c.security.macs.length, 13)}${pad(c.errDisabled ? 1 : 0, 19)}${c.security.violation[0].toUpperCase() + c.security.violation.slice(1)}`);
  }
  lines.push("----------------------------------------------------------------------------");
  return lines.join("\n");
}

export function showInterfacesStatus(sw: Switch): string {
  const lines = [`${pad("Port", 10)}${pad("Name", 19)}${pad("Status", 13)}${pad("Vlan", 11)}${pad("Duplex", 7)}${pad("Speed", 7)}Type`];
  for (const p of sw.ports) {
    if (p.media === "console") continue;
    const c = sw.portCfg(p);
    const status = c.errDisabled ? "err-disabled" : c.shutdown ? "disabled" : p.isUp ? "connected" : "notconnect";
    const vlan = sw.opMode(p) === "trunk" ? "trunk" : sw.opMode(p) === "routed" ? "routed" : String(c.accessVlan);
    lines.push(`${pad(p.short, 10)}${pad(c.description.slice(0, 18), 19)}${pad(status, 13)}${pad(vlan, 11)}${pad(p.isUp ? "a-full" : "auto", 7)}${pad(p.isUp ? `a-${p.speed}` : "auto", 7)}${p.media === "fiber" ? "1000BaseSX SFP" : p.speed === 1000 ? "10/100/1000BaseTX" : "10/100BaseTX"}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Running configuration

function commonHeader(dev: IosDevice): string[] {
  const ios = dev.ios;
  const out = ["!", "version 1.0", "no service timestamps log datetime msec", "no service timestamps debug datetime msec", ios.passwordEncryption ? "service password-encryption" : "no service password-encryption", "!", `hostname ${dev.hostname}`, "!"];
  if (ios.enableSecret) out.push(`enable secret 5 ${hashSecret(ios.enableSecret)}`);
  if (ios.enablePassword) out.push(`enable password ${ios.passwordEncryption ? "7 " + encodeType7(ios.enablePassword) : ios.enablePassword}`);
  if (ios.enableSecret || ios.enablePassword) out.push("!");
  return out;
}

function commonUsers(dev: IosDevice): string[] {
  const ios = dev.ios;
  const out: string[] = [];
  if (!ios.domainLookup) out.push("no ip domain-lookup");
  if (ios.domainName) out.push(`ip domain-name ${ios.domainName}`);
  for (const u of ios.users) out.push(`username ${u.name}${u.privilege !== 1 ? ` privilege ${u.privilege}` : ""} secret 5 ${hashSecret(u.secret)}`);
  if (ios.sshKeyBits) out.push("ip ssh version 2");
  if (!ios.cdp) out.push("no cdp run");
  if (ios.lldp && false) out.push("lldp run");
  if (out.length) out.push("!");
  return out;
}

function commonLines(dev: IosDevice): string[] {
  const ios = dev.ios;
  const pw = (p: string) => (ios.passwordEncryption ? `7 ${encodeType7(p)}` : p);
  const out: string[] = [];
  if (ios.banner) out.push(`banner motd ^C${ios.banner}^C`, "!");
  for (const x of ios.extra) out.push(x);
  if (ios.extra.length) out.push("!");
  out.push("line con 0");
  if (ios.consolePassword) out.push(` password ${pw(ios.consolePassword)}`);
  if (ios.logging.synchronous) out.push(" logging synchronous");
  if (ios.consoleLogin) out.push(" login");
  out.push("!");
  if (dev instanceof Router) out.push("line aux 0", "!");
  out.push("line vty 0 4");
  if (ios.vtyPassword) out.push(` password ${pw(ios.vtyPassword)}`);
  if (ios.vtyLogin === "password") out.push(" login");
  if (ios.vtyLogin === "local") out.push(" login local");
  if (ios.vtyTransport !== "all") out.push(` transport input ${ios.vtyTransport}`);
  out.push("!", "end");
  return out;
}

function aclLines(dev: Router | Switch): string[] {
  const out: string[] = [];
  for (const [name, acl] of Object.entries(dev.cfg.acls)) {
    if (/^\d+$/.test(name)) for (const e of acl.entries) out.push(`access-list ${name} ${formatEntry(acl, e)}`);
    else {
      out.push(`ip access-list ${acl.type} ${name}`);
      for (const e of acl.entries) out.push(` ${formatEntry(acl, e)}`);
    }
  }
  if (out.length) out.push("!");
  return out;
}

function routingLines(dev: Router | Switch): string[] {
  const out: string[] = [];
  const c = dev.cfg.routing;
  if (c.eigrp) {
    out.push(`router eigrp ${c.eigrp.asn}`);
    if (c.eigrp.routerId) out.push(` eigrp router-id ${c.eigrp.routerId}`);
    for (const p of c.eigrp.passive) out.push(` passive-interface ${p}`);
    for (const n of c.eigrp.networks) out.push(` network ${n.network}${n.wildcard ? " " + n.wildcard : ""}`);
    if (c.eigrp.redistributeStatic) out.push(" redistribute static");
    if (!c.eigrp.autoSummary) out.push(" no auto-summary");
    out.push("!");
  }
  if (c.ospf) {
    out.push(`router ospf ${c.ospf.pid}`);
    if (c.ospf.routerId) out.push(` router-id ${c.ospf.routerId}`);
    out.push(" log-adjacency-changes");
    if (c.ospf.refBandwidth !== 100) out.push(` auto-cost reference-bandwidth ${c.ospf.refBandwidth}`);
    for (const p of c.ospf.passive) out.push(` passive-interface ${p}`);
    for (const n of c.ospf.networks) out.push(` network ${n.network} ${n.wildcard} area ${n.area}`);
    if (c.ospf.defaultOriginate) out.push(" default-information originate");
    out.push("!");
  }
  if (c.rip) {
    out.push("router rip");
    if (c.rip.version === 2) out.push(" version 2");
    for (const p of c.rip.passive) out.push(` passive-interface ${p}`);
    for (const n of c.rip.networks) out.push(` network ${n}`);
    if (c.rip.defaultOriginate) out.push(" default-information originate");
    if (c.rip.redistributeStatic) out.push(" redistribute static");
    if (c.rip.redistributeConnected) out.push(" redistribute connected");
    if (!c.rip.autoSummary) out.push(" no auto-summary");
    out.push("!");
  }
  return out;
}

function staticRouteLines(routes: { network: string; mask: string; nextHop?: string; iface?: string; ad: number }[]): string[] {
  return routes.map((r) => `ip route ${r.network} ${r.mask}${r.iface ? " " + r.iface : ""}${r.nextHop ? " " + r.nextHop : ""}${r.ad !== 1 ? " " + r.ad : ""}`);
}

export function runningConfig(dev: IosDevice): string {
  const out: string[] = [...commonHeader(dev)];
  if (dev instanceof Router) {
    const c = dev.cfg;
    for (const e of c.dhcpExcluded) out.push(`ip dhcp excluded-address ${e.from}${e.to !== e.from ? " " + e.to : ""}`);
    if (c.dhcpExcluded.length) out.push("!");
    for (const p of c.dhcpPools) {
      out.push(`ip dhcp pool ${p.name}`);
      if (p.network) out.push(` network ${p.network} ${p.mask}`);
      if (p.defaultRouter) out.push(` default-router ${p.defaultRouter}`);
      if (p.dns) out.push(` dns-server ${p.dns}`);
      if (p.domain) out.push(` domain-name ${p.domain}`);
      out.push("!");
    }
    out.push(...commonUsers(dev));
    if (!c.ipRouting) out.push("no ip routing", "!");
    for (const name of Object.keys(c.interfaces).sort(ifSort)) {
      const i = c.interfaces[name];
      out.push(`interface ${name}`);
      if (i.description) out.push(` description ${i.description}`);
      if (i.dot1q !== undefined) out.push(` encapsulation dot1Q ${i.dot1q}${i.native ? " native" : ""}`);
      if (i.encapsulation === "ppp") out.push(" encapsulation ppp");
      if (i.bandwidth) out.push(` bandwidth ${i.bandwidth}`);
      if (i.dhcpClient) out.push(" ip address dhcp");
      else if (i.ip && i.mask) out.push(` ip address ${i.ip} ${i.mask}`);
      else out.push(" no ip address");
      for (const h of i.helpers) out.push(` ip helper-address ${h}`);
      if (i.aclIn) out.push(` ip access-group ${i.aclIn} in`);
      if (i.aclOut) out.push(` ip access-group ${i.aclOut} out`);
      if (i.nat) out.push(` ip nat ${i.nat}`);
      if (i.ospfCost) out.push(` ip ospf cost ${i.ospfCost}`);
      const p = dev.port(name);
      if (p && p.media === "copper") out.push(" duplex auto", " speed auto");
      if (i.clockRate) out.push(` clock rate ${i.clockRate}`);
      if (i.shutdown) out.push(" shutdown");
      out.push("!");
    }
    out.push(...routingLines(dev));
    for (const [name, pool] of Object.entries(c.nat.pools)) out.push(`ip nat pool ${name} ${pool.start} ${pool.end} netmask ${pool.mask}`);
    for (const r of c.nat.rules) out.push(`ip nat inside source list ${r.acl} ${r.iface ? "interface " + r.iface : "pool " + r.pool}${r.overload ? " overload" : ""}`);
    for (const s of c.nat.statics) out.push(s.proto ? `ip nat inside source static ${s.proto} ${s.inside} ${s.insidePort} ${s.global} ${s.globalPort}` : `ip nat inside source static ${s.inside} ${s.global}`);
    out.push("ip classless");
    out.push(...staticRouteLines(c.routes));
    for (const ns of c.nameServers) out.push(`ip name-server ${ns}`);
    for (const [h, ip] of Object.entries(c.hosts)) out.push(`ip host ${h} ${ip}`);
    out.push("!", "ip flow-export version 9", "!");
    out.push(...aclLines(dev));
  } else {
    const sw = dev as Switch;
    const c = sw.cfg;
    out.push(...commonUsers(dev));
    if (sw.layer3 && c.ipRouting) out.push("ip routing", "!");
    for (const e of c.ports ? [] : []) out.push(e);
    out.push(`spanning-tree mode ${c.stp.mode}`);
    if (c.stp.priority !== 32768) out.push(`spanning-tree vlan 1 priority ${c.stp.priority}`);
    if (!c.stp.enabled) out.push("no spanning-tree vlan 1");
    out.push("!");
    for (const p of sw.ports) {
      if (p.media === "console") continue;
      const i = sw.portCfg(p);
      out.push(`interface ${p.name}`);
      if (i.description) out.push(` description ${i.description}`);
      if (i.routed) {
        out.push(" no switchport");
        if (i.ip && i.mask) out.push(` ip address ${i.ip} ${i.mask}`);
        else out.push(" no ip address");
      } else {
        if (i.mode === "access" && i.accessVlan !== 1) out.push(` switchport access vlan ${i.accessVlan}`);
        if (i.voiceVlan) out.push(` switchport voice vlan ${i.voiceVlan}`);
        if (i.mode === "trunk" && i.nativeVlan !== 1) out.push(` switchport trunk native vlan ${i.nativeVlan}`);
        if (i.mode === "trunk" && i.allowed !== "all") out.push(` switchport trunk allowed vlan ${compressVlans(i.allowed)}`);
        if (i.mode !== "dynamic") out.push(` switchport mode ${i.mode}`);
        if (i.security.enabled) {
          out.push(" switchport port-security");
          if (i.security.max !== 1) out.push(` switchport port-security maximum ${i.security.max}`);
          if (i.security.violation !== "shutdown") out.push(` switchport port-security violation ${i.security.violation}`);
          if (i.security.sticky) {
            out.push(" switchport port-security mac-address sticky");
            for (const m of i.security.macs) out.push(` switchport port-security mac-address sticky ${macDotted(m)}`);
          }
        }
        if (i.portfast) out.push(" spanning-tree portfast");
        if (i.bpduguard) out.push(" spanning-tree bpduguard enable");
      }
      if (i.channelGroup) out.push(` channel-group ${i.channelGroup} mode active`);
      if (i.shutdown) out.push(" shutdown");
      out.push("!");
    }
    for (const [k, s] of Object.entries(c.svis)) {
      out.push(`interface Vlan${k}`);
      if (s.description) out.push(` description ${s.description}`);
      if (s.ip && s.mask) out.push(` ip address ${s.ip} ${s.mask}`);
      else out.push(" no ip address");
      for (const h of s.helpers) out.push(` ip helper-address ${h}`);
      if (s.aclIn) out.push(` ip access-group ${s.aclIn} in`);
      if (s.aclOut) out.push(` ip access-group ${s.aclOut} out`);
      if (s.shutdown) out.push(" shutdown");
      out.push("!");
    }
    if (c.defaultGateway) out.push(`ip default-gateway ${c.defaultGateway}`);
    if (sw.layer3) {
      out.push(...routingLines(sw));
      out.push("ip classless", ...staticRouteLines(c.routes));
    }
    out.push("!");
    out.push(...aclLines(sw));
  }
  out.push(...commonLines(dev));
  const text = out.join("\n");
  return `Building configuration...\n\nCurrent configuration : ${text.length} bytes\n${text}\n`;
}

export function vlanNameDefault(v: number) {
  return `VLAN${String(v).padStart(4, "0")}`;
}

export { wildcardToMask };
