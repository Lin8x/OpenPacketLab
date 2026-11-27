import { Network, autoCable, type Device } from "../src/engine/network";
import { createDevice } from "../src/engine/project";
import { Host } from "../src/engine/devices/host";
import { Router } from "../src/engine/devices/router";
import { Switch } from "../src/engine/devices/switch";
import type { EchoResult } from "../src/engine/ipstack";

export class Lab {
  net = new Network();
  private n = 0;

  add<T extends Device>(kind: Parameters<typeof createDevice>[0], name: string, variant?: string): T {
    const d = createDevice(kind, `d${++this.n}`, name, variant);
    this.net.add(d);
    return d as T;
  }
  pc(name: string, ip?: string, mask = "255.255.255.0", gw = "") {
    const h = this.add<Host>("pc", name);
    if (ip) {
      h.ipConfig = { mode: "static", ip, mask, gateway: gw, dns: "" };
      h.applyConfig();
    }
    return h;
  }
  server(name: string, ip: string, gw = "") {
    const h = this.add<Host>("server", name);
    h.ipConfig = { mode: "static", ip, mask: "255.255.255.0", gateway: gw, dns: "" };
    h.applyConfig();
    return h;
  }
  sw(name: string) {
    const s = this.add<Switch>("switch", name);
    return s;
  }
  router(name: string) {
    return this.add<Router>("router", name);
  }
  link(a: Device, ap: string, b: Device, bp: string, cable?: Parameters<Network["connect"]>[2]) {
    const pa = a.port(ap)!;
    const pb = b.port(bp)!;
    if (!pa || !pb) throw new Error(`bad port ${ap} or ${bp}`);
    return this.net.connect(pa, pb, cable ?? autoCable(pa, pb)!);
  }
  run(ms: number) {
    this.net.advance(ms);
  }
  ping(h: Host | Router | Switch, dst: string, timeout = 2000): EchoResult {
    let res: EchoResult | undefined;
    h.stack.sendEcho(dst, { timeout, seq: Math.floor(Math.random() * 1e6) }, (r) => (res = r));
    this.run(timeout + 50);
    return res!;
  }
  /** Ping twice so the first (ARP) loss on routers doesn't matter. */
  reach(h: Host | Router | Switch, dst: string): boolean {
    for (let i = 0; i < 6; i++) if (this.ping(h, dst).kind === "reply") return true;
    return false;
  }
}

export function routerIf(r: Router, name: string, ip: string, mask = "255.255.255.0") {
  const c = r.ifCfg(name);
  c.ip = ip;
  c.mask = mask;
  c.shutdown = false;
  r.applyConfig();
  const p = r.parentPort(name);
  if (p?.link) r.net?.linkChanged(p.link);
}

export function fastStp(...sws: Switch[]) {
  for (const s of sws) s.forwardDelay = 100;
}
