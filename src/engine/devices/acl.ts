// Standard and extended IPv4 access lists.

import { matchesWildcard } from "../addr";
import type { Ipv4Packet } from "../packets";

export interface PortMatch {
  op: "eq" | "neq" | "gt" | "lt" | "range";
  a: number;
  b?: number;
}

export interface AclEntry {
  seq: number;
  action: "permit" | "deny" | "remark";
  protocol: "ip" | "icmp" | "tcp" | "udp" | "ospf" | "eigrp";
  src: { addr: string; wc: string };
  dst?: { addr: string; wc: string };
  srcPort?: PortMatch;
  dstPort?: PortMatch;
  icmpType?: string;
  established?: boolean;
  log?: boolean;
  remark?: string;
  matches?: number;
}

export interface Acl {
  type: "standard" | "extended";
  entries: AclEntry[];
}

export type AclConfig = Record<string, Acl>;

export function aclTypeForNumber(n: number): "standard" | "extended" | null {
  if ((n >= 1 && n <= 99) || (n >= 1300 && n <= 1999)) return "standard";
  if ((n >= 100 && n <= 199) || (n >= 2000 && n <= 2699)) return "extended";
  return null;
}

export const PORT_NAMES: Record<string, number> = {
  ftp: 21,
  "ftp-data": 20,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  domain: 53,
  www: 80,
  http: 80,
  pop3: 110,
  ntp: 123,
  https: 443,
  bootps: 67,
  bootpc: 68,
  tftp: 69,
  snmp: 161,
  syslog: 514,
  rip: 520,
};

export const ICMP_NAMES = ["echo", "echo-reply", "unreachable", "time-exceeded"];

function portOk(m: PortMatch | undefined, p: number | undefined): boolean {
  if (!m) return true;
  if (p === undefined) return false;
  switch (m.op) {
    case "eq":
      return p === m.a;
    case "neq":
      return p !== m.a;
    case "gt":
      return p > m.a;
    case "lt":
      return p < m.a;
    case "range":
      return p >= m.a && p <= (m.b ?? m.a);
  }
}

export function entryMatches(e: AclEntry, pkt: Ipv4Packet): boolean {
  if (e.action === "remark") return false;
  if (!matchesWildcard(pkt.src, e.src.addr, e.src.wc)) return false;
  if (e.dst && !matchesWildcard(pkt.dst, e.dst.addr, e.dst.wc)) return false;
  if (e.protocol !== "ip" && e.protocol !== pkt.protocol) return false;
  const q = pkt.payload;
  if (e.protocol === "tcp" || e.protocol === "udp") {
    const sp = q.kind === "tcp" || q.kind === "udp" ? q.srcPort : undefined;
    const dp = q.kind === "tcp" || q.kind === "udp" ? q.dstPort : undefined;
    if (!portOk(e.srcPort, sp) || !portOk(e.dstPort, dp)) return false;
    if (e.established && q.kind === "tcp" && !(q.flags.ack || q.flags.rst)) return false;
  }
  if (e.protocol === "icmp" && e.icmpType && q.kind === "icmp") {
    const t = q.type === "echo-request" ? "echo" : q.type === "dest-unreachable" ? "unreachable" : q.type;
    if (t !== e.icmpType) return false;
  }
  return true;
}

export class AclEngine {
  constructor(private cfg: () => AclConfig) {}

  /** Evaluates an ACL. Missing ACLs permit everything (like IOS). */
  permits(name: string, pkt: Ipv4Packet): boolean {
    const acl = this.cfg()[name];
    if (!acl) return true;
    for (const e of acl.entries) {
      if (entryMatches(e, pkt)) {
        e.matches = (e.matches ?? 0) + 1;
        return e.action === "permit";
      }
    }
    return false; // implicit deny
  }

  /** Matches only (used by NAT); does not count hits. */
  matches(name: string, pkt: Ipv4Packet): boolean {
    const acl = this.cfg()[name];
    if (!acl) return false;
    for (const e of acl.entries) if (entryMatches(e, pkt)) return e.action === "permit";
    return false;
  }
}

function fmtAddr(a: { addr: string; wc: string }): string {
  if (a.wc === "255.255.255.255") return "any";
  if (a.wc === "0.0.0.0") return `host ${a.addr}`;
  return `${a.addr} ${a.wc}`;
}

function fmtPort(p?: PortMatch): string {
  if (!p) return "";
  return p.op === "range" ? ` range ${p.a} ${p.b}` : ` ${p.op} ${p.a}`;
}

/** Renders one entry as it appears in configuration (without the prefix). */
export function formatEntry(acl: Acl, e: AclEntry): string {
  if (e.action === "remark") return `remark ${e.remark ?? ""}`;
  if (acl.type === "standard") return `${e.action} ${fmtAddr(e.src)}${e.log ? " log" : ""}`;
  let s = `${e.action} ${e.protocol} ${fmtAddr(e.src)}${fmtPort(e.srcPort)} ${fmtAddr(e.dst ?? { addr: "0.0.0.0", wc: "255.255.255.255" })}${fmtPort(e.dstPort)}`;
  if (e.icmpType) s += ` ${e.icmpType}`;
  if (e.established) s += " established";
  if (e.log) s += " log";
  return s;
}
