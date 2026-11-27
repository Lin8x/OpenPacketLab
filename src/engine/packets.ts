// Protocol data units. Frames are treated as immutable: devices that change a
// frame (routers rewriting MACs, decrementing TTL) create a new object.

import type { MAC } from "./addr";

export type EtherType = "arp" | "ipv4" | "stp" | "lldp";

export interface EthernetFrame {
  uid: number; // unique per transmission chain, used to correlate PDUs
  src: MAC;
  dst: MAC;
  vlan?: number; // 802.1Q tag, only present on trunk links
  type: EtherType;
  payload: ArpPacket | Ipv4Packet | Bpdu | LldpPdu;
}

export interface ArpPacket {
  kind: "arp";
  op: "request" | "reply";
  senderMac: MAC;
  senderIp: string;
  targetMac: MAC;
  targetIp: string;
}

export type IpProtocol = "icmp" | "udp" | "tcp" | "ospf" | "eigrp";

export interface Ipv4Packet {
  kind: "ipv4";
  id: number;
  src: string;
  dst: string;
  ttl: number;
  protocol: IpProtocol;
  payload: IcmpMessage | UdpDatagram | TcpSegment | OspfPacket | EigrpPacket;
}

export type IcmpType = "echo-request" | "echo-reply" | "time-exceeded" | "dest-unreachable";

export interface IcmpMessage {
  kind: "icmp";
  type: IcmpType;
  code: number; // dest-unreachable: 0 net, 1 host, 3 port, 13 admin prohibited
  ident: number;
  seq: number;
  /** For errors: the original packet's key fields. */
  original?: { src: string; dst: string; protocol: IpProtocol; ident?: number; seq?: number };
}

export interface UdpDatagram {
  kind: "udp";
  srcPort: number;
  dstPort: number;
  data: DhcpMessage | DnsMessage | RipMessage | TftpMessage | SyslogMessage | RawData;
}

export interface RawData {
  kind: "raw";
  text: string;
}

export interface TcpSegment {
  kind: "tcp";
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: { syn?: boolean; ack?: boolean; fin?: boolean; rst?: boolean; psh?: boolean };
  data?: string;
}

export type DhcpType = "discover" | "offer" | "request" | "ack" | "nak" | "release";

export interface DhcpMessage {
  kind: "dhcp";
  type: DhcpType;
  xid: number;
  clientMac: MAC;
  yourIp?: string;
  serverIp?: string;
  requestedIp?: string;
  mask?: string;
  router?: string;
  dns?: string;
  domain?: string;
  lease?: number;
  relayIp?: string; // giaddr
}

export interface DnsMessage {
  kind: "dns";
  id: number;
  response: boolean;
  name: string;
  qtype: "A" | "CNAME";
  answers: { name: string; type: "A" | "CNAME"; value: string }[];
  rcode: "ok" | "nxdomain";
}

export interface RipMessage {
  kind: "rip";
  command: "request" | "response";
  version: 2;
  routes: { network: string; mask: string; metric: number }[];
}

export interface TftpMessage {
  kind: "tftp";
  op: "rrq" | "wrq" | "data" | "ack" | "error";
  file?: string;
  content?: string;
}

export interface SyslogMessage {
  kind: "syslog";
  severity: number;
  text: string;
}

export interface OspfPacket {
  kind: "ospf";
  type: "hello" | "lsu";
  routerId: string;
  area: number;
  /** hello */
  neighbors?: string[];
  helloInterval?: number;
  deadInterval?: number;
  /** lsu: a full router LSA, flooded */
  lsa?: OspfLsa;
}

export interface EigrpPacket {
  kind: "eigrp";
  type: "hello" | "update";
  asn: number;
  routerId: string;
  /** Advertised routes with path bandwidth (kbps, minimum) and delay (tens of µs, sum). */
  routes?: { network: string; mask: string; bw: number; delay: number }[];
}

export interface OspfLsa {
  routerId: string;
  seq: number;
  area: number;
  /** stub networks and point-to-point/transit links. */
  links: { network: string; mask: string; cost: number; neighbor?: string }[];
}

export interface Bpdu {
  kind: "bpdu";
  rootId: string; // "priority.mac" e.g. "32769.0250.aabb.ccdd"
  rootCost: number;
  bridgeId: string;
  portId: number;
  tcn?: boolean;
}

export interface LldpPdu {
  kind: "lldp";
  systemName: string;
  portId: string;
  model: string;
  capabilities: string;
  mgmtIp?: string;
}

let uidCounter = 1;
export function nextUid(): number {
  return uidCounter++;
}

let ipIdCounter = 1;
export function nextIpId(): number {
  ipIdCounter = (ipIdCounter + 1) & 0xffff;
  return ipIdCounter;
}

/** Short protocol label for the frame, used by the event list and filters. */
export function protocolOf(f: EthernetFrame): string {
  const p = f.payload;
  switch (p.kind) {
    case "arp":
      return "ARP";
    case "bpdu":
      return "STP";
    case "lldp":
      return "LLDP";
    case "ipv4": {
      const q = p.payload;
      if (q.kind === "icmp") return "ICMP";
      if (q.kind === "ospf") return "OSPF";
      if (q.kind === "eigrp") return "EIGRP";
      if (q.kind === "tcp") {
        if (q.srcPort === 80 || q.dstPort === 80) return "HTTP";
        if (q.srcPort === 443 || q.dstPort === 443) return "HTTPS";
        if (q.srcPort === 23 || q.dstPort === 23) return "Telnet";
        if (q.srcPort === 22 || q.dstPort === 22) return "SSH";
        if (q.srcPort === 21 || q.dstPort === 21) return "FTP";
        return "TCP";
      }
      const d = q.data;
      if (d.kind === "dhcp") return "DHCP";
      if (d.kind === "dns") return "DNS";
      if (d.kind === "rip") return "RIP";
      if (d.kind === "tftp") return "TFTP";
      if (d.kind === "syslog") return "Syslog";
      return "UDP";
    }
  }
}

export const ALL_PROTOCOLS = [
  "ARP",
  "ICMP",
  "DHCP",
  "DNS",
  "HTTP",
  "HTTPS",
  "TCP",
  "UDP",
  "Telnet",
  "SSH",
  "FTP",
  "TFTP",
  "RIP",
  "OSPF",
  "EIGRP",
  "STP",
  "LLDP",
  "Syslog",
] as const;

/** One-line description, used in event lists. */
export function summarize(f: EthernetFrame): string {
  const p = f.payload;
  switch (p.kind) {
    case "arp":
      return p.op === "request"
        ? `Who has ${p.targetIp}? Tell ${p.senderIp}`
        : `${p.senderIp} is at ${p.senderMac}`;
    case "bpdu":
      return `Root ${p.rootId} cost ${p.rootCost}${p.tcn ? " (TCN)" : ""}`;
    case "lldp":
      return `${p.systemName} port ${p.portId}`;
    case "ipv4": {
      const q = p.payload;
      const base = `${p.src} → ${p.dst}`;
      if (q.kind === "icmp") return `${base} ${q.type}${q.type === "dest-unreachable" ? ` code ${q.code}` : ""} seq ${q.seq}`;
      if (q.kind === "ospf") return `${base} OSPF ${q.type} rid ${q.routerId}`;
      if (q.kind === "eigrp") return `${base} EIGRP AS ${q.asn} ${q.type}${q.routes ? ` (${q.routes.length} routes)` : ""}`;
      if (q.kind === "tcp") {
        const fl = Object.entries(q.flags)
          .filter(([, v]) => v)
          .map(([k]) => k.toUpperCase())
          .join(",");
        return `${base} :${q.srcPort}→:${q.dstPort} [${fl}]${q.data ? " " + q.data.split("\n")[0].slice(0, 40) : ""}`;
      }
      const d = q.data;
      if (d.kind === "dhcp") return `DHCP ${d.type.toUpperCase()}${d.yourIp ? " " + d.yourIp : ""}`;
      if (d.kind === "dns") return d.response ? `DNS reply ${d.name} → ${d.answers.map((a) => a.value).join(", ") || d.rcode}` : `DNS query ${d.name}`;
      if (d.kind === "rip") return `RIPv2 ${d.command} (${d.routes.length} routes)`;
      return `${base} UDP :${q.srcPort}→:${q.dstPort}`;
    }
  }
}

/** Structured per-layer description for the PDU inspector. */
export function describeLayers(f: EthernetFrame): { layer: string; title: string; fields: [string, string][] }[] {
  const out: { layer: string; title: string; fields: [string, string][] }[] = [];
  const l2: [string, string][] = [
    ["Source MAC", f.src],
    ["Destination MAC", f.dst],
    ["EtherType", f.type.toUpperCase()],
  ];
  if (f.vlan !== undefined) l2.push(["802.1Q VLAN", String(f.vlan)]);
  out.push({ layer: "Layer 2", title: "Ethernet II", fields: l2 });
  const p = f.payload;
  if (p.kind === "arp") {
    out.push({
      layer: "Layer 2.5",
      title: "ARP",
      fields: [
        ["Operation", p.op],
        ["Sender MAC", p.senderMac],
        ["Sender IP", p.senderIp],
        ["Target MAC", p.targetMac],
        ["Target IP", p.targetIp],
      ],
    });
  } else if (p.kind === "bpdu") {
    out.push({
      layer: "Layer 2",
      title: "Spanning Tree BPDU",
      fields: [
        ["Root ID", p.rootId],
        ["Root path cost", String(p.rootCost)],
        ["Bridge ID", p.bridgeId],
        ["Port ID", String(p.portId)],
      ],
    });
  } else if (p.kind === "lldp") {
    out.push({
      layer: "Layer 2",
      title: "LLDP",
      fields: [
        ["System name", p.systemName],
        ["Port ID", p.portId],
        ["Platform", p.model],
        ["Capabilities", p.capabilities],
        ["Management IP", p.mgmtIp ?? "none"],
      ],
    });
  } else if (p.kind === "ipv4") {
    out.push({
      layer: "Layer 3",
      title: "IPv4",
      fields: [
        ["Source", p.src],
        ["Destination", p.dst],
        ["TTL", String(p.ttl)],
        ["Protocol", p.protocol.toUpperCase()],
        ["Identification", String(p.id)],
      ],
    });
    const q = p.payload;
    if (q.kind === "icmp") {
      const fields: [string, string][] = [
        ["Type", q.type],
        ["Code", String(q.code)],
        ["Identifier", String(q.ident)],
        ["Sequence", String(q.seq)],
      ];
      out.push({ layer: "Layer 3", title: "ICMP", fields });
    } else if (q.kind === "ospf") {
      out.push({
        layer: "Layer 3",
        title: "OSPF",
        fields: [
          ["Type", q.type],
          ["Router ID", q.routerId],
          ["Area", String(q.area)],
          ...(q.neighbors ? ([["Neighbors", q.neighbors.join(", ") || "none"]] as [string, string][]) : []),
        ],
      });
    } else if (q.kind === "eigrp") {
      out.push({
        layer: "Layer 3",
        title: "EIGRP",
        fields: [
          ["Type", q.type],
          ["AS", String(q.asn)],
          ["Router ID", q.routerId],
          ...(q.routes ? ([["Routes", q.routes.map((r) => `${r.network}/${r.mask}`).join(", ")]] as [string, string][]) : []),
        ],
      });
    } else if (q.kind === "tcp") {
      out.push({
        layer: "Layer 4",
        title: "TCP",
        fields: [
          ["Source port", String(q.srcPort)],
          ["Destination port", String(q.dstPort)],
          ["Sequence", String(q.seq)],
          ["Acknowledgment", String(q.ack)],
          [
            "Flags",
            Object.entries(q.flags)
              .filter(([, v]) => v)
              .map(([k]) => k.toUpperCase())
              .join(", ") || "none",
          ],
        ],
      });
      if (q.data) out.push({ layer: "Layer 7", title: "Application data", fields: [["Payload", q.data]] });
    } else {
      out.push({
        layer: "Layer 4",
        title: "UDP",
        fields: [
          ["Source port", String(q.srcPort)],
          ["Destination port", String(q.dstPort)],
        ],
      });
      const d = q.data;
      const fields: [string, string][] = [];
      for (const [k, v] of Object.entries(d)) {
        if (k === "kind" || v === undefined) continue;
        fields.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
      }
      out.push({ layer: "Layer 7", title: d.kind.toUpperCase(), fields });
    }
  }
  return out;
}
