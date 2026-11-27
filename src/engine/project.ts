// Project file format (.opl, JSON) and the device factory.

import { Device, Network, type CableType, type DeviceKind } from "./network";
import { Host } from "./devices/host";
import { Hub, Switch } from "./devices/switch";
import { Router, type RouterModel } from "./devices/router";

export const FORMAT = "openpacketlab";
export const FORMAT_VERSION = 1;

export interface DeviceRecord {
  id: string;
  kind: DeviceKind;
  variant?: string;
  x: number;
  y: number;
  powered: boolean;
  config: Record<string, unknown>;
}

export interface LinkRecord {
  id: string;
  a: { device: string; port: string };
  b: { device: string; port: string };
  cable: CableType;
}

export interface NoteRecord {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  w?: number;
  h?: number;
  shape?: "note" | "area";
}

export interface ProjectFile {
  format: typeof FORMAT;
  version: number;
  name: string;
  description?: string;
  created: string;
  modified: string;
  devices: DeviceRecord[];
  links: LinkRecord[];
  notes: NoteRecord[];
  view?: { x: number; y: number; zoom: number };
}

export interface DeviceTemplate {
  kind: DeviceKind;
  variant?: string;
  label: string;
  category: "End Devices" | "Switches" | "Routers" | "Hubs" | "Wireless" | "Security" | "WAN";
  prefix: string;
  description: string;
}

export const LIBRARY: DeviceTemplate[] = [
  { kind: "router", variant: "router", label: "Router R3G", category: "Routers", prefix: "R", description: "3 × Gigabit Ethernet, 2 × Serial. Static, RIP, OSPF, EIGRP, NAT, ACL, DHCP." },
  { kind: "router", variant: "isr", label: "Branch Router 4G", category: "Routers", prefix: "R", description: "4 × Gigabit Ethernet, 2 × Serial." },
  { kind: "switch", label: "Access Switch 24", category: "Switches", prefix: "SW", description: "24 × Fast Ethernet, 2 × Gigabit. VLANs, trunks, STP, port security." },
  { kind: "l3switch", label: "Multilayer Switch 24G", category: "Switches", prefix: "MLS", description: "24 × Gigabit, 4 × SFP. SVIs, routed ports, inter-VLAN routing." },
  { kind: "hub", label: "Hub 8", category: "Hubs", prefix: "Hub", description: "8-port repeater. Every frame goes out every port." },
  { kind: "pc", label: "Desktop PC", category: "End Devices", prefix: "PC", description: "Command prompt, IP configuration, web browser, terminal." },
  { kind: "laptop", label: "Laptop", category: "End Devices", prefix: "Laptop", description: "Portable end device." },
  { kind: "server", label: "Server", category: "End Devices", prefix: "Server", description: "HTTP, HTTPS, DNS, DHCP and Syslog services." },
  { kind: "printer", label: "Printer", category: "End Devices", prefix: "Printer", description: "Network printer." },
  { kind: "tablet", label: "Tablet", category: "End Devices", prefix: "Tablet", description: "Tablet end device." },
  { kind: "phone", label: "Smartphone", category: "End Devices", prefix: "Phone", description: "Smartphone end device." },
  { kind: "iot", label: "IoT Sensor", category: "End Devices", prefix: "IoT", description: "Small connected sensor." },
];

export function createDevice(kind: DeviceKind, id: string, hostname: string, variant?: string): Device {
  switch (kind) {
    case "router":
      return new Router(id, hostname, (variant as RouterModel) ?? "router");
    case "switch":
      return new Switch(id, hostname, false);
    case "l3switch":
      return new Switch(id, hostname, true);
    case "hub":
      return new Hub(id, hostname);
    default:
      return new Host(id, kind, hostname);
  }
}

export function variantOf(d: Device): string | undefined {
  return d instanceof Router ? d.variant : undefined;
}

export function serializeProject(net: Network, meta: { name: string; description?: string; created?: string; notes?: NoteRecord[]; view?: ProjectFile["view"] }): ProjectFile {
  const now = new Date().toISOString();
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: meta.name,
    description: meta.description,
    created: meta.created ?? now,
    modified: now,
    devices: [...net.devices.values()].map((d) => ({
      id: d.id,
      kind: d.kind,
      variant: variantOf(d),
      x: Math.round(d.x),
      y: Math.round(d.y),
      powered: d.powered,
      config: d.serialize(),
    })),
    links: [...net.links.values()].map((l) => ({
      id: l.id,
      a: { device: l.a.device.id, port: l.a.name },
      b: { device: l.b.device.id, port: l.b.name },
      cable: l.cable,
    })),
    notes: meta.notes ?? [],
    view: meta.view,
  };
}

export function validateProject(data: unknown): ProjectFile {
  const p = data as ProjectFile;
  if (!p || typeof p !== "object" || p.format !== FORMAT) throw new Error("This file is not an OpenPacketLab project.");
  if (typeof p.version !== "number" || p.version > FORMAT_VERSION)
    throw new Error("This project was saved by a newer version of OpenPacketLab. Please update the app.");
  if (!Array.isArray(p.devices) || !Array.isArray(p.links)) throw new Error("The project file is damaged.");
  p.notes ??= [];
  return p;
}

/** Builds a fresh network from a project file. */
export function loadProject(data: unknown): { net: Network; project: ProjectFile } {
  const project = validateProject(data);
  const net = new Network();
  for (const r of project.devices) {
    const d = createDevice(r.kind, r.id, String((r.config as { hostname?: string }).hostname ?? r.id), r.variant);
    d.x = r.x;
    d.y = r.y;
    d.load(r.config);
    d.powered = r.powered !== false;
    net.add(d);
  }
  for (const l of project.links) {
    const a = net.devices.get(l.a.device)?.port(l.a.port);
    const b = net.devices.get(l.b.device)?.port(l.b.port);
    if (a && b && !a.link && !b.link) net.connect(a, b, l.cable, l.id);
  }
  return { net, project };
}
