// A small command grammar engine with IOS-like behaviour: keyword
// abbreviation, ambiguity detection, `?` help, tab completion and `no` forms.

import { isValidIp } from "../addr";

export type ParamKind = "ip" | "mask" | "num" | "word" | "line" | "if" | "vlans" | "mac" | "hex";

export interface Token {
  lit?: string[]; // literal alternatives
  param?: ParamKind;
  name?: string;
  min?: number;
  max?: number;
  help?: string;
}

export interface Syntax {
  tokens: Token[];
  cmd: CommandDef;
}

export type Args = Record<string, string> & { _neg?: string };

export interface CommandDef {
  modes: string[];
  syntax: string | string[];
  help?: Record<string, string>;
  /** Supports a `no` form. If omitted, `no` is rejected. */
  no?: boolean;
  /** Hidden from `?` listings. */
  hidden?: boolean;
  run: (args: Args, neg: boolean) => void;
}

const PARAM_HELP: Record<ParamKind, string> = {
  ip: "A.B.C.D",
  mask: "A.B.C.D",
  num: "<num>",
  word: "WORD",
  line: "LINE",
  if: "Interface",
  vlans: "WORD",
  mac: "H.H.H",
  hex: "<hex>",
};

/**
 * Parses a syntax string. Tokens:
 *   word            literal
 *   {a|b|c}         literal alternatives
 *   <name:ip>       IPv4 address
 *   <name:mask>     subnet mask / wildcard
 *   <name:num:1-99> number with optional range
 *   <name:word>     any token
 *   <name:line>     rest of the line
 *   <name:if>       interface name (may span two tokens)
 *   <name:vlans>    VLAN list such as 10,20,30-35
 */
export function parseSyntax(s: string, help: Record<string, string> = {}): Token[] {
  const out: Token[] = [];
  for (const raw of s.trim().split(/\s+/)) {
    if (raw.startsWith("{")) {
      const lit = raw.slice(1, -1).split("|");
      out.push({ lit, help: help[lit[0]] });
    } else if (raw.startsWith("<")) {
      const [name, kind, range] = raw.slice(1, -1).split(":");
      const t: Token = { param: (kind as ParamKind) ?? "word", name, help: help[name] };
      if (range) {
        const [a, b] = range.split("-").map(Number);
        t.min = a;
        t.max = b;
      }
      out.push(t);
    } else out.push({ lit: [raw.toLowerCase()], help: help[raw.toLowerCase()] });
  }
  return out;
}

const IF_TYPES = [
  "gigabitethernet",
  "fastethernet",
  "ethernet",
  "serial",
  "loopback",
  "vlan",
  "port-channel",
  "tunnel",
];

/** Normalises an interface reference to `TypeN/N` form; returns null if invalid. */
export function normalizeIfName(input: string): string | null {
  const m = input.trim().match(/^([a-zA-Z-]+)\s*([\d/.:]+)$/);
  if (!m) return null;
  const t = m[1].toLowerCase();
  const matches = IF_TYPES.filter((x) => x.startsWith(t));
  // Common short forms.
  const alias: Record<string, string> = { g: "gigabitethernet", gi: "gigabitethernet", f: "fastethernet", fa: "fastethernet", e: "ethernet", s: "serial", se: "serial", lo: "loopback", vl: "vlan", po: "port-channel", tu: "tunnel" };
  const type = alias[t] ?? (matches.length === 1 ? matches[0] : undefined);
  if (!type) return null;
  const proper: Record<string, string> = {
    gigabitethernet: "GigabitEthernet",
    fastethernet: "FastEthernet",
    ethernet: "Ethernet",
    serial: "Serial",
    loopback: "Loopback",
    vlan: "Vlan",
    "port-channel": "Port-channel",
    tunnel: "Tunnel",
  };
  return proper[type] + m[2];
}

interface MatchState {
  args: Args;
  pos: number; // input index
  ti: number; // token index
  exactLits: number;
  litAt: Map<number, string>;
}

export interface MatchResult {
  full: { syntax: Syntax; args: Args; exact: number; litAt: Map<number, string>; params: number }[];
  incomplete: boolean;
  failAt: number;
  /** Options for the next token (for `?`), when input ended mid-syntax. */
  next: { word: string; help: string }[];
  /** Matching keywords for a partially typed last token. */
  partial: { word: string; help: string; lit?: boolean }[];
  canEnd: boolean;
}

function paramOk(t: Token, v: string): boolean {
  switch (t.param) {
    case "ip":
    case "mask":
      return isValidIp(v);
    case "num": {
      if (!/^\d+$/.test(v)) return false;
      const n = Number(v);
      return (t.min === undefined || n >= t.min) && (t.max === undefined || n <= t.max);
    }
    case "vlans":
      return /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(v);
    case "mac":
      return /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(v);
    case "hex":
      return /^(0x)?[0-9a-f]+$/i.test(v);
    default:
      return v.length > 0;
  }
}

/** Matches input tokens against all syntaxes. */
export function match(input: string[], syntaxes: Syntax[], trailingSpace: boolean): MatchResult {
  const res: MatchResult = { full: [], incomplete: false, failAt: 0, next: [], partial: [], canEnd: false };
  const addNext = (t: Token) => {
    if (t.lit) for (const l of t.lit) res.next.push({ word: l, help: t.help ?? "" });
    else res.next.push({ word: t.param === "num" && t.min !== undefined ? `<${t.min}-${t.max}>` : PARAM_HELP[t.param!], help: t.help ?? "" });
  };
  for (const syn of syntaxes) {
    const stack: MatchState[] = [{ args: {} as Args, pos: 0, ti: 0, exactLits: 0, litAt: new Map() }];
    while (stack.length) {
      const st = stack.pop()!;
      if (st.pos === input.length) {
        if (st.ti === syn.tokens.length) {
          res.full.push({ syntax: syn, args: st.args, exact: st.exactLits, litAt: st.litAt, params: Object.keys(st.args).length });
          res.canEnd = true;
        } else {
          res.incomplete = true;
          if (trailingSpace || input.length === 0) addNext(syn.tokens[st.ti]);
        }
        continue;
      }
      if (st.ti === syn.tokens.length) {
        res.failAt = Math.max(res.failAt, st.pos);
        continue;
      }
      const t = syn.tokens[st.ti];
      const v = input[st.pos];
      const isLast = st.pos === input.length - 1 && !trailingSpace;
      if (t.lit) {
        const lv = v.toLowerCase();
        for (const l of t.lit) {
          if (!l.startsWith(lv)) continue;
          if (isLast) res.partial.push({ word: l, help: t.help ?? "", lit: true });
          const litAt = new Map(st.litAt);
          litAt.set(st.pos, l);
          const args = t.lit.length > 1 ? ({ ...st.args, _lit: l } as Args) : st.args;
          stack.push({ args, pos: st.pos + 1, ti: st.ti + 1, exactLits: st.exactLits + (l === lv ? 1 : 0), litAt });
        }
        if (!t.lit.some((l) => l.startsWith(lv))) res.failAt = Math.max(res.failAt, st.pos);
        continue;
      }
      if (t.param === "line") {
        stack.push({ args: { ...st.args, [t.name!]: input.slice(st.pos).join(" ") }, pos: input.length, ti: st.ti + 1, exactLits: st.exactLits, litAt: st.litAt });
        continue;
      }
      if (t.param === "if") {
        const one = normalizeIfName(v);
        if (one) stack.push({ args: { ...st.args, [t.name!]: one }, pos: st.pos + 1, ti: st.ti + 1, exactLits: st.exactLits, litAt: st.litAt });
        if (/^[a-zA-Z-]+$/.test(v)) {
          if (st.pos + 1 < input.length) {
            const two = normalizeIfName(v + input[st.pos + 1]);
            if (two) stack.push({ args: { ...st.args, [t.name!]: two }, pos: st.pos + 2, ti: st.ti + 1, exactLits: st.exactLits, litAt: st.litAt });
            else res.failAt = Math.max(res.failAt, st.pos + 1);
          } else {
            const types = IF_TYPES.filter((x) => x.startsWith(v.toLowerCase()));
            if (types.length) {
              res.incomplete = true;
              if (isLast) for (const x of types) res.partial.push({ word: x, help: "Interface type" });
              else res.next.push({ word: "<0-9>", help: "Interface number" });
            } else res.failAt = Math.max(res.failAt, st.pos);
          }
        } else if (!one) res.failAt = Math.max(res.failAt, st.pos);
        continue;
      }
      if (paramOk(t, v)) {
        if (isLast) res.partial.push({ word: PARAM_HELP[t.param!], help: t.help ?? "" });
        stack.push({ args: { ...st.args, [t.name!]: v }, pos: st.pos + 1, ti: st.ti + 1, exactLits: st.exactLits, litAt: st.litAt });
      } else res.failAt = Math.max(res.failAt, st.pos);
    }
  }
  return res;
}

/** Splits a command line into tokens, honouring double quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}

export function expandVlans(list: string): number[] {
  const out: number[] = [];
  for (const part of list.split(",")) {
    const [a, b] = part.split("-").map(Number);
    if (b === undefined) out.push(a);
    else for (let i = a; i <= b && i - a < 4095; i++) out.push(i);
  }
  return out;
}

export function compressVlans(v: number[]): string {
  const s = [...new Set(v)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(",");
}
