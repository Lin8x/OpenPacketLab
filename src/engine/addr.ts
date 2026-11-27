// Address helpers for MAC and IPv4.

export type MAC = string; // canonical form: "aa:bb:cc:dd:ee:ff"
export const BROADCAST_MAC: MAC = "ff:ff:ff:ff:ff:ff";
export const ZERO_IP = "0.0.0.0";
export const BROADCAST_IP = "255.255.255.255";

export function isValidIp(s: string | undefined | null): boolean {
  if (!s) return false;
  const parts = s.trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function intToIp(n: number): string {
  n = n >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function prefixToMask(prefix: number): string {
  if (prefix <= 0) return "0.0.0.0";
  return intToIp((0xffffffff << (32 - prefix)) >>> 0);
}

export function maskToPrefix(mask: string): number {
  let n = ipToInt(mask);
  let c = 0;
  while (n & 0x80000000) {
    c++;
    n = (n << 1) >>> 0;
  }
  return c;
}

export function isValidMask(mask: string | undefined | null): boolean {
  if (!isValidIp(mask)) return false;
  const n = ipToInt(mask!);
  const inv = ~n >>> 0;
  return ((inv + 1) & inv) === 0;
}

/** Converts a wildcard (e.g. 0.0.0.255) to a mask (255.255.255.0). */
export function wildcardToMask(wc: string): string {
  return intToIp(~ipToInt(wc) >>> 0);
}

export function networkOf(ip: string, mask: string): string {
  return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
}

export function broadcastOf(ip: string, mask: string): string {
  return intToIp(((ipToInt(ip) & ipToInt(mask)) | (~ipToInt(mask) >>> 0)) >>> 0);
}

export function sameSubnet(a: string, b: string, mask: string): boolean {
  const m = ipToInt(mask);
  return ((ipToInt(a) & m) >>> 0) === ((ipToInt(b) & m) >>> 0);
}

export function inNetwork(ip: string, network: string, mask: string): boolean {
  return sameSubnet(ip, network, mask);
}

/** Matches an address against an ACL-style address + wildcard. */
export function matchesWildcard(ip: string, addr: string, wildcard: string): boolean {
  const care = ~ipToInt(wildcard) >>> 0;
  return ((ipToInt(ip) & care) >>> 0) === ((ipToInt(addr) & care) >>> 0);
}

export function classfulMask(ip: string): string {
  const first = Number(ip.split(".")[0]);
  if (first < 128) return "255.0.0.0";
  if (first < 192) return "255.255.0.0";
  return "255.255.255.0";
}

export function isMulticast(ip: string): boolean {
  const f = Number(ip.split(".")[0]);
  return f >= 224 && f <= 239;
}

export function isBroadcastFor(ip: string, ifIp: string, mask: string): boolean {
  return ip === BROADCAST_IP || ip === broadcastOf(ifIp, mask);
}

/** Parses "a.b.c.d/nn" into ip and mask. */
export function parseCidr(s: string): { ip: string; mask: string } | null {
  const m = s.trim().match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  if (!m || !isValidIp(m[1]) || Number(m[2]) > 32) return null;
  return { ip: m[1], mask: prefixToMask(Number(m[2])) };
}

export function isValidMac(s: string): boolean {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s) || /^([0-9a-f]{4}\.){2}[0-9a-f]{4}$/i.test(s);
}

export function normalizeMac(s: string): MAC {
  const hex = s.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return hex.match(/.{2}/g)!.join(":");
}

/** Cisco-style dotted MAC: 0201.a3b4.c5d6 */
export function macDotted(mac: MAC): string {
  const hex = mac.replace(/:/g, "");
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
}

/** Windows-style MAC: 02-01-A3-B4-C5-D6 */
export function macDashed(mac: MAC): string {
  return mac.toUpperCase().replace(/:/g, "-");
}

let macCounter = 1;
const usedMacs = new Set<string>();

/** Generates a locally administered unicast MAC. */
export function generateMac(): MAC {
  for (;;) {
    const r = Math.floor(Math.random() * 0xffffff);
    const n = macCounter++;
    const bytes = [0x02, 0x50, (r >> 16) & 255, (r >> 8) & 255, (n >> 8) & 255, n & 255];
    const mac = bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
    if (!usedMacs.has(mac)) {
      usedMacs.add(mac);
      return mac;
    }
  }
}

export function reserveMac(mac: MAC) {
  usedMacs.add(mac);
}
