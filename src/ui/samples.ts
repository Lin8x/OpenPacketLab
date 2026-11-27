// Built-in sample labs, generated with the engine so they always match the
// current file format.

import { Network, autoCable, type Device } from "../engine/network";
import { createDevice, serializeProject, type ProjectFile, type NoteRecord } from "../engine/project";
import { Host } from "../engine/devices/host";
import { Router } from "../engine/devices/router";
import { Switch } from "../engine/devices/switch";
import { defaultOspf } from "../engine/devices/routing";

export interface Sample {
  id: string;
  title: string;
  summary: string;
  level: "Beginner" | "Intermediate" | "Advanced";
  build: () => ProjectFile;
}

class B {
  net = new Network();
  notes: NoteRecord[] = [];
  n = 0;
  add<T extends Device>(kind: Parameters<typeof createDevice>[0], name: string, x: number, y: number, variant?: string): T {
    const d = createDevice(kind, `s${++this.n}`, name, variant);
    if (d instanceof Router || d instanceof Switch) d.cfg.hostname = name;
    d.x = x;
    d.y = y;
    this.net.add(d);
    return d as T;
  }
  pc(name: string, x: number, y: number, ip?: string, gw = "", kind: "pc" | "laptop" | "server" = "pc") {
    const h = this.add<Host>(kind, name, x, y);
    if (ip) {
      h.ipConfig = { mode: "static", ip, mask: "255.255.255.0", gateway: gw, dns: "" };
      h.applyConfig();
    } else {
      h.ipConfig.mode = "dhcp";
    }
    return h;
  }
  link(a: Device, ap: string, b: Device, bp: string) {
    const pa = a.port(ap)!;
    const pb = b.port(bp)!;
    this.net.connect(pa, pb, autoCable(pa, pb)!);
  }
  note(x: number, y: number, text: string, color = "yellow") {
    this.notes.push({ id: `n${this.notes.length}`, x, y, text, color });
  }
  done(name: string, description: string): ProjectFile {
    return serializeProject(this.net, { name, description, notes: this.notes, view: { x: 120, y: 60, zoom: 1 } });
  }
}

function rif(r: Router, name: string, ip: string, mask = "255.255.255.0") {
  const c = r.ifCfg(name);
  c.ip = ip;
  c.mask = mask;
  c.shutdown = false;
  r.applyConfig();
}

export const SAMPLES: Sample[] = [
  {
    id: "first",
    title: "Your first network",
    summary: "Two PCs and a switch. Open a PC, go to Command Prompt and ping the other one.",
    level: "Beginner",
    build: () => {
      const b = new B();
      const sw = b.add<Switch>("switch", "SW1", 400, 160);
      const a = b.pc("PC1", 220, 340, "192.168.1.10");
      const c = b.pc("PC2", 580, 340, "192.168.1.11");
      b.link(a, "Fa0", sw, "Fa0/1");
      b.link(c, "Fa0", sw, "Fa0/2");
      b.note(160, 440, "Try: open PC1 → Desktop → Command Prompt → ping 192.168.1.11. Then switch to Simulation mode and watch ARP and ICMP step by step.");
      return b.done("Your first network", "Two hosts on one switch.");
    },
  },
  {
    id: "two-lans",
    title: "Routing between two LANs",
    summary: "A router joins two subnets. Configure it from the CLI or explore the ready-made setup.",
    level: "Beginner",
    build: () => {
      const b = new B();
      const r = b.add<Router>("router", "R1", 420, 100);
      const s1 = b.add<Switch>("switch", "SW1", 220, 240);
      const s2 = b.add<Switch>("switch", "SW2", 620, 240);
      const a = b.pc("PC1", 140, 400, "192.168.10.10", "192.168.10.1");
      const a2 = b.pc("PC2", 300, 400, "192.168.10.11", "192.168.10.1");
      const c = b.pc("PC3", 540, 400, "192.168.20.10", "192.168.20.1");
      const c2 = b.pc("PC4", 700, 400, "192.168.20.11", "192.168.20.1", "laptop");
      b.link(r, "Gi0/0", s1, "Gi0/1");
      b.link(r, "Gi0/1", s2, "Gi0/1");
      b.link(a, "Fa0", s1, "Fa0/1");
      b.link(a2, "Fa0", s1, "Fa0/2");
      b.link(c, "Fa0", s2, "Fa0/1");
      b.link(c2, "Fa0", s2, "Fa0/2");
      rif(r, "GigabitEthernet0/0", "192.168.10.1");
      rif(r, "GigabitEthernet0/1", "192.168.20.1");
      r.saveStartup();
      b.note(560, 20, "R1 routes between 192.168.10.0/24 and 192.168.20.0/24. Try 'show ip route' and 'show ip interface brief' in its CLI.");
      return b.done("Routing between two LANs", "Inter-network routing with one router.");
    },
  },
  {
    id: "vlans",
    title: "VLANs and router-on-a-stick",
    summary: "Two VLANs on one switch, routed through 802.1Q subinterfaces.",
    level: "Intermediate",
    build: () => {
      const b = new B();
      const r = b.add<Router>("router", "R1", 420, 80);
      const sw = b.add<Switch>("switch", "SW1", 420, 230);
      sw.cfg.vlans[10] = "STAFF";
      sw.cfg.vlans[20] = "GUEST";
      for (const [p, v] of [["FastEthernet0/1", 10], ["FastEthernet0/2", 10], ["FastEthernet0/3", 20], ["FastEthernet0/4", 20]] as const) {
        sw.cfg.ports[p].mode = "access";
        sw.cfg.ports[p].accessVlan = v;
      }
      sw.cfg.ports["GigabitEthernet0/1"].mode = "trunk";
      sw.applyConfig();
      sw.saveStartup();
      const hosts = [b.pc("Staff1", 180, 400, "10.10.0.11", "10.10.0.1"), b.pc("Staff2", 340, 400, "10.10.0.12", "10.10.0.1"), b.pc("Guest1", 500, 400, "10.20.0.11", "10.20.0.1", "laptop"), b.pc("Guest2", 660, 400, "10.20.0.12", "10.20.0.1", "laptop")];
      hosts.forEach((h, i) => b.link(h, "Fa0", sw, `Fa0/${i + 1}`));
      b.link(sw, "Gi0/1", r, "Gi0/0");
      r.ifCfg("GigabitEthernet0/0").shutdown = false;
      for (const v of [10, 20]) {
        const c = r.ifCfg(`GigabitEthernet0/0.${v}`);
        c.dot1q = v;
        c.ip = `10.${v}.0.1`;
        c.mask = "255.255.255.0";
        c.shutdown = false;
      }
      r.applyConfig();
      r.saveStartup();
      b.note(600, 60, "VLAN 10 = STAFF, VLAN 20 = GUEST. The trunk on Gi0/1 carries both. Try 'show interfaces trunk' on SW1.");
      return b.done("VLANs and router-on-a-stick", "802.1Q trunking and inter-VLAN routing.");
    },
  },
  {
    id: "services",
    title: "DHCP, DNS and a web server",
    summary: "Clients get addresses from a server, resolve a name and load a web page.",
    level: "Intermediate",
    build: () => {
      const b = new B();
      const sw = b.add<Switch>("switch", "SW1", 420, 200);
      const srv = b.pc("Server1", 420, 60, "172.16.0.10", "172.16.0.1", "server");
      srv.services!.dhcp.enabled = true;
      srv.services!.dhcp.pools = [{ name: "LAN", defaultRouter: "172.16.0.1", dns: "172.16.0.10", start: "172.16.0.100", mask: "255.255.255.0", max: 100 }];
      srv.services!.dns.enabled = true;
      srv.services!.dns.records = [
        { name: "intranet.lab", type: "A", value: "172.16.0.10" },
        { name: "www.intranet.lab", type: "CNAME", value: "intranet.lab" },
      ];
      srv.services!.http.files["index.html"] = `<html><head><title>Intranet</title></head><body><h1>Welcome to the intranet</h1><p>You reached this page by name, through DNS, after getting your address from DHCP.</p><p><a href="about.html">About this lab</a></p></body></html>`;
      srv.services!.http.files["about.html"] = `<html><body><h1>About</h1><p>Served by Server1 at 172.16.0.10.</p><p><a href="index.html">Back</a></p></body></html>`;
      srv.syncServices();
      b.link(srv, "Fa0", sw, "Fa0/24");
      for (let i = 0; i < 3; i++) {
        const h = b.pc(`PC${i + 1}`, 220 + i * 200, 360, undefined, "", i === 2 ? "laptop" : "pc");
        b.link(h, "Fa0", sw, `Fa0/${i + 1}`);
      }
      b.note(620, 40, "The PCs use DHCP. Open a PC → Web Browser → intranet.lab");
      return b.done("DHCP, DNS and a web server", "Application services on a LAN.");
    },
  },
  {
    id: "ospf",
    title: "OSPF across three routers",
    summary: "Three routers in a triangle exchange routes with OSPF area 0.",
    level: "Advanced",
    build: () => {
      const b = new B();
      const r1 = b.add<Router>("router", "R1", 240, 120);
      const r2 = b.add<Router>("router", "R2", 600, 120);
      const r3 = b.add<Router>("router", "R3", 420, 320);
      b.link(r1, "Gi0/1", r2, "Gi0/1");
      b.link(r2, "Gi0/2", r3, "Gi0/2");
      b.link(r3, "Gi0/1", r1, "Gi0/2");
      rif(r1, "GigabitEthernet0/1", "10.0.12.1", "255.255.255.252");
      rif(r2, "GigabitEthernet0/1", "10.0.12.2", "255.255.255.252");
      rif(r2, "GigabitEthernet0/2", "10.0.23.1", "255.255.255.252");
      rif(r3, "GigabitEthernet0/2", "10.0.23.2", "255.255.255.252");
      rif(r3, "GigabitEthernet0/1", "10.0.13.2", "255.255.255.252");
      rif(r1, "GigabitEthernet0/2", "10.0.13.1", "255.255.255.252");
      const lans: [Router, string, number, number][] = [
        [r1, "192.168.1", 100, 40],
        [r2, "192.168.2", 740, 40],
        [r3, "192.168.3", 420, 460],
      ];
      for (const [r, net, x, y] of lans) {
        rif(r, "GigabitEthernet0/0", `${net}.1`);
        const h = b.pc(`PC-${r.hostname}`, x, y, `${net}.10`, `${net}.1`);
        b.link(h, "Fa0", r, "Gi0/0");
        const c = defaultOspf(1);
        c.networks = [
          { network: "10.0.0.0", wildcard: "0.0.255.255", area: 0 },
          { network: `${net}.0`, wildcard: "0.0.0.255", area: 0 },
        ];
        c.passive = ["GigabitEthernet0/0"];
        r.cfg.routing.ospf = c;
        r.applyConfig();
        r.saveStartup();
      }
      b.note(640, 300, "Give OSPF about 20 seconds to converge, then try 'show ip ospf neighbor' and 'show ip route ospf'. Shut a link and watch it reroute.");
      return b.done("OSPF across three routers", "Link-state routing with redundancy.");
    },
  },
  {
    id: "nat",
    title: "Internet edge with NAT",
    summary: "A small office reaches an outside server through PAT on the edge router.",
    level: "Advanced",
    build: () => {
      const b = new B();
      const r = b.add<Router>("router", "Edge", 420, 160);
      const sw = b.add<Switch>("switch", "SW1", 220, 280);
      const isp = b.pc("WebServer", 640, 300, "203.0.113.10", "203.0.113.1", "server");
      b.link(r, "Gi0/0", sw, "Gi0/1");
      b.link(r, "Gi0/1", isp, "Fa0");
      for (let i = 0; i < 2; i++) b.link(b.pc(`PC${i + 1}`, 120 + i * 200, 420, `192.168.1.${10 + i}`, "192.168.1.1"), "Fa0", sw, `Fa0/${i + 1}`);
      rif(r, "GigabitEthernet0/0", "192.168.1.1");
      rif(r, "GigabitEthernet0/1", "203.0.113.1");
      r.ifCfg("GigabitEthernet0/0").nat = "inside";
      r.ifCfg("GigabitEthernet0/1").nat = "outside";
      r.cfg.acls["1"] = { type: "standard", entries: [{ seq: 10, action: "permit", protocol: "ip", src: { addr: "192.168.1.0", wc: "0.0.0.255" } }] };
      r.cfg.nat.rules.push({ acl: "1", iface: "GigabitEthernet0/1", overload: true });
      r.applyConfig();
      r.saveStartup();
      b.note(560, 40, "Browse to 203.0.113.10 from a PC, then run 'show ip nat translations' on Edge.");
      return b.done("Internet edge with NAT", "Port address translation at the network edge.");
    },
  },
  {
    id: "stp",
    title: "Spanning tree loop",
    summary: "Three switches in a loop. Watch spanning tree block one port.",
    level: "Intermediate",
    build: () => {
      const b = new B();
      const s1 = b.add<Switch>("switch", "SW1", 420, 80);
      const s2 = b.add<Switch>("switch", "SW2", 240, 280);
      const s3 = b.add<Switch>("switch", "SW3", 600, 280);
      s1.cfg.stp.priority = 4096;
      s1.applyConfig();
      b.link(s1, "Gi0/1", s2, "Gi0/1");
      b.link(s1, "Gi0/2", s3, "Gi0/1");
      b.link(s2, "Gi0/2", s3, "Gi0/2");
      b.link(b.pc("PC1", 120, 420, "10.0.0.1"), "Fa0", s2, "Fa0/1");
      b.link(b.pc("PC2", 720, 420, "10.0.0.2"), "Fa0", s3, "Fa0/1");
      b.note(620, 40, "SW1 is the root (priority 4096). One link shows an amber light: that port is blocking. Try 'show spanning-tree'.");
      return b.done("Spanning tree loop", "Loop prevention with 802.1D.");
    },
  },
];
