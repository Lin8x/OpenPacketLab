// Application state: the network, the project, selection, tools, the
// simulation clock and undo history.

import { Network, autoCable, cableFitsPort, cableWorks, type CableType, type Device, type Port, type Transmission, type DropRecord } from "../engine/network";
import { LIBRARY, createDevice, loadProject, serializeProject, type NoteRecord, type ProjectFile, type DeviceTemplate } from "../engine/project";
import { Host } from "../engine/devices/host";
import { IosDevice } from "../engine/devices/ios";
import { Router } from "../engine/devices/router";
import { Switch } from "../engine/devices/switch";
import { ALL_PROTOCOLS } from "../engine/packets";
import { CliSession } from "../engine/cli/session";
import { HostPrompt } from "../engine/cli/hostcmd";
import { backups } from "./storage";
import { prefs } from "./prefs.svelte";

export type Tool = "select" | "connect" | "note" | "delete" | "pdu";
export type CableChoice = "auto" | CableType;

export interface SimEvent {
  id: number;
  time: number;
  from: string;
  to: string;
  proto: string;
  info: string;
  status: Transmission["status"] | "dropped";
  tx?: Transmission;
  drop?: DropRecord;
}

export interface UserPdu {
  id: number;
  src: string;
  dst: string;
  dstIp: string;
  status: "pending" | "successful" | "failed";
  detail: string;
  time: number;
  repeat?: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}

export interface DeviceWindowState {
  id: string;
  tab: string;
  x: number;
  y: number;
  z: number;
}

const MAX_EVENTS = 3000;

class AppState {
  net = $state.raw(new Network());
  /** Incremented whenever the engine changes so views re-render. */
  tick = $state(0);
  name = $state("Untitled Lab");
  description = $state("");
  created = $state(new Date().toISOString());
  projectId = $state<string>(crypto.randomUUID());
  filePath = $state<string | null>(null);
  dirty = $state(false);
  notes = $state<NoteRecord[]>([]);
  view = $state({ x: 0, y: 0, zoom: 1 });

  selection = $state<Set<string>>(new Set());
  selectedLink = $state<string | null>(null);
  tool = $state<Tool>("select");
  cable = $state<CableChoice>("auto");
  pendingConnect = $state<{ device: string; port: string } | null>(null);
  pendingPdu = $state<string | null>(null);
  placing = $state<DeviceTemplate | null>(null);

  mode = $state<"realtime" | "simulation">("realtime");
  paused = $state(false);
  playing = $state(false);
  speed = $state(1);
  events = $state.raw<SimEvent[]>([]);
  selectedEvent = $state<number | null>(null);
  filters = $state<Set<string>>(new Set(["ARP", "ICMP", "DHCP", "DNS", "HTTP", "HTTPS", "TCP", "UDP", "Telnet", "SSH", "FTP", "TFTP", "RIP", "OSPF", "EIGRP", "Syslog"]));
  /** Frames currently animating in simulation mode. */
  animating = $state.raw<{ tx: Transmission; start: number }[]>([]);
  pdus = $state<UserPdu[]>([]);

  windows = $state<DeviceWindowState[]>([]);
  toasts = $state<Toast[]>([]);
  sheet = $state<null | "welcome" | "backups" | "prefs" | "about" | "project" | "shortcuts">("welcome");
  palette = $state(false);
  showLibrary = $state(true);
  showInspector = $state(true);

  /** Persistent terminal sessions per device so history survives closing windows. */
  clis = new Map<string, CliSession>();
  prompts = new Map<string, HostPrompt>();

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private unsub?: () => void;
  private bumpQueued = false;
  private zCounter = 10;
  private pduSeq = 1;
  private eventSeq = 1;
  private toastSeq = 1;

  constructor() {
    this.attach(this.net);
  }

  // ---------------------------------------------------------------- engine

  private attach(net: Network) {
    this.unsub?.();
    this.unsub = net.on((e) => {
      if (e.type === "tx" && this.mode === "simulation" && this.filters.has(e.tx.proto)) {
        this.pushEvent({ id: this.eventSeq++, time: e.tx.time, from: e.tx.from, to: e.tx.to, proto: e.tx.proto, info: e.tx.summary, status: "in-flight", tx: e.tx });
      } else if (e.type === "drop" && this.mode === "simulation" && this.filters.has(e.drop.proto)) {
        this.pushEvent({ id: this.eventSeq++, time: e.drop.time, from: e.drop.device, to: e.drop.device, proto: e.drop.proto, info: e.drop.reason, status: "dropped", drop: e.drop });
      } else if (e.type === "topology") this.markDirty();
      this.bump();
    });
  }

  private pushEvent(ev: SimEvent) {
    const list = this.events.length >= MAX_EVENTS ? this.events.slice(-MAX_EVENTS + 500) : this.events.slice();
    list.push(ev);
    this.events = list;
  }

  bump() {
    if (this.bumpQueued) return;
    this.bumpQueued = true;
    queueMicrotask(() => {
      this.bumpQueued = false;
      this.tick++;
    });
  }

  markDirty() {
    this.dirty = true;
  }

  device(id: string | null | undefined): Device | undefined {
    return id ? this.net.devices.get(id) : undefined;
  }

  get selectedDevices(): Device[] {
    void this.tick;
    return [...this.selection].map((id) => this.net.devices.get(id)).filter(Boolean) as Device[];
  }

  // ---------------------------------------------------------------- clock

  private lastFrame = 0;
  private stepBusy = false;

  frame(now: number) {
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    if (this.mode === "realtime" && !this.paused) {
      this.net.advance(dt * this.speed);
      this.bump();
    } else if (this.mode === "simulation") {
      const dur = this.animDuration();
      if (this.animating.length && now - this.animating[0].start > dur) {
        this.animating = [];
        this.stepBusy = false;
        this.bump();
      }
      if (this.playing && !this.stepBusy) this.step();
    }
    this.updatePdus();
  }

  animDuration() {
    return 700 / this.speed;
  }

  /** Simulation mode: advance to the next visible batch of frames. */
  step() {
    if (this.mode !== "simulation" || this.stepBusy) return;
    const delivered = this.net.step((tx) => this.filters.has(tx.proto));
    if (!delivered.length) {
      if (this.playing) {
        this.playing = false;
        this.toast("No more events. The simulation is idle.");
      }
      this.bump();
      return;
    }
    this.stepBusy = true;
    this.animating = delivered.map((tx) => ({ tx, start: performance.now() }));
    // Update statuses in the list.
    const ids = new Set(delivered.map((t) => t.id));
    this.events = this.events.map((e) => (e.tx && ids.has(e.tx.id) ? { ...e, status: e.tx.status } : e));
    this.bump();
  }

  setMode(m: "realtime" | "simulation") {
    if (m === this.mode) return;
    this.mode = m;
    this.playing = false;
    this.animating = [];
    this.stepBusy = false;
    if (m === "simulation") this.events = [];
    this.bump();
  }

  resetSimulation() {
    this.events = [];
    this.selectedEvent = null;
    this.animating = [];
    this.playing = false;
    this.stepBusy = false;
    for (const d of this.net.devices.values()) {
      if (d instanceof Host) d.stack.clearArp();
      if (d instanceof Router || d instanceof Switch) d.stack.clearArp();
      if (d instanceof Switch) d.clearMacTable();
    }
    this.toast("Simulation reset: event list, ARP caches and MAC tables cleared.");
    this.bump();
  }

  fastForward(ms = 30000) {
    this.net.advance(ms);
    this.toast(`Time moved forward ${Math.round(ms / 1000)} seconds.`);
    this.bump();
  }

  // ---------------------------------------------------------------- PDUs

  addPdu(srcId: string, dstId: string) {
    const src = this.device(srcId);
    const dst = this.device(dstId);
    if (!src || !dst) return;
    const ip = primaryIp(dst);
    if (!ip) return this.toast(`${dst.hostname} has no IP address yet.`, "error");
    const stack = stackOf(src);
    if (!stack) return this.toast(`${src.hostname} cannot send IP packets.`, "error");
    const pdu: UserPdu = { id: this.pduSeq++, src: srcId, dst: dstId, dstIp: ip, status: "pending", detail: "Waiting", time: this.net.time };
    this.pdus = [...this.pdus, pdu];
    stack.sendEcho(ip, { timeout: 4000, seq: 10000 + pdu.id }, (r) => {
      const p = this.pdus.find((x) => x.id === pdu.id);
      if (!p) return;
      p.status = r.kind === "reply" ? "successful" : "failed";
      p.detail = r.kind === "reply" ? `Reply from ${r.from} in ${Math.max(0, Math.round(r.rtt ?? 0))} ms` : r.kind === "timeout" ? "Request timed out" : r.kind === "ttl-exceeded" ? `TTL expired at ${r.from}` : `Unreachable${r.from ? " from " + r.from : ""}`;
      this.pdus = [...this.pdus];
    });
    this.bump();
  }

  private updatePdus() {}

  removePdu(id: number) {
    this.pdus = this.pdus.filter((p) => p.id !== id);
  }

  // ------------------------------------------------------------- topology

  private counter(prefix: string): number {
    let n = 0;
    const re = new RegExp(`^${prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(\\d+)$`);
    for (const d of this.net.devices.values()) {
      const m = d.hostname.match(re);
      if (m) n = Math.max(n, Number(m[1]));
    }
    return n + 1;
  }

  addDevice(t: DeviceTemplate, x: number, y: number): Device {
    this.checkpoint();
    const id = `d${Math.random().toString(36).slice(2, 9)}`;
    const name = `${t.prefix}${this.counter(t.prefix)}`;
    const d = createDevice(t.kind, id, name, t.variant);
    if (d instanceof Router || d instanceof Switch) d.cfg.hostname = name;
    if (d instanceof Switch && prefs.fastStp) d.forwardDelay = 1500;
    d.x = Math.round(x);
    d.y = Math.round(y);
    this.net.add(d);
    this.selection = new Set([id]);
    this.selectedLink = null;
    this.markDirty();
    return d;
  }

  removeDevices(ids: string[]) {
    if (!ids.length) return;
    this.checkpoint();
    for (const id of ids) {
      this.net.remove(id);
      this.clis.delete(id);
      this.prompts.delete(id);
      this.windows = this.windows.filter((w) => w.id !== id);
    }
    this.selection = new Set();
    this.markDirty();
  }

  removeLink(id: string) {
    this.checkpoint();
    this.net.disconnect(id);
    if (this.selectedLink === id) this.selectedLink = null;
    this.markDirty();
  }

  moveDevices(ids: string[], dx: number, dy: number) {
    for (const id of ids) {
      const d = this.device(id);
      if (!d) continue;
      d.x += dx;
      d.y += dy;
    }
    this.markDirty();
    this.bump();
  }

  /** Ports on a device that the current cable can use. */
  usablePorts(d: Device): Port[] {
    return d.ports.filter((p) => !p.link && (this.cable === "auto" || cableFitsPort(this.cable, p)));
  }

  /** Connects two devices. Returns an error string on failure. */
  connect(a: Port, b: Port): string | null {
    if (a.device === b.device) return "A device cannot be connected to itself.";
    let cable: CableType | null = this.cable === "auto" ? autoCable(a, b) : this.cable;
    if (!cable) return `${a.short} and ${b.short} use different media. Pick other ports.`;
    if (!cableFitsPort(cable, a) || !cableFitsPort(cable, b)) return "That cable does not fit these ports.";
    this.checkpoint();
    // Console cables run from a host's serial/RS-232 side; model them on the console port.
    this.net.connect(a, b, cable);
    this.markDirty();
    if (!cableWorks(cable, a, b)) this.toast("Connected, but this cable type will not bring the link up. Try the other copper cable.", "error");
    return null;
  }

  autoPortPair(a: Device, b: Device): [Port, Port] | null {
    const pa = this.usablePorts(a).filter((p) => p.media !== "console");
    const pb = this.usablePorts(b).filter((p) => p.media !== "console");
    // Prefer matching media, fastest first.
    for (const media of ["copper", "fiber", "serial"] as const) {
      const x = pa.filter((p) => p.media === media);
      const y = pb.filter((p) => p.media === media);
      if (x.length && y.length) return [x[0], y[0]];
    }
    return null;
  }

  // ---------------------------------------------------------------- undo

  snapshot(): ProjectFile {
    return serializeProject(this.net, { name: this.name, description: this.description, created: this.created, notes: $state.snapshot(this.notes) as NoteRecord[], view: { ...this.view } });
  }

  checkpoint() {
    this.undoStack.push(JSON.stringify(this.snapshot()));
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo() {
    void this.tick;
    return this.undoStack.length > 0;
  }

  get canRedo() {
    void this.tick;
    return this.redoStack.length > 0;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.snapshot()));
    this.restore(JSON.parse(s), true);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.snapshot()));
    this.restore(JSON.parse(s), true);
  }

  // ---------------------------------------------------------- project I/O

  /** Replaces the current network with the project's contents. */
  restore(data: unknown, keepIdentity = false) {
    const { net, project } = loadProject(data);
    this.net = net;
    this.attach(net);
    this.name = project.name;
    this.description = project.description ?? "";
    this.created = project.created;
    this.notes = project.notes;
    if (project.view) this.view = project.view;
    if (!keepIdentity) {
      this.projectId = crypto.randomUUID();
      this.undoStack = [];
      this.redoStack = [];
      this.filePath = null;
      this.windows = [];
      this.events = [];
      this.pdus = [];
    }
    for (const d of net.devices.values()) if (d instanceof Switch && prefs.fastStp) d.forwardDelay = 1500;
    this.clis.clear();
    this.prompts.clear();
    this.selection = new Set();
    this.selectedLink = null;
    this.markDirty();
    this.bump();
  }

  newProject() {
    this.restore({ format: "openpacketlab", version: 1, name: "Untitled Lab", created: new Date().toISOString(), modified: new Date().toISOString(), devices: [], links: [], notes: [] });
    this.view = { x: 0, y: 0, zoom: 1 };
    this.dirty = false;
  }

  async backupNow(label?: string) {
    await backups.save(this.projectId, this.name, JSON.stringify(this.snapshot()), label);
  }

  toast(text: string, kind: Toast["kind"] = "info") {
    const t = { id: this.toastSeq++, text, kind };
    this.toasts = [...this.toasts, t];
    setTimeout(() => (this.toasts = this.toasts.filter((x) => x.id !== t.id)), kind === "error" ? 6000 : 3500);
  }

  // ------------------------------------------------------------ windows

  openWindow(id: string, tab?: string) {
    const existing = this.windows.find((w) => w.id === id);
    if (existing) {
      existing.z = ++this.zCounter;
      if (tab) existing.tab = tab;
      this.windows = [...this.windows];
      return;
    }
    const d = this.device(id);
    if (!d) return;
    const defTab = tab ?? (d instanceof IosDevice ? "cli" : d instanceof Host ? "desktop" : "config");
    const n = this.windows.length;
    this.windows = [...this.windows, { id, tab: defTab, x: 120 + n * 28, y: 90 + n * 28, z: ++this.zCounter }];
  }

  focusWindow(id: string) {
    const w = this.windows.find((x) => x.id === id);
    if (w) {
      w.z = ++this.zCounter;
      this.windows = [...this.windows];
    }
  }

  closeWindow(id: string) {
    this.windows = this.windows.filter((w) => w.id !== id);
  }

  cliFor(d: IosDevice): CliSession {
    let s = this.clis.get(d.id);
    if (!s) {
      s = new CliSession(d);
      s.open();
      this.clis.set(d.id, s);
    }
    return s;
  }

  promptFor(h: Host): HostPrompt {
    let p = this.prompts.get(h.id);
    if (!p) {
      p = new HostPrompt(h);
      p.open();
      this.prompts.set(h.id, p);
    }
    return p;
  }
}

export function stackOf(d: Device) {
  if (d instanceof Host) return d.stack;
  if (d instanceof Router || d instanceof Switch) return d.stack;
  return undefined;
}

export function primaryIp(d: Device): string | undefined {
  if (d instanceof Host) return d.active.ip || undefined;
  if (d instanceof Router || d instanceof Switch) {
    const ifs = d.stack.interfaces().filter((i) => i.ip && i.isUp());
    return (ifs.find((i) => !/^Loopback/i.test(i.name)) ?? ifs[0])?.ip;
  }
  return undefined;
}

export const app = new AppState();
export { LIBRARY, ALL_PROTOCOLS };
