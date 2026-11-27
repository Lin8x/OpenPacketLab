// Core of the simulator: a discrete-event scheduler, links, ports and the
// base Device class. Everything runs in simulated milliseconds.

import { generateMac, reserveMac, type MAC } from "./addr";
import { protocolOf, summarize, type EthernetFrame } from "./packets";

export type Media = "copper" | "fiber" | "serial" | "console" | "wireless";
export type CableType = "straight" | "crossover" | "fiber" | "serial" | "console" | "wireless";

export const CABLE_LABEL: Record<CableType, string> = {
  straight: "Copper straight-through",
  crossover: "Copper crossover",
  fiber: "Fiber",
  serial: "Serial DCE/DTE",
  console: "Console (rollover)",
  wireless: "Wireless association",
};

export type DeviceKind =
  | "pc"
  | "laptop"
  | "server"
  | "printer"
  | "phone"
  | "tablet"
  | "iot"
  | "switch"
  | "l3switch"
  | "router"
  | "hub"
  | "ap"
  | "firewall"
  | "cloud";

export type MdiRole = "mdi" | "mdix";

// ---------------------------------------------------------------------------
// Scheduler

interface SchedEvent {
  time: number;
  seq: number;
  fn: () => void;
  owner?: string;
  cancelled?: boolean;
  tx?: Transmission;
}

class Heap {
  private a: SchedEvent[] = [];
  get size() {
    return this.a.length;
  }
  peek(): SchedEvent | undefined {
    return this.a[0];
  }
  push(e: SchedEvent) {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[i], a[p])) {
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      } else break;
    }
  }
  pop(): SchedEvent | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  items(): SchedEvent[] {
    return this.a;
  }
  clear() {
    this.a = [];
  }
}

function less(x: SchedEvent, y: SchedEvent) {
  return x.time < y.time || (x.time === y.time && x.seq < y.seq);
}

// ---------------------------------------------------------------------------
// Ports and links

export class Port {
  link?: Link;
  adminUp = true;
  description = "";
  /** For switch ports: spanning tree forwarding state. Others: always "forwarding". */
  stpState: "disabled" | "blocking" | "listening" | "learning" | "forwarding" = "forwarding";

  constructor(
    public device: Device,
    public name: string,
    public short: string,
    public media: Media,
    public speed: number, // Mbps
    public mac: MAC = generateMac(),
  ) {
    reserveMac(mac);
  }

  get peer(): Port | undefined {
    if (!this.link) return undefined;
    return this.link.a === this ? this.link.b : this.link.a;
  }

  /** Physical layer is up (both ends powered, enabled, compatible cable). */
  get isUp(): boolean {
    return !!this.link && this.link.isUp && this.adminUp;
  }

  /** Light colour shown at this end of the link. */
  get light(): "green" | "amber" | "red" | "off" {
    if (!this.link) return "off";
    if (!this.isUp) return "red";
    if (this.stpState === "blocking" || this.stpState === "listening" || this.stpState === "learning") return "amber";
    return "green";
  }
}

export class Link {
  constructor(
    public id: string,
    public a: Port,
    public b: Port,
    public cable: CableType,
  ) {}

  get compatible(): boolean {
    return cableWorks(this.cable, this.a, this.b);
  }

  get isUp(): boolean {
    return (
      this.compatible &&
      this.a.adminUp &&
      this.b.adminUp &&
      this.a.device.powered &&
      this.b.device.powered &&
      this.a.device.portPhysicallyUp(this.a) &&
      this.b.device.portPhysicallyUp(this.b)
    );
  }

  /** One-way propagation + serialization delay in simulated ms. */
  get delay(): number {
    const sp = Math.min(this.a.speed, this.b.speed);
    if (this.cable === "serial") return 4;
    if (this.cable === "wireless") return 2;
    return sp >= 1000 ? 0.2 : sp >= 100 ? 0.5 : 1;
  }

  other(p: Port): Port {
    return p === this.a ? this.b : this.a;
  }
}

export function mediaForCable(c: CableType): Media {
  if (c === "straight" || c === "crossover") return "copper";
  if (c === "fiber") return "fiber";
  if (c === "serial") return "serial";
  if (c === "console") return "console";
  return "wireless";
}

export function cableFitsPort(c: CableType, p: Port): boolean {
  const m = mediaForCable(c);
  if (c === "console") return p.media === "console" || (p.media === "copper" && p.device.isHost);
  return p.media === m;
}

export function cableWorks(c: CableType, a: Port, b: Port): boolean {
  if (!cableFitsPort(c, a) || !cableFitsPort(c, b)) return false;
  if (c === "straight" || c === "crossover") {
    const same = a.device.mdi === b.device.mdi;
    // Ports with auto-MDIX accept either cable.
    if (a.device.autoMdix && b.device.autoMdix) return true;
    return c === "crossover" ? same : !same;
  }
  if (c === "console") return a.media === "console" || b.media === "console";
  return true;
}

/** Picks the cable an "automatic" connection should use. */
export function autoCable(a: Port, b: Port): CableType | null {
  if (a.media !== b.media) {
    if (a.media === "console" || b.media === "console") return "console";
    return null;
  }
  switch (a.media) {
    case "fiber":
      return "fiber";
    case "serial":
      return "serial";
    case "console":
      return null;
    case "wireless":
      return "wireless";
    default:
      return a.device.mdi === b.device.mdi ? "crossover" : "straight";
  }
}

// ---------------------------------------------------------------------------
// Device base

export interface LogLine {
  time: number;
  text: string;
}

export abstract class Device {
  net?: Network;
  ports: Port[] = [];
  powered = true;
  x = 0;
  y = 0;
  /** Messages printed to the device console (IOS-style log). */
  consoleLog: LogLine[] = [];
  consoleListeners = new Set<(line: string) => void>();
  abstract readonly kind: DeviceKind;
  abstract readonly model: string;
  readonly mdi: MdiRole = "mdi";
  readonly autoMdix: boolean = false;
  readonly isHost: boolean = false;

  constructor(
    public id: string,
    public hostname: string,
  ) {}

  /** Label shown on the canvas. */
  get label(): string {
    return this.hostname;
  }

  abstract receive(port: Port, frame: EthernetFrame): void;

  /** Called when any port's link status may have changed. */
  onLinkChange(_port: Port): void {}

  /** Called once after the device joins a network, and after power-on. */
  start(): void {}

  /** Called when powered off or removed: clear dynamic state. */
  stop(): void {}

  /** Whether the port's own hardware/config lets the link come up. */
  portPhysicallyUp(_p: Port): boolean {
    return true;
  }

  port(name: string): Port | undefined {
    const n = name.toLowerCase();
    return this.ports.find((p) => p.name.toLowerCase() === n || p.short.toLowerCase() === n);
  }

  send(port: Port, frame: EthernetFrame) {
    this.net?.transmit(port, frame);
  }

  schedule(delay: number, fn: () => void) {
    return this.net?.schedule(delay, fn, this.id);
  }

  every(interval: number, fn: () => void, jitter = 0) {
    const tick = () => {
      if (!this.powered || !this.net) return;
      fn();
      this.schedule(interval + Math.random() * jitter, tick);
    };
    this.schedule(Math.random() * Math.min(interval, 1000) + 1, tick);
  }

  /** Writes to the device console like an IOS syslog line. */
  log(text: string) {
    const line: LogLine = { time: this.net?.time ?? 0, text };
    this.consoleLog.push(line);
    if (this.consoleLog.length > 500) this.consoleLog.splice(0, this.consoleLog.length - 500);
    for (const l of this.consoleListeners) l(text);
  }

  drop(frame: EthernetFrame, reason: string) {
    this.net?.recordDrop(this, frame, reason);
  }

  setPower(on: boolean) {
    if (on === this.powered) return;
    this.powered = on;
    if (!on) this.stop();
    for (const p of this.ports) if (p.link) this.net?.linkChanged(p.link);
    if (on) this.start();
  }

  abstract serialize(): DeviceConfig;
  abstract load(cfg: DeviceConfig): void;
}

export interface DeviceConfig {
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Network

export interface Transmission {
  id: number;
  time: number;
  arrive: number;
  linkId: string;
  from: string; // device id
  fromPort: string;
  to: string;
  toPort: string;
  frame: EthernetFrame;
  proto: string;
  summary: string;
  status: "in-flight" | "delivered" | "lost";
}

export interface DropRecord {
  id: number;
  time: number;
  device: string;
  frame: EthernetFrame;
  proto: string;
  reason: string;
}

export type NetEvent =
  | { type: "tx"; tx: Transmission }
  | { type: "delivered"; tx: Transmission }
  | { type: "drop"; drop: DropRecord }
  | { type: "link"; link: Link }
  | { type: "topology" };

export class Network {
  time = 0;
  devices = new Map<string, Device>();
  links = new Map<string, Link>();
  private heap = new Heap();
  private seq = 0;
  private txSeq = 0;
  private listeners = new Set<(e: NetEvent) => void>();
  inFlight = new Map<number, Transmission>();
  stormWarning = false;
  /** Max frames in flight before frames are discarded to stop broadcast storms. */
  maxInFlight = 4000;

  on(fn: (e: NetEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: NetEvent) {
    for (const l of this.listeners) l(e);
  }

  // --- topology -----------------------------------------------------------

  add(d: Device) {
    this.devices.set(d.id, d);
    d.net = this;
    if (d.powered) d.start();
    this.emit({ type: "topology" });
  }

  remove(id: string) {
    const d = this.devices.get(id);
    if (!d) return;
    for (const p of d.ports) if (p.link) this.disconnect(p.link.id);
    d.stop();
    this.devices.delete(id);
    this.clearOwner(id);
    d.net = undefined;
    this.emit({ type: "topology" });
  }

  connect(a: Port, b: Port, cable: CableType, id = `l${Math.random().toString(36).slice(2, 10)}`): Link {
    if (a.link || b.link) throw new Error("Port already in use");
    if (a === b) throw new Error("Cannot connect a port to itself");
    const link = new Link(id, a, b, cable);
    a.link = link;
    b.link = link;
    this.links.set(id, link);
    this.linkChanged(link);
    this.emit({ type: "topology" });
    return link;
  }

  disconnect(id: string) {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    link.a.link = undefined;
    link.b.link = undefined;
    link.a.device.onLinkChange(link.a);
    link.b.device.onLinkChange(link.b);
    this.emit({ type: "link", link });
    this.emit({ type: "topology" });
  }

  linkChanged(link: Link) {
    link.a.device.onLinkChange(link.a);
    link.b.device.onLinkChange(link.b);
    this.emit({ type: "link", link });
  }

  // --- scheduling ---------------------------------------------------------

  schedule(delay: number, fn: () => void, owner?: string) {
    const e: SchedEvent = { time: this.time + Math.max(0, delay), seq: this.seq++, fn, owner };
    this.heap.push(e);
    return { cancel: () => (e.cancelled = true) };
  }

  /** Cancels all timers owned by a device. */
  clearOwner(id: string) {
    for (const e of this.heap.items()) if (e.owner === id) e.cancelled = true;
  }

  transmit(port: Port, frame: EthernetFrame) {
    const link = port.link;
    if (!link || !port.isUp) return;
    if (this.inFlight.size >= this.maxInFlight) {
      if (!this.stormWarning) {
        this.stormWarning = true;
        port.device.log("%SIM-4-STORM: Too many frames in flight, possible broadcast storm. Frames are being discarded.");
      }
      return;
    }
    const peer = link.other(port);
    const tx: Transmission = {
      id: ++this.txSeq,
      time: this.time,
      arrive: this.time + link.delay,
      linkId: link.id,
      from: port.device.id,
      fromPort: port.name,
      to: peer.device.id,
      toPort: peer.name,
      frame,
      proto: protocolOf(frame),
      summary: summarize(frame),
      status: "in-flight",
    };
    this.inFlight.set(tx.id, tx);
    this.emit({ type: "tx", tx });
    const ev: SchedEvent = {
      time: tx.arrive,
      seq: this.seq++,
      tx,
      fn: () => {
        this.inFlight.delete(tx.id);
        if (!this.links.has(link.id) || !link.isUp || !peer.isUp) {
          tx.status = "lost";
          this.emit({ type: "delivered", tx });
          return;
        }
        tx.status = "delivered";
        this.emit({ type: "delivered", tx });
        if (peer.device.powered) peer.device.receive(peer, frame);
      },
    };
    this.heap.push(ev);
  }

  recordDrop(d: Device, frame: EthernetFrame, reason: string) {
    this.emit({
      type: "drop",
      drop: { id: ++this.txSeq, time: this.time, device: d.id, frame, proto: protocolOf(frame), reason },
    });
  }

  /** Runs all events up to and including `until`. Returns number processed. */
  runUntil(until: number, maxEvents = 200000): number {
    let n = 0;
    for (;;) {
      const e = this.heap.peek();
      if (!e || e.time > until || n >= maxEvents) break;
      this.heap.pop();
      if (e.cancelled) continue;
      this.time = Math.max(this.time, e.time);
      e.fn();
      n++;
    }
    if (n < maxEvents) this.time = Math.max(this.time, until);
    if (this.inFlight.size < this.maxInFlight / 2) this.stormWarning = false;
    return n;
  }

  advance(ms: number) {
    return this.runUntil(this.time + ms);
  }

  /**
   * Simulation-mode step: processes events until a batch of frame deliveries
   * that `visible` accepts has been completed. Invisible deliveries and timers
   * are processed silently. Returns delivered transmissions of that batch.
   */
  step(visible: (tx: Transmission) => boolean, maxSkipMs = 120000): Transmission[] {
    const limit = this.time + maxSkipMs;
    const delivered: Transmission[] = [];
    for (;;) {
      const e = this.heap.peek();
      if (!e || e.time > limit) break;
      if (delivered.length && e.time > delivered[0].arrive) break;
      this.heap.pop();
      if (e.cancelled) continue;
      this.time = Math.max(this.time, e.time);
      e.fn();
      if (e.tx && visible(e.tx)) delivered.push(e.tx);
    }
    return delivered;
  }

  /** Time of the next pending event, if any. */
  nextEventTime(): number | undefined {
    let best: number | undefined;
    for (const e of this.heap.items()) if (!e.cancelled && (best === undefined || e.time < best)) best = e.time;
    return best;
  }

  /** Clears all queued events and dynamic state (used when resetting). */
  clearQueue() {
    this.heap.clear();
    this.inFlight.clear();
  }

  findDeviceByName(name: string): Device | undefined {
    const n = name.toLowerCase();
    for (const d of this.devices.values()) if (d.hostname.toLowerCase() === n) return d;
    return undefined;
  }
}
