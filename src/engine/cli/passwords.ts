// Password encodings shown in configuration. Type 7 uses the well-known
// reversible XOR scheme (it is obfuscation, not security). "Secret" values
// are shown as a salted hash string; the simulator keeps the clear text in
// the project file so the lab can be graded and recovered offline.

const XLAT = "dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87";

export function encodeType7(plain: string, seed = 2): string {
  let out = seed.toString().padStart(2, "0");
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length);
    out += c.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function decodeType7(enc: string): string | null {
  if (!/^\d{2}([0-9A-Fa-f]{2})*$/.test(enc)) return null;
  const seed = Number(enc.slice(0, 2));
  let out = "";
  for (let i = 2, j = 0; i < enc.length; i += 2, j++) {
    out += String.fromCharCode(parseInt(enc.slice(i, i + 2), 16) ^ XLAT.charCodeAt((seed + j) % XLAT.length));
  }
  return out;
}

const B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function fnv(s: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic display hash in the familiar `$1$salt$hash` shape. */
export function hashSecret(plain: string): string {
  const salt = Array.from({ length: 4 }, (_, i) => B64[fnv(plain, i * 31) % 64]).join("");
  let h = "";
  for (let i = 0; i < 22; i++) h += B64[fnv(salt + plain, i + 7) % 64];
  return `$1$${salt}$${h}`;
}
