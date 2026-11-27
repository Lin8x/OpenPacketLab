import { describe, expect, it } from "vitest";
import { Lab, fastStp } from "./helpers";
import { CliSession } from "../src/engine/cli/session";
import type { Router } from "../src/engine/devices/router";
import type { Switch } from "../src/engine/devices/switch";
import { decodeType7, encodeType7 } from "../src/engine/cli/passwords";

function cli(lab: Lab, dev: Router | Switch) {
  const s = new CliSession(dev);
  s.attach(() => {});
  s.open();
  const run = (...lines: string[]) => {
    const start = s.buffer.length;
    for (const l of lines) {
      s.input(l);
      let guard = 0;
      while (s.busy && guard++ < 400) lab.run(100);
    }
    return s.buffer.slice(start);
  };
  return { s, run };
}

describe("IOS CLI", () => {
  it("moves between modes with abbreviations", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const { s, run } = cli(lab, r);
    expect(s.prompt()).toBe("R1>");
    run("en");
    expect(s.prompt()).toBe("R1#");
    run("conf t");
    expect(s.prompt()).toBe("R1(config)#");
    run("int g0/0");
    expect(s.prompt()).toBe("R1(config-if)#");
    run("exit", "hostname Edge");
    expect(s.prompt()).toBe("Edge(config)#");
    run("end");
    expect(s.prompt()).toBe("Edge#");
  });

  it("reports invalid, incomplete and ambiguous input", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const { run } = cli(lab, r);
    run("enable");
    expect(run("show ip foo")).toContain("% Invalid input detected at '^' marker.");
    expect(run("show ip")).toContain("% Incomplete command.");
    expect(run("c")).toContain("% Ambiguous command");
    expect(run("blah")).toContain("Translating \"blah\"");
  });

  it("offers ? help and tab completion", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const { s, run } = cli(lab, r);
    run("enable");
    expect(s.help("sh")).toContain("show");
    expect(s.help("show ")).toContain("running-config");
    expect(s.complete("conf")).toBe("configure ");
    expect(s.complete("show ip int")).toBe("show ip interface ");
  });

  it("configures interfaces and routes end to end", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const a = lab.pc("A", "192.168.1.10", "255.255.255.0", "192.168.1.1");
    const b = lab.pc("B", "192.168.2.10", "255.255.255.0", "192.168.2.1");
    lab.link(a, "Fa0", r, "Gi0/0");
    lab.link(b, "Fa0", r, "Gi0/1");
    const { run } = cli(lab, r);
    run("enable", "configure terminal", "interface GigabitEthernet0/0", "ip address 192.168.1.1 255.255.255.0", "no shutdown", "int gi0/1", "ip add 192.168.2.1 255.255.255.0", "no shut", "end");
    const brief = run("show ip interface brief");
    expect(brief).toMatch(/GigabitEthernet0\/0\s+192\.168\.1\.1\s+YES manual up\s+up/);
    expect(run("show ip route")).toMatch(/C\s+192\.168\.1\.0\/24 is directly connected, GigabitEthernet0\/0/);
    const ping = run("ping 192.168.2.10");
    expect(ping).toMatch(/Success rate is (80|100) percent/);
    expect(run("show running-config")).toContain("ip address 192.168.2.1 255.255.255.0");
  });

  it("saves to startup-config and survives reload", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const { s, run } = cli(lab, r);
    run("enable", "conf t", "hostname Core", "end", "copy running-config startup-config");
    expect(r.startup).toBeDefined();
    run("conf t", "hostname Temp", "end", "reload", "");
    expect(r.hostname).toBe("Core");
    expect(s.prompt()).toBe("Core>");
  });

  it("protects privileged mode with enable secret", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const { s, run } = cli(lab, r);
    run("enable", "conf t", "enable secret class", "service password-encryption", "line con 0", "password cisco", "login", "end", "disable");
    run("enable");
    expect(s.prompt()).toBe("Password: ");
    run("wrong");
    expect(s.prompt()).toBe("Password: ");
    run("class");
    expect(s.prompt()).toBe("R1#");
    const cfg = run("show run");
    expect(cfg).toMatch(/enable secret 5 \$1\$/);
    expect(cfg).toMatch(/password 7 [0-9A-F]+/);
  });

  it("configures VLANs, trunks and access ports on a switch", () => {
    const lab = new Lab();
    const sw = lab.sw("S1");
    fastStp(sw);
    const { run } = cli(lab, sw);
    run("en", "conf t", "vlan 10", "name SALES", "vlan 20", "name ENG", "exit", "interface range fa0/1 - 4", "switchport mode access", "switchport access vlan 10", "exit", "int gi0/1", "switchport mode trunk", "switchport trunk allowed vlan 10,20", "end");
    expect(sw.cfg.ports["FastEthernet0/3"].accessVlan).toBe(10);
    expect(sw.cfg.ports["GigabitEthernet0/1"].allowed).toEqual([10, 20]);
    const vb = run("show vlan brief");
    expect(vb).toMatch(/10\s+SALES\s+active\s+Fa0\/1, Fa0\/2, Fa0\/3, Fa0\/4/);
    expect(run("show running-config")).toContain("switchport trunk allowed vlan 10,20");
  });

  it("builds ACLs and NAT from commands", () => {
    const lab = new Lab();
    const r = lab.router("R1");
    const { run } = cli(lab, r);
    run("en", "conf t", "access-list 1 permit 192.168.1.0 0.0.0.255", "ip access-list extended WEB", "permit tcp any host 10.0.0.5 eq 80", "deny ip any any", "exit", "int g0/1", "ip nat outside", "int g0/0", "ip nat inside", "ip access-group WEB in", "exit", "ip nat inside source list 1 interface g0/1 overload", "end");
    expect(r.cfg.acls["WEB"].entries.length).toBe(2);
    expect(r.cfg.acls["WEB"].entries[0].dstPort).toEqual({ op: "eq", a: 80 });
    expect(r.cfg.interfaces["GigabitEthernet0/0"].aclIn).toBe("WEB");
    expect(r.cfg.nat.rules[0]).toMatchObject({ acl: "1", iface: "GigabitEthernet0/1", overload: true });
    const acl = run("show access-lists");
    expect(acl).toContain("Extended IP access list WEB");
    expect(acl).toContain("10 permit tcp any host 10.0.0.5 eq 80");
  });

  it("runs OSPF configured from the CLI", () => {
    const lab = new Lab();
    const r1 = lab.router("R1");
    const r2 = lab.router("R2");
    lab.link(r1, "Gi0/1", r2, "Gi0/1");
    const c1 = cli(lab, r1);
    const c2 = cli(lab, r2);
    c1.run("en", "conf t", "int g0/1", "ip add 10.0.0.1 255.255.255.252", "no sh", "int lo0", "ip add 1.1.1.1 255.255.255.255", "router ospf 1", "network 10.0.0.0 0.0.0.3 area 0", "network 1.1.1.1 0.0.0.0 area 0", "end");
    c2.run("en", "conf t", "int g0/1", "ip add 10.0.0.2 255.255.255.252", "no sh", "router ospf 1", "network 10.0.0.0 0.0.0.255 area 0", "end");
    lab.run(25000);
    expect(c2.run("show ip ospf neighbor")).toMatch(/1\.1\.1\.1\s+1\s+FULL/);
    expect(c2.run("show ip route")).toContain("1.1.1.1/32 [110/");
  });

  it("allows telnet with vty passwords", () => {
    const lab = new Lab();
    const r1 = lab.router("R1");
    const r2 = lab.router("R2");
    lab.link(r1, "Gi0/0", r2, "Gi0/0");
    const c1 = cli(lab, r1);
    const c2 = cli(lab, r2);
    c1.run("en", "conf t", "int g0/0", "ip add 10.0.0.1 255.255.255.0", "no sh", "end");
    c2.run("en", "conf t", "int g0/0", "ip add 10.0.0.2 255.255.255.0", "no sh", "end");
    lab.run(1000);
    c1.run("ping 10.0.0.2");
    const refused = c1.run("telnet 10.0.0.2");
    expect(refused).toContain("Password required, but none set");
    c2.run("conf t", "enable secret class", "line vty 0 4", "password cisco", "login", "end");
    c1.run("telnet 10.0.0.2");
    expect(c1.s.prompt()).toBe("Password: ");
    c1.run("cisco");
    expect(c1.s.prompt()).toBe("R2>");
    c1.run("enable", "class");
    expect(c1.s.prompt()).toBe("R2#");
    expect(c1.run("show ip interface brief")).toContain("10.0.0.2");
    c1.run("exit");
    expect(c1.s.prompt()).toBe("R1#");
  });

  it("encodes type 7 passwords reversibly", () => {
    expect(decodeType7(encodeType7("cisco"))).toBe("cisco");
  });
});

import { HostPrompt, browse } from "../src/engine/cli/hostcmd";

describe("PC command prompt", () => {
  function prompt(lab: Lab, h: import("../src/engine/devices/host").Host) {
    const p = new HostPrompt(h);
    p.open();
    return (line: string) => {
      const start = p.buffer.length;
      p.input(line);
      let g = 0;
      while (p.busy && g++ < 400) lab.run(100);
      return p.buffer.slice(start);
    };
  }

  it("pings and shows ipconfig", () => {
    const lab = new Lab();
    const a = lab.pc("A", "10.0.0.1");
    const b = lab.pc("B", "10.0.0.2");
    lab.link(a, "Fa0", b, "Fa0");
    const run = prompt(lab, a);
    const out = run("ping 10.0.0.2");
    expect(out).toContain("Reply from 10.0.0.2: bytes=32");
    expect(out).toContain("Sent = 4, Received = 4, Lost = 0 (0% loss)");
    expect(run("ipconfig")).toContain("IPv4 Address....................: 10.0.0.1");
    expect(run("arp -a")).toContain("10.0.0.2");
    expect(run("foo")).toContain("Invalid Command.");
  });

  it("browses a web server by name", () => {
    const lab = new Lab();
    const srv = lab.server("SRV", "10.0.0.5");
    srv.services!.dns.enabled = true;
    srv.services!.dns.records = [{ name: "lab.test", type: "A", value: "10.0.0.5" }];
    const pc = lab.pc("PC", "10.0.0.10");
    pc.ipConfig.dns = "10.0.0.5";
    pc.applyConfig();
    lab.link(pc, "Fa0", srv, "Fa0", "crossover");
    let body = "";
    browse(pc, "lab.test", (r) => (body = r.body));
    lab.run(5000);
    expect(body).toContain("It works!");
  });

  it("telnets from a PC to a switch management address", () => {
    const lab = new Lab();
    const sw = lab.sw("S1");
    fastStp(sw);
    const pc = lab.pc("PC", "10.0.0.10");
    lab.link(pc, "Fa0", sw, "Fa0/1");
    const c = cli(lab, sw);
    c.run("en", "conf t", "int vlan 1", "ip address 10.0.0.2 255.255.255.0", "no shut", "line vty 0 4", "password pass", "login", "end");
    lab.run(1000);
    const run = prompt(lab, pc);
    run("telnet 10.0.0.2");
    run("pass");
    expect(run("show vlan brief")).toContain("default");
  });
});
