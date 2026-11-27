// End devices: desktop PCs, laptops, servers, printers, tablets, phones, IoT.

import { generateMac, isValidIp, isValidMask, type MAC } from "../addr";
import { IpStack, type L3If } from "../ipstack";
import { Device, Port, type DeviceConfig, type DeviceKind } from "../network";
import type { EthernetFrame } from "../packets";
import {
  DhcpClient,
  DhcpServer,
  DnsResolver,
  httpResponse,
  parseHttpRequest,
  serveDns,
  type DhcpPool,
  type DnsRecord,
} from "../services";

export interface HostIpConfig {
  mode: "static" | "dhcp";
  ip: string;
  mask: string;
  gateway: string;
  dns: string;
}

export interface ServerPool {
  name: string;
  defaultRouter: string;
  dns: string;
  start: string;
  mask: string;
  max: number;
}

export interface HostServices {
  http: { enabled: boolean; https: boolean; files: Record<string, string> };
  dns: { enabled: boolean; records: DnsRecord[] };
  dhcp: { enabled: boolean; pools: ServerPool[] };
  syslog: { enabled: boolean; entries: { time: number; from: string; text: string }[] };
}

export const DEFAULT_INDEX = `<html>
<head><title>OpenPacketLab</title></head>
<body>
<h1>It works!</h1>
<p>This page is served by a simulated web server in OpenPacketLab.</p>
<p>Edit it in the server's Services tab.</p>
</body>
</html>`;

export function defaultServices(): HostServices {
  return {
    http: { enabled: true, https: true, files: { "index.html": DEFAULT_INDEX } },
    dns: { enabled: false, records: [] },
    dhcp: { enabled: false, pools: [{ name: "serverPool", defaultRouter: "0.0.0.0", dns: "0.0.0.0", start: "192.168.1.100", mask: "255.255.255.0", max: 50 }] },
    syslog: { enabled: false, entries: [] },
  };
}

const MODELS: Record<string, { model: string; wireless?: boolean }> = {
  pc: { model: "Desktop PC" },
  laptop: { model: "Laptop" },
  server: { model: "Rack Server" },
  printer: { model: "Network Printer" },
  tablet: { model: "Tablet", wireless: true },
  phone: { model: "Smartphone", wireless: true },
  iot: { model: "IoT Sensor" },
};

export class Host extends Device {
  readonly kind: DeviceKind;
  readonly model: string;
  override readonly isHost = true;
  nic: Port;
  ipConfig: HostIpConfig = { mode: "static", ip: "", mask: "", gateway: "", dns: "" };
  /** Address currently in use (may come from DHCP). */
  active: { ip: string; mask: string; gateway: string; dns: string } = { ip: "", mask: "", gateway: "", dns: "" };
  stack: IpStack;
  dhcp: DhcpClient;
  resolver: DnsResolver;
  services?: HostServices;
  dhcpServer?: DhcpServer;
  iface: L3If;
  dhcpStatus = "";
  /** Saved output of the command prompt so it survives closing the window. */
  promptHistory: string[] = [];

  constructor(id: string, kind: DeviceKind, hostname: string) {
    super(id, hostname);
    this.kind = kind;
    this.model = MODELS[kind]?.model ?? "Host";
    this.nic = new Port(this, "FastEthernet0", "Fa0", "copper", 100, generateMac());
    this.ports = [this.nic];
    const self = this;
    this.iface = {
      name: "FastEthernet0",
      get ip() {
        return self.active.ip || undefined;
      },
      get mask() {
        return self.active.mask || undefined;
      },
      get mac(): MAC {
        return self.nic.mac;
      },
      isUp: () => this.nic.isUp,
      output: (f) => this.send(this.nic, f),
    };
    this.stack = new IpStack(this, false, () => [this.iface]);
    this.dhcp = new DhcpClient(this.stack, () => this.iface, () => this.nic.mac);
    this.dhcp.onBound = (l) => {
      this.active = { ip: l.ip, mask: l.mask, gateway: l.router ?? "", dns: l.dns ?? "" };
      this.applyActive();
      this.dhcpStatus = "DHCP request successful.";
    };
    this.dhcp.onFail = () => {
      // Automatic private addressing, as desktop operating systems do.
      const r = Math.floor(Math.random() * 65000) + 256;
      this.active = { ip: `169.254.${(r >> 8) & 255}.${r & 255}`, mask: "255.255.0.0", gateway: "", dns: "" };
      this.applyActive();
      this.dhcpStatus = "DHCP failed. APIPA is being used.";
    };
    this.resolver = new DnsResolver(this.stack);
    this.stack.udp.set(68, (_pkt, udp) => {
      if (udp.data.kind === "dhcp") this.dhcp.handle(udp.data);
    });
    if (kind === "server") this.enableServices(defaultServices());
  }

  enableServices(s: HostServices) {
    this.services = s;
    this.dhcpServer = new DhcpServer(this.stack);
    this.syncServices();
    serveDns(this.stack, () => (this.services?.dns.enabled ? this.services.dns.records : []));
    this.stack.udp.set(67, (pkt, udp) => {
      if (!this.services?.dhcp.enabled || udp.data.kind !== "dhcp") return;
      this.dhcpServer!.handle(this.iface, pkt, udp.data);
    });
    this.stack.udp.set(514, (pkt, udp) => {
      if (!this.services?.syslog.enabled || udp.data.kind !== "syslog") return;
      this.services.syslog.entries.push({ time: this.net?.time ?? 0, from: pkt.src, text: udp.data.text });
      if (this.services.syslog.entries.length > 1000) this.services.syslog.entries.shift();
    });
    const http = (secure: boolean) => (data: string, _ctx: unknown, reply: (r: string | null) => void) => {
      const s = this.services?.http;
      if (!s?.enabled || (secure && !s.https)) return reply(null);
      const req = parseHttpRequest(data);
      let path = req.path.replace(/^\/+/, "") || "index.html";
      if (!(path in s.files) && path + ".html" in s.files) path += ".html";
      const body = s.files[path];
      reply(body !== undefined ? httpResponse(200, body) : httpResponse(404, "<html><body><h1>404 Not Found</h1></body></html>"));
    };
    this.stack.tcp.set(80, http(false));
    this.stack.tcp.set(443, http(true));
  }

  /** Re-reads server pool settings into the DHCP engine. */
  syncServices() {
    if (!this.services || !this.dhcpServer) return;
    this.dhcpServer.enabled = this.services.dhcp.enabled;
    this.dhcpServer.pools = this.services.dhcp.pools
      .filter((p) => isValidIp(p.start) && isValidMask(p.mask))
      .map(
        (p): DhcpPool => ({
          name: p.name,
          network: p.start,
          mask: p.mask,
          start: p.start,
          max: p.max,
          defaultRouter: isValidIp(p.defaultRouter) && p.defaultRouter !== "0.0.0.0" ? p.defaultRouter : undefined,
          dns: isValidIp(p.dns) && p.dns !== "0.0.0.0" ? p.dns : undefined,
        }),
      );
  }

  override get label() {
    return this.hostname;
  }

  override receive(port: Port, frame: EthernetFrame) {
    if (port !== this.nic) return;
    this.stack.receive(this.iface, frame);
  }

  override start() {
    this.applyConfig();
  }

  override stop() {
    this.stack.reset();
    this.dhcp.stop();
  }

  private lastUp = false;
  override onLinkChange(_p: Port) {
    const up = this.nic.isUp;
    if (up && !this.lastUp && this.ipConfig.mode === "dhcp" && this.dhcp.state !== "bound") this.dhcp.start();
    if (up && !this.lastUp && this.active.ip) this.schedule(10, () => this.stack.gratuitousArp(this.iface));
    this.lastUp = up;
  }

  private applyActive() {
    this.stack.defaultGateway = isValidIp(this.active.gateway) ? this.active.gateway : undefined;
    this.stack.clearArp();
  }

  /** Applies ipConfig (call after editing it). */
  applyConfig() {
    const c = this.ipConfig;
    if (c.mode === "dhcp") {
      this.active = { ip: "", mask: "", gateway: "", dns: "" };
      this.applyActive();
      this.dhcpStatus = "Requesting IP address...";
      if (this.nic.isUp && this.powered && this.net) this.dhcp.start();
    } else {
      this.dhcp.stop();
      this.dhcpStatus = "";
      this.active = {
        ip: isValidIp(c.ip) ? c.ip : "",
        mask: isValidMask(c.mask) ? c.mask : "",
        gateway: isValidIp(c.gateway) ? c.gateway : "",
        dns: isValidIp(c.dns) ? c.dns : "",
      };
      this.applyActive();
    }
    this.lastUp = this.nic.isUp;
  }

  renew() {
    if (this.ipConfig.mode !== "dhcp") return;
    this.dhcpStatus = "Requesting IP address...";
    this.dhcp.start();
  }

  release() {
    this.dhcp.release();
    this.active = { ip: "", mask: "", gateway: "", dns: "" };
    this.applyActive();
  }

  override serialize(): DeviceConfig {
    return {
      hostname: this.hostname,
      mac: this.nic.mac,
      ip: { ...this.ipConfig },
      services: this.services ? JSON.parse(JSON.stringify({ ...this.services, syslog: { ...this.services.syslog, entries: [] } })) : undefined,
      portUp: this.nic.adminUp,
    };
  }

  override load(cfg: DeviceConfig) {
    if (typeof cfg.hostname === "string") this.hostname = cfg.hostname;
    if (typeof cfg.mac === "string") this.nic.mac = cfg.mac;
    if (cfg.ip) this.ipConfig = { ...this.ipConfig, ...(cfg.ip as HostIpConfig) };
    if (cfg.services) {
      const base = defaultServices();
      const s = cfg.services as Partial<HostServices>;
      this.enableServices({ ...base, ...s, syslog: { ...base.syslog, ...(s.syslog ?? {}) } });
    }
    if (typeof cfg.portUp === "boolean") this.nic.adminUp = cfg.portUp;
    if (this.net) this.applyConfig();
  }
}
