import { describe, expect, it } from "vitest";
import { Lab, fastStp, routerIf } from "./helpers";
import { defaultOspf, defaultRip, defaultEigrp } from "../src/engine/devices/routing";
import { loadProject, serializeProject } from "../src/engine/project";
import { Host } from "../src/engine/devices/host";
import { Switch } from "../src/engine/devices/switch";
import { cableWorks } from "../src/engine/network";
import { prefixToMask, maskToPrefix, wildcardToMask, matchesWildcard } from "../src/engine/addr";

describe("addresses", () => {
  it("converts masks", () => {
    expect(prefixToMask(24)).toBe("255.255.255.0");
    expect(maskToPrefix("255.255.240.0")).toBe(20);
    expect(wildcardToMask("0.0.0.255")).toBe("255.255.255.0");
    expect(matchesWildcard("10.1.2.3", "10.1.0.0", "0.0.255.255")).toBe(true);
    expect(matchesWildcard("10.2.2.3", "10.1.0.0", "0.0.255.255")).toBe(false);
  });
});

describe("cabling", () => {
  it("needs a crossover between two PCs", () => {
    const lab = new Lab();
    const a = lab.pc("A", "10.0.0.1");
    const b = lab.pc("B", "10.0.0.2");
    expect(cableWorks("straight", a.nic, b.nic)).toBe(false);
    lab.link(a, "Fa0", b, "Fa0", "straight");
    expect(lab.ping(a, "10.0.0.2").kind).not.toBe("reply");
  });

  it("works with a crossover between two PCs", () => {
    const lab = new Lab();
    const a = lab.pc("A", "10.0.0.1");
    const b = lab.pc("B", "10.0.0.2");
    lab.link(a, "Fa0", b, "Fa0", "crossover");
    const r = lab.ping(a, "10.0.0.2");
    expect(r.kind).toBe("reply");
    expect(a.stack.arp.get("10.0.0.2")?.mac).toBe(b.nic.mac);
  });
});

describe("switching", () => {
  it("forwards through a switch and learns MACs", () => {
    const lab = new Lab();
    const sw = lab.sw("SW1");
    fastStp(sw);
    const a = lab.pc("A", "192.168.1.10");
    const b = lab.pc("B", "192.168.1.11");
    lab.link(a, "Fa0", sw, "Fa0/1");
    lab.link(b, "Fa0", sw, "Fa0/2");
    lab.run(1000);
    expect(lab.ping(a, "192.168.1.11").kind).toBe("reply");
    const macs = sw.macTableEntries();
    expect(macs.find((m) => m.mac === a.nic.mac)?.port).toBe("Fa0/1");
    expect(macs.find((m) => m.mac === b.nic.mac)?.port).toBe("Fa0/2");
  });

  it("waits for spanning tree before forwarding", () => {
    const lab = new Lab();
    const sw = lab.sw("SW1");
    const a = lab.pc("A", "192.168.1.10");
    const b = lab.pc("B", "192.168.1.11");
    lab.link(a, "Fa0", sw, "Fa0/1");
    lab.link(b, "Fa0", sw, "Fa0/2");
    expect(sw.port("Fa0/1")!.stpState).toBe("listening");
    lab.run(31000);
    expect(sw.port("Fa0/1")!.stpState).toBe("forwarding");
    expect(lab.ping(a, "192.168.1.11").kind).toBe("reply");
  });

  it("isolates VLANs and carries them over a trunk", () => {
    const lab = new Lab();
    const s1 = lab.sw("S1");
    const s2 = lab.sw("S2");
    fastStp(s1, s2);
    for (const s of [s1, s2]) {
      s.cfg.vlans[10] = "SALES";
      s.cfg.vlans[20] = "ENG";
      s.cfg.ports["FastEthernet0/1"].mode = "access";
      s.cfg.ports["FastEthernet0/1"].accessVlan = 10;
      s.cfg.ports["FastEthernet0/2"].mode = "access";
      s.cfg.ports["FastEthernet0/2"].accessVlan = 20;
      s.cfg.ports["GigabitEthernet0/1"].mode = "trunk";
      s.applyConfig();
    }
    const a10 = lab.pc("A10", "10.0.0.1");
    const a20 = lab.pc("A20", "10.0.0.2");
    const b10 = lab.pc("B10", "10.0.0.3");
    lab.link(a10, "Fa0", s1, "Fa0/1");
    lab.link(a20, "Fa0", s1, "Fa0/2");
    lab.link(b10, "Fa0", s2, "Fa0/1");
    lab.link(s1, "Gi0/1", s2, "Gi0/1");
    lab.run(2000);
    expect(lab.ping(a10, "10.0.0.3").kind).toBe("reply");
    expect(lab.ping(a10, "10.0.0.2").kind).toBe("timeout");
  });

  it("blocks a redundant link with spanning tree and avoids storms", () => {
    const lab = new Lab();
    const s1 = lab.sw("S1");
    const s2 = lab.sw("S2");
    const s3 = lab.sw("S3");
    fastStp(s1, s2, s3);
    lab.link(s1, "Gi0/1", s2, "Gi0/1");
    lab.link(s2, "Gi0/2", s3, "Gi0/1");
    lab.link(s3, "Gi0/2", s1, "Gi0/2");
    const a = lab.pc("A", "10.0.0.1");
    const b = lab.pc("B", "10.0.0.2");
    lab.link(a, "Fa0", s1, "Fa0/1");
    lab.link(b, "Fa0", s3, "Fa0/1");
    lab.run(5000);
    const blocked = [s1, s2, s3].flatMap((s) => s.ports.filter((p) => p.stpState === "blocking"));
    expect(blocked.length).toBe(1);
    expect(lab.ping(a, "10.0.0.2").kind).toBe("reply");
    expect(lab.net.inFlight.size).toBeLessThan(50);
  });

  it("shuts a port on a port-security violation", () => {
    const lab = new Lab();
    const sw = lab.sw("SW");
    fastStp(sw);
    const c = sw.cfg.ports["FastEthernet0/1"];
    c.mode = "access";
    c.security.enabled = true;
    c.security.max = 1;
    c.security.macs = ["02:00:00:00:00:99"];
    sw.applyConfig();
    const a = lab.pc("A", "10.0.0.1");
    const b = lab.pc("B", "10.0.0.2");
    lab.link(a, "Fa0", sw, "Fa0/1");
    lab.link(b, "Fa0", sw, "Fa0/2");
    lab.run(1000);
    expect(lab.ping(a, "10.0.0.2").kind).toBe("timeout");
    expect(c.errDisabled).toBe("psecure-violation");
  });
});

describe("routing", () => {
  function twoLan() {
    const lab = new Lab();
    const r = lab.router("R1");
    const a = lab.pc("A", "192.168.1.10", "255.255.255.0", "192.168.1.1");
    const b = lab.pc("B", "192.168.2.10", "255.255.255.0", "192.168.2.1");
    lab.link(a, "Fa0", r, "Gi0/0");
    lab.link(b, "Fa0", r, "Gi0/1");
    routerIf(r, "GigabitEthernet0/0", "192.168.1.1");
    routerIf(r, "GigabitEthernet0/1", "192.168.2.1");
    return { lab, r, a, b };
  }

  it("routes between connected networks", () => {
    const { lab, a } = twoLan();
    expect(lab.reach(a, "192.168.2.10")).toBe(true);
  });

  it("interfaces start shut down", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    expect(r.ifCfg("GigabitEthernet0/0").shutdown).toBe(true);
  });

  it("reports TTL expiry and no route", () => {
    const { lab, a } = twoLan();
    lab.reach(a, "192.168.2.10");
    let res: string | undefined;
    a.stack.sendEcho("192.168.2.10", { ttl: 1, seq: 77 }, (r) => (res = r.kind));
    lab.run(500);
    expect(res).toBe("ttl-exceeded");
    expect(lab.ping(a, "8.8.8.8").kind).toBe("unreachable");
  });

  it("follows static routes across two routers over serial", () => {
    const lab = new Lab();
    const r1 = lab.router("R1");
    const r2 = lab.router("R2");
    const a = lab.pc("A", "10.1.0.10", "255.255.255.0", "10.1.0.1");
    const b = lab.pc("B", "10.2.0.10", "255.255.255.0", "10.2.0.1");
    lab.link(a, "Fa0", r1, "Gi0/0");
    lab.link(b, "Fa0", r2, "Gi0/0");
    lab.link(r1, "Se0/0/0", r2, "Se0/0/0", "serial");
    routerIf(r1, "GigabitEthernet0/0", "10.1.0.1");
    routerIf(r2, "GigabitEthernet0/0", "10.2.0.1");
    routerIf(r1, "Serial0/0/0", "172.16.0.1", "255.255.255.252");
    routerIf(r2, "Serial0/0/0", "172.16.0.2", "255.255.255.252");
    // No clock rate on the DCE end yet: line protocol stays down.
    expect(r1.stack.ifByName("Serial0/0/0")!.isUp()).toBe(false);
    r1.ifCfg("Serial0/0/0").clockRate = 64000;
    r1.applyConfig();
    expect(r1.stack.ifByName("Serial0/0/0")!.isUp()).toBe(true);
    r1.cfg.routes.push({ network: "10.2.0.0", mask: "255.255.255.0", nextHop: "172.16.0.2", ad: 1 });
    r2.cfg.routes.push({ network: "0.0.0.0", mask: "0.0.0.0", nextHop: "172.16.0.1", ad: 1 });
    expect(lab.reach(a, "10.2.0.10")).toBe(true);
  });

  function triangle(proto: "rip" | "ospf" | "eigrp") {
    const lab = new Lab();
    const rs = [lab.router("R1"), lab.router("R2"), lab.router("R3")];
    lab.link(rs[0], "Gi0/1", rs[1], "Gi0/1");
    lab.link(rs[1], "Gi0/2", rs[2], "Gi0/2");
    routerIf(rs[0], "GigabitEthernet0/1", "10.0.12.1");
    routerIf(rs[1], "GigabitEthernet0/1", "10.0.12.2");
    routerIf(rs[1], "GigabitEthernet0/2", "10.0.23.2");
    routerIf(rs[2], "GigabitEthernet0/2", "10.0.23.3");
    const a = lab.pc("A", "192.168.1.10", "255.255.255.0", "192.168.1.1");
    const b = lab.pc("B", "192.168.3.10", "255.255.255.0", "192.168.3.1");
    lab.link(a, "Fa0", rs[0], "Gi0/0");
    lab.link(b, "Fa0", rs[2], "Gi0/0");
    routerIf(rs[0], "GigabitEthernet0/0", "192.168.1.1");
    routerIf(rs[2], "GigabitEthernet0/0", "192.168.3.1");
    for (const r of rs) {
      if (proto === "rip") {
        const c = defaultRip();
        c.version = 2;
        c.networks = ["10.0.0.0", "192.168.1.0", "192.168.3.0"];
        r.cfg.routing.rip = c;
      } else if (proto === "ospf") {
        const c = defaultOspf(1);
        c.networks = [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 }];
        r.cfg.routing.ospf = c;
      } else {
        const c = defaultEigrp(100);
        c.networks = [{ network: "10.0.0.0" }, { network: "192.168.1.0" }, { network: "192.168.3.0" }];
        r.cfg.routing.eigrp = c;
      }
      r.applyConfig();
    }
    return { lab, rs, a };
  }

  it("converges with RIPv2", () => {
    const { lab, rs, a } = triangle("rip");
    lab.run(10000);
    expect(rs[0].stack.routingTable().some((r) => r.code === "R" && r.network === "192.168.3.0" && r.metric === 2)).toBe(true);
    expect(lab.reach(a, "192.168.3.10")).toBe(true);
  });

  it("converges with OSPF", () => {
    const { lab, rs, a } = triangle("ospf");
    lab.run(25000);
    expect([...rs[0].routing.ospfNeighbors.values()].every((n) => n.state === "FULL")).toBe(true);
    expect(rs[0].stack.routingTable().some((r) => r.code === "O" && r.network === "192.168.3.0")).toBe(true);
    expect(lab.reach(a, "192.168.3.10")).toBe(true);
  });

  it("converges with EIGRP", () => {
    const { lab, rs, a } = triangle("eigrp");
    lab.run(15000);
    expect(rs[0].stack.routingTable().some((r) => r.code === "D" && r.network === "192.168.3.0")).toBe(true);
    expect(lab.reach(a, "192.168.3.10")).toBe(true);
  });

  it("routes between VLANs on a stick", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const sw = lab.sw("SW1");
    fastStp(sw);
    sw.cfg.vlans[10] = "A";
    sw.cfg.vlans[20] = "B";
    Object.assign(sw.cfg.ports["FastEthernet0/1"], { mode: "access", accessVlan: 10 });
    Object.assign(sw.cfg.ports["FastEthernet0/2"], { mode: "access", accessVlan: 20 });
    sw.cfg.ports["GigabitEthernet0/1"].mode = "trunk";
    sw.applyConfig();
    const a = lab.pc("A", "10.10.0.5", "255.255.255.0", "10.10.0.1");
    const b = lab.pc("B", "10.20.0.5", "255.255.255.0", "10.20.0.1");
    lab.link(a, "Fa0", sw, "Fa0/1");
    lab.link(b, "Fa0", sw, "Fa0/2");
    lab.link(sw, "Gi0/1", r, "Gi0/0");
    r.ifCfg("GigabitEthernet0/0").shutdown = false;
    for (const v of [10, 20]) {
      const c = r.ifCfg(`GigabitEthernet0/0.${v}`);
      c.dot1q = v;
      c.ip = `10.${v}.0.1`;
      c.mask = "255.255.255.0";
    }
    r.applyConfig();
    lab.net.linkChanged(r.port("Gi0/0")!.link!);
    lab.run(1000);
    expect(lab.reach(a, "10.20.0.5")).toBe(true);
  });

  it("routes between VLANs on a multilayer switch", () => {
    const lab = new Lab();
    const mls = lab.add<Switch>("l3switch", "MLS");
    fastStp(mls);
    mls.cfg.vlans[10] = "A";
    mls.cfg.vlans[20] = "B";
    Object.assign(mls.cfg.ports["GigabitEthernet1/0/1"], { mode: "access", accessVlan: 10 });
    Object.assign(mls.cfg.ports["GigabitEthernet1/0/2"], { mode: "access", accessVlan: 20 });
    mls.cfg.svis[10] = { ip: "10.10.0.1", mask: "255.255.255.0", shutdown: false, description: "", helpers: [] };
    mls.cfg.svis[20] = { ip: "10.20.0.1", mask: "255.255.255.0", shutdown: false, description: "", helpers: [] };
    mls.cfg.ipRouting = true;
    mls.applyConfig();
    const a = lab.pc("A", "10.10.0.5", "255.255.255.0", "10.10.0.1");
    const b = lab.pc("B", "10.20.0.5", "255.255.255.0", "10.20.0.1");
    lab.link(a, "Fa0", mls, "Gi1/0/1");
    lab.link(b, "Fa0", mls, "Gi1/0/2");
    lab.run(1000);
    expect(lab.reach(a, "10.20.0.5")).toBe(true);
  });
});

describe("services", () => {
  it("leases addresses from a router DHCP pool", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const sw = lab.sw("SW");
    fastStp(sw);
    lab.link(r, "Gi0/0", sw, "Gi0/1");
    routerIf(r, "GigabitEthernet0/0", "192.168.10.1");
    r.cfg.dhcpExcluded.push({ from: "192.168.10.1", to: "192.168.10.9" });
    r.cfg.dhcpPools.push({ name: "LAN", network: "192.168.10.0", mask: "255.255.255.0", defaultRouter: "192.168.10.1", dns: "8.8.8.8" });
    r.applyConfig();
    const pcs: Host[] = [];
    for (let i = 0; i < 3; i++) {
      const h = lab.pc(`PC${i}`);
      h.ipConfig.mode = "dhcp";
      lab.link(h, "Fa0", sw, `Fa0/${i + 1}`);
      h.applyConfig();
      pcs.push(h);
    }
    lab.run(15000);
    const ips = pcs.map((p) => p.active.ip);
    expect(new Set(ips).size).toBe(3);
    for (const ip of ips) expect(ip.startsWith("192.168.10.")).toBe(true);
    expect(ips.every((ip) => Number(ip.split(".")[3]) >= 10)).toBe(true);
    expect(pcs[0].active.gateway).toBe("192.168.10.1");
    expect(lab.reach(pcs[0], "192.168.10.1")).toBe(true);
  });

  it("relays DHCP to a server on another network", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const srv = lab.server("SRV", "10.0.0.5", "10.0.0.1");
    srv.services!.dhcp.enabled = true;
    srv.services!.dhcp.pools = [{ name: "remote", defaultRouter: "192.168.50.1", dns: "10.0.0.5", start: "192.168.50.100", mask: "255.255.255.0", max: 10 }];
    srv.syncServices();
    const pc = lab.pc("PC");
    pc.ipConfig.mode = "dhcp";
    lab.link(srv, "Fa0", r, "Gi0/1");
    lab.link(pc, "Fa0", r, "Gi0/0");
    routerIf(r, "GigabitEthernet0/1", "10.0.0.1");
    routerIf(r, "GigabitEthernet0/0", "192.168.50.1");
    r.ifCfg("GigabitEthernet0/0").helpers = ["10.0.0.5"];
    pc.applyConfig();
    lab.run(20000);
    expect(pc.active.ip).toBe("192.168.50.100");
    expect(pc.active.dns).toBe("10.0.0.5");
  });

  it("falls back to APIPA without a DHCP server", () => {
    const lab = new Lab();
    const a = lab.pc("A");
    const b = lab.pc("B", "10.0.0.2");
    a.ipConfig.mode = "dhcp";
    lab.link(a, "Fa0", b, "Fa0");
    a.applyConfig();
    lab.run(30000);
    expect(a.active.ip.startsWith("169.254.")).toBe(true);
  });

  it("resolves names and serves web pages", () => {
    const lab = new Lab();
    const sw = lab.sw("SW");
    fastStp(sw);
    const srv = lab.server("SRV", "10.0.0.5");
    srv.services!.dns.enabled = true;
    srv.services!.dns.records = [
      { name: "example.lab", type: "A", value: "10.0.0.5" },
      { name: "www.example.lab", type: "CNAME", value: "example.lab" },
    ];
    const pc = lab.pc("PC", "10.0.0.10");
    pc.ipConfig.dns = "10.0.0.5";
    pc.applyConfig();
    lab.link(srv, "Fa0", sw, "Fa0/1");
    lab.link(pc, "Fa0", sw, "Fa0/2");
    lab.run(1000);
    let ip: string | null = null;
    pc.resolver.resolve("www.example.lab", pc.active.dns, (r) => (ip = r));
    lab.run(1000);
    expect(ip).toBe("10.0.0.5");
    let body = "";
    pc.stack.tcpRequest("10.0.0.5", 80, "GET / HTTP/1.1\r\nHost: example.lab\r\n\r\n", (r) => (body = r.ok ? r.data : r.error));
    lab.run(1000);
    expect(body).toContain("200 OK");
    expect(body).toContain("It works!");
    let refused = "";
    pc.stack.tcpRequest("10.0.0.5", 8080, "x", (r) => (refused = r.ok ? "ok" : r.error));
    lab.run(1000);
    expect(refused).toBe("Connection refused");
  });
});

describe("security", () => {
  it("applies an extended ACL", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const a = lab.pc("A", "192.168.1.10", "255.255.255.0", "192.168.1.1");
    const srv = lab.server("S", "192.168.2.10", "192.168.2.1");
    lab.link(a, "Fa0", r, "Gi0/0");
    lab.link(srv, "Fa0", r, "Gi0/1");
    routerIf(r, "GigabitEthernet0/0", "192.168.1.1");
    routerIf(r, "GigabitEthernet0/1", "192.168.2.1");
    r.cfg.acls["110"] = {
      type: "extended",
      entries: [
        { seq: 10, action: "deny", protocol: "icmp", src: { addr: "192.168.1.0", wc: "0.0.0.255" }, dst: { addr: "192.168.2.10", wc: "0.0.0.0" } },
        { seq: 20, action: "permit", protocol: "ip", src: { addr: "0.0.0.0", wc: "255.255.255.255" }, dst: { addr: "0.0.0.0", wc: "255.255.255.255" } },
      ],
    };
    r.ifCfg("GigabitEthernet0/0").aclIn = "110";
    expect(lab.reach(a, "192.168.2.10")).toBe(false);
    let body = "";
    a.stack.tcpRequest("192.168.2.10", 80, "GET / HTTP/1.1\r\n\r\n", (x) => (body = x.ok ? x.data : x.error));
    lab.run(6000);
    expect(body).toContain("200 OK");
  });

  it("translates with PAT", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const inside = lab.pc("IN", "192.168.1.10", "255.255.255.0", "192.168.1.1");
    const outside = lab.server("OUT", "203.0.113.10", "203.0.113.1");
    lab.link(inside, "Fa0", r, "Gi0/0");
    lab.link(outside, "Fa0", r, "Gi0/1");
    routerIf(r, "GigabitEthernet0/0", "192.168.1.1");
    routerIf(r, "GigabitEthernet0/1", "203.0.113.1");
    r.ifCfg("GigabitEthernet0/0").nat = "inside";
    r.ifCfg("GigabitEthernet0/1").nat = "outside";
    r.cfg.acls["1"] = { type: "standard", entries: [{ seq: 10, action: "permit", protocol: "ip", src: { addr: "192.168.1.0", wc: "0.0.0.255" } }] };
    r.cfg.nat.rules.push({ acl: "1", iface: "GigabitEthernet0/1", overload: true });
    expect(lab.reach(inside, "203.0.113.10")).toBe(true);
    expect(r.natTable.some((e) => e.insideLocal === "192.168.1.10" && e.insideGlobal === "203.0.113.1")).toBe(true);
    expect(outside.stack.arp.has("192.168.1.10")).toBe(false);
  });
});

describe("project files", () => {
  it("round-trips a topology", () => {
    const lab = new Lab();
    const r = lab.router("Edge");
    const a = lab.pc("A", "192.168.1.10", "255.255.255.0", "192.168.1.1");
    lab.link(a, "Fa0", r, "Gi0/0");
    routerIf(r, "GigabitEthernet0/0", "192.168.1.1");
    r.saveStartup();
    const json = JSON.parse(JSON.stringify(serializeProject(lab.net, { name: "Test" })));
    const { net } = loadProject(json);
    expect(net.devices.size).toBe(2);
    expect(net.links.size).toBe(1);
    const r2 = [...net.devices.values()].find((d) => d.hostname === "Edge") as typeof r;
    expect(r2.cfg.interfaces["GigabitEthernet0/0"].ip).toBe("192.168.1.1");
    expect(r2.startup).toBeDefined();
    const a2 = [...net.devices.values()].find((d) => d.hostname === "A") as Host;
    let res = "";
    a2.stack.sendEcho("192.168.1.1", { timeout: 1000 }, (x) => (res = x.kind));
    net.advance(1200);
    a2.stack.sendEcho("192.168.1.1", { timeout: 1000, seq: 2 }, (x) => (res = x.kind));
    net.advance(1200);
    expect(res).toBe("reply");
  });

  it("rejects other files", () => {
    expect(() => loadProject({ hello: 1 })).toThrow();
  });
});
