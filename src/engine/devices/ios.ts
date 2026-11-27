// Shared base for devices managed through the IOS-style CLI (switches,
// routers, multilayer switches): common settings, LLDP, startup config.

import { BROADCAST_MAC } from "../addr";
import { Device, type DeviceConfig, type Port } from "../network";
import { nextUid, type EthernetFrame, type LldpPdu } from "../packets";

export const LLDP_MAC = "01:80:c2:00:00:0e";
export const STP_MAC = "01:80:c2:00:00:00";

export interface IosCommon {
  enableSecret?: string;
  enablePassword?: string;
  consolePassword?: string;
  consoleLogin: boolean;
  vtyPassword?: string;
  vtyLogin: "none" | "password" | "local";
  vtyTransport: "telnet" | "ssh" | "all" | "none";
  banner?: string;
  domainName?: string;
  users: { name: string; secret: string; privilege: number }[];
  passwordEncryption: boolean;
  sshKeyBits: number; // 0 = no key generated
  domainLookup: boolean;
  lldp: boolean;
  cdp: boolean;
  logging: { host?: string; synchronous: boolean };
  execTimeout: number;
  clockOffsetMs: number;
  /** Lines of unparsed but accepted configuration so nothing typed is lost. */
  extra: string[];
}

export function defaultIos(): IosCommon {
  return {
    consoleLogin: false,
    vtyLogin: "none",
    vtyTransport: "all",
    users: [],
    passwordEncryption: false,
    sshKeyBits: 0,
    domainLookup: true,
    lldp: true,
    cdp: true,
    logging: { synchronous: false },
    execTimeout: 10,
    clockOffsetMs: 0,
    extra: [],
  };
}

export interface LldpNeighbor {
  device: string;
  localPort: string;
  remotePort: string;
  model: string;
  capabilities: string;
  ip?: string;
  time: number;
}

export abstract class IosDevice extends Device {
  ios: IosCommon = defaultIos();
  startup?: DeviceConfig;
  neighbors = new Map<string, LldpNeighbor>();
  bootTime = 0;
  abstract readonly capabilities: string;
  /** Messages for the CLI (link up/down etc.). */
  lastLinkState = new Map<string, boolean>();

  override start() {
    this.bootTime = this.net?.time ?? 0;
    this.every(30000, () => this.sendLldp(), 500);
  }

  override stop() {
    this.neighbors.clear();
  }

  mgmtIp(): string | undefined {
    return undefined;
  }

  sendLldp() {
    if (!this.ios.lldp && !this.ios.cdp) return;
    for (const p of this.ports) {
      if (!p.isUp || p.media === "console") continue;
      const pdu: LldpPdu = {
        kind: "lldp",
        systemName: this.hostname,
        portId: p.name,
        model: this.model,
        capabilities: this.capabilities,
        mgmtIp: this.mgmtIp(),
      };
      this.send(p, { uid: nextUid(), src: p.mac, dst: LLDP_MAC, type: "lldp", payload: pdu });
    }
    const now = this.net?.time ?? 0;
    for (const [k, n] of this.neighbors) if (now - n.time > 120000) this.neighbors.delete(k);
  }

  handleLldp(port: Port, frame: EthernetFrame): boolean {
    if (frame.type !== "lldp" || frame.payload.kind !== "lldp") return false;
    const p = frame.payload;
    this.neighbors.set(port.name, {
      device: p.systemName,
      localPort: port.name,
      remotePort: p.portId,
      model: p.model,
      capabilities: p.capabilities,
      ip: p.mgmtIp,
      time: this.net?.time ?? 0,
    });
    return true;
  }

  /** Logs IOS-style link change messages. */
  override onLinkChange(port: Port) {
    const up = port.isUp;
    const prev = this.lastLinkState.get(port.name);
    if (prev === up) return;
    this.lastLinkState.set(port.name, up);
    if (prev === undefined && !up) return;
    this.log(`%LINK-5-CHANGED: Interface ${port.name}, changed state to ${up ? "up" : port.adminUp ? "down" : "administratively down"}`);
    this.schedule(up ? 1000 : 1, () => {
      this.log(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${port.name}, changed state to ${up ? "up" : "down"}`);
    });
    if (!up) this.neighbors.delete(port.name);
    else this.schedule(1500, () => this.sendLldp());
  }

  abstract serializeRunning(): DeviceConfig;
  abstract loadRunning(cfg: DeviceConfig): void;
  /** Restores factory defaults (without startup config). */
  abstract factoryReset(): void;

  override serialize(): DeviceConfig {
    return { running: this.serializeRunning(), startup: this.startup ? structuredClone(this.startup) : undefined };
  }

  override load(cfg: DeviceConfig) {
    if (cfg.running) this.loadRunning(cfg.running as DeviceConfig);
    this.startup = cfg.startup ? structuredClone(cfg.startup as DeviceConfig) : undefined;
  }

  saveStartup() {
    this.startup = structuredClone(this.serializeRunning());
  }

  eraseStartup() {
    this.startup = undefined;
  }

  reload() {
    this.stop();
    this.net?.clearOwner(this.id);
    this.factoryReset();
    if (this.startup) this.loadRunning(structuredClone(this.startup));
    this.lastLinkState.clear();
    this.start();
    for (const p of this.ports) if (p.link) this.net?.linkChanged(p.link);
  }

  /** Sends a syslog message to the configured logging host. */
  syslog(_text: string) {}
}

export function isBroadcastOrMulticast(mac: string) {
  return mac === BROADCAST_MAC || (parseInt(mac.slice(0, 2), 16) & 1) === 1;
}
