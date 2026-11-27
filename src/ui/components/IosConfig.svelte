<script lang="ts">
  import { app } from "../state.svelte";
  import type { IosDevice } from "../../engine/devices/ios";
  import { Router } from "../../engine/devices/router";
  import { Switch } from "../../engine/devices/switch";
  import { CliSession } from "../../engine/cli/session";
  import { isValidIp, isValidMask } from "../../engine/addr";
  import { allIfNames } from "../../engine/cli/show";

  let { dev }: { dev: IosDevice } = $props();
  let section = $state("global");
  let log = $state<string[]>([]);
  let logEl: HTMLDivElement | undefined = $state();

  const r = $derived(dev instanceof Router ? dev : undefined);
  const sw = $derived(dev instanceof Switch ? dev : undefined);

  /** Runs IOS commands so GUI changes and the CLI always agree. */
  function run(cmds: string[]) {
    const s = new CliSession(dev);
    s.attach(() => {});
    s.mode = "priv";
    const out: string[] = [];
    for (const c of ["configure terminal", ...cmds, "end"]) {
      const before = s.buffer.length;
      s.input(c);
      const res = s.buffer.slice(before).split("\n").slice(1).filter((l) => l.startsWith("%") && !l.startsWith("%SYS") && !l.startsWith("%LINK") && !l.startsWith("%LINEPROTO"));
      out.push(`${s.hostname}(config)# ${c}`);
      for (const l of res) out.push(l);
    }
    s.detach();
    log = [...log, ...out.slice(1, -1)].slice(-200);
    queueMicrotask(() => logEl && (logEl.scrollTop = logEl.scrollHeight));
    app.markDirty();
    app.bump();
  }

  const ifaces = $derived((app.tick, allIfNames(dev)));
  let hostname = $state("");
  let secret = $state("");
  $effect(() => {
    hostname = dev.hostname;
  });

  function ifInfo(name: string) {
    void app.tick;
    if (r) {
      const c = r.cfg.interfaces[name];
      return { ip: c?.ip ?? "", mask: c?.mask ?? "", on: !c?.shutdown, desc: c?.description ?? "", up: r.stack.ifByName(name)?.isUp() ?? false };
    }
    const s = sw!;
    if (name.startsWith("Vlan")) {
      const c = s.cfg.svis[Number(name.slice(4))];
      return { ip: c?.ip ?? "", mask: c?.mask ?? "", on: !c?.shutdown, desc: c?.description ?? "", up: s.sviUp(Number(name.slice(4))) };
    }
    const c = s.portCfg(name);
    const p = s.port(name)!;
    return { ip: c.ip ?? "", mask: c.mask ?? "", on: !c.shutdown, desc: c.description, up: p.isUp, mode: c.mode, vlan: c.accessVlan, routed: c.routed };
  }

  let ifForm = $state({ ip: "", mask: "", desc: "", vlan: "1" });
  let loadedFor = "";
  $effect(() => {
    if (section.startsWith("if:") && loadedFor !== section) {
      loadedFor = section;
      const i = ifInfo(section.slice(3));
      ifForm = { ip: i.ip, mask: i.mask, desc: i.desc, vlan: String(i.vlan ?? 1) };
    }
  });

  let route = $state({ net: "", mask: "", hop: "" });
  let vlanForm = $state({ id: "", name: "" });
  const vlans = $derived((app.tick, sw ? Object.entries(sw.cfg.vlans).filter(([k]) => Number(k) < 1002) : []));
  const routes = $derived((app.tick, r ? r.cfg.routes : sw?.layer3 ? sw.cfg.routes : []));
</script>

<div class="cfg">
  <nav class="side scroll">
    <div class="sh">Global</div>
    <button class:on={section === "global"} onclick={() => (section = "global")}>Settings</button>
    {#if r || sw?.layer3}<button class:on={section === "routing"} onclick={() => (section = "routing")}>Static routes</button>{/if}
    {#if sw}<button class:on={section === "vlans"} onclick={() => (section = "vlans")}>VLAN database</button>{/if}
    <div class="sh">Interfaces</div>
    {#each ifaces as n}
      {@const i = ifInfo(n)}
      <button class:on={section === "if:" + n} onclick={() => (section = "if:" + n)}>
        <span class="dot" style="background:{i.up ? 'var(--green)' : i.on ? 'var(--red)' : 'var(--fill-strong)'}"></span>{n}
      </button>
    {/each}
  </nav>
  <div class="main">
    <div class="pane scroll">
      {#if section === "global"}
        <h3>Global settings</h3>
        <div class="group">
          <div class="row"><span class="label">Hostname</span><input class="field" bind:value={hostname} /><button class="btn" onclick={() => run([`hostname ${hostname.trim()}`])}>Set</button></div>
          <div class="row"><span class="label">Enable secret</span><input class="field" type="password" bind:value={secret} placeholder="Not set" /><button class="btn" onclick={() => { if (secret) run([`enable secret ${secret}`]); else run(["no enable secret"]); secret = ""; }}>Set</button></div>
        </div>
        <h3>Configuration files</h3>
        <div class="group">
          <div class="row"><span class="label">Startup configuration<br /><span class="muted small">{dev.startup ? "Saved in NVRAM" : "Not saved"}</span></span><button class="btn" onclick={() => { dev.saveStartup(); log = [...log, `${dev.hostname}# copy running-config startup-config`]; app.markDirty(); app.bump(); }}>Save</button><button class="btn danger" disabled={!dev.startup} onclick={() => { dev.eraseStartup(); log = [...log, `${dev.hostname}# erase startup-config`]; app.bump(); }}>Erase</button></div>
          <div class="row"><span class="label">Reload device<br /><span class="muted small">Restarts with the startup configuration</span></span><button class="btn" onclick={() => { dev.reload(); app.clis.delete(dev.id); log = [...log, `${dev.hostname}# reload`]; app.bump(); }}>Reload</button></div>
        </div>
      {:else if section === "routing"}
        <h3>Static routes</h3>
        <div class="group">
          {#each routes as rt}
            <div class="row mono"><span class="label">{rt.network} {rt.mask}</span><span class="value">{rt.nextHop ?? rt.iface}</span><button class="btn plain danger" onclick={() => run([`no ip route ${rt.network} ${rt.mask} ${rt.nextHop ?? rt.iface}`])}>Remove</button></div>
          {:else}
            <div class="row muted">No static routes.</div>
          {/each}
        </div>
        <div class="addrow">
          <input class="field mono" placeholder="Network" bind:value={route.net} class:invalid={route.net && !isValidIp(route.net)} />
          <input class="field mono" placeholder="Mask" bind:value={route.mask} class:invalid={route.mask && !isValidMask(route.mask)} />
          <input class="field mono" placeholder="Next hop" bind:value={route.hop} class:invalid={route.hop && !isValidIp(route.hop)} />
          <button class="btn primary" disabled={!isValidIp(route.net) || !isValidMask(route.mask) || !isValidIp(route.hop)} onclick={() => { run([`ip route ${route.net} ${route.mask} ${route.hop}`]); route = { net: "", mask: "", hop: "" }; }}>Add</button>
        </div>
      {:else if section === "vlans" && sw}
        <h3>VLAN database</h3>
        <div class="group">
          {#each vlans as [id, name]}
            <div class="row"><span class="label"><b>{id}</b> <span class="muted">{name}</span></span>{#if id !== "1"}<button class="btn plain danger" onclick={() => run([`no vlan ${id}`])}>Remove</button>{/if}</div>
          {/each}
        </div>
        <div class="addrow">
          <input class="field" placeholder="VLAN ID" bind:value={vlanForm.id} />
          <input class="field" placeholder="Name" bind:value={vlanForm.name} />
          <button class="btn primary" disabled={!/^\d+$/.test(vlanForm.id) || Number(vlanForm.id) < 2 || Number(vlanForm.id) > 4094} onclick={() => { run([`vlan ${vlanForm.id}`, ...(vlanForm.name ? [`name ${vlanForm.name.replace(/\s+/g, "_")}`] : [])]); vlanForm = { id: "", name: "" }; }}>Add</button>
        </div>
      {:else if section.startsWith("if:")}
        {@const n = section.slice(3)}
        {@const i = ifInfo(n)}
        <h3>{n}</h3>
        <div class="group">
          <div class="row"><span class="label">Port status</span><span class="muted small">{i.up ? "Up" : "Down"}</span><input type="checkbox" class="switch" checked={i.on} onchange={(e) => run([`interface ${n}`, (e.target as HTMLInputElement).checked ? "no shutdown" : "shutdown"])} /></div>
          <div class="row"><span class="label">Description</span><input class="field" bind:value={ifForm.desc} onchange={() => run([`interface ${n}`, ifForm.desc ? `description ${ifForm.desc}` : "no description"])} /></div>
          {#if sw && !n.startsWith("Vlan")}
            <div class="row">
              <span class="label">Mode</span>
              <div class="segmented">
                <button class:on={i.mode === "access" || i.mode === "dynamic"} onclick={() => run([`interface ${n}`, "switchport mode access"])}>Access</button>
                <button class:on={i.mode === "trunk"} onclick={() => run([`interface ${n}`, "switchport mode trunk"])}>Trunk</button>
              </div>
            </div>
            {#if i.mode !== "trunk"}
              <div class="row"><span class="label">Access VLAN</span>
                <select class="field" bind:value={ifForm.vlan} onchange={() => run([`interface ${n}`, `switchport access vlan ${ifForm.vlan}`])}>
                  {#each vlans as [id, name]}<option value={id}>{id} {name}</option>{/each}
                </select>
              </div>
            {/if}
          {/if}
          {#if r || n.startsWith("Vlan") || i.routed}
            <div class="row"><span class="label">IPv4 address</span><input class="field mono" bind:value={ifForm.ip} class:invalid={ifForm.ip && !isValidIp(ifForm.ip)} /></div>
            <div class="row"><span class="label">Subnet mask</span><input class="field mono" bind:value={ifForm.mask} class:invalid={ifForm.mask && !isValidMask(ifForm.mask)} /></div>
            <div class="row"><span class="label"></span><button class="btn" onclick={() => run([`interface ${n}`, "no ip address"])}>Clear</button><button class="btn primary" disabled={!isValidIp(ifForm.ip) || !isValidMask(ifForm.mask)} onclick={() => run([`interface ${n}`, `ip address ${ifForm.ip} ${ifForm.mask}`])}>Apply</button></div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="eq">
      <div class="sh">Equivalent IOS commands</div>
      <div class="log scroll mono" bind:this={logEl}>
        {#each log as l}<div class:err={l.startsWith("%")}>{l}</div>{:else}<div class="muted">Changes you make here are run as CLI commands and shown below.</div>{/each}
      </div>
    </div>
  </div>
</div>

<style>
  .cfg {
    display: flex;
    min-height: 0;
  }
  .side {
    width: 200px;
    flex: none;
    padding: 8px;
    border-right: 0.5px solid var(--separator);
    background: var(--surface);
  }
  .side button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 7px;
    width: calc(100% - 16px);
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 12px;
  }
  .side button:hover {
    background: var(--fill);
  }
  .side button.on {
    background: var(--accent);
    color: #fff;
  }
  .sh {
    font-size: 11px;
    font-weight: 600;
    color: var(--secondary);
    margin: 10px 8px 4px;
  }
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .pane {
    flex: 1;
    padding: 4px 16px 16px;
  }
  h3 {
    font: 600 14px var(--font-display);
    margin: 14px 2px 8px;
  }
  .addrow {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .addrow .field {
    flex: 1;
  }
  .small {
    font-size: 11px;
  }
  .eq {
    height: 130px;
    flex: none;
    border-top: 0.5px solid var(--separator);
    display: flex;
    flex-direction: column;
    background: var(--terminal-bg);
  }
  .log {
    flex: 1;
    padding: 0 12px 8px;
    font-size: 12px;
    user-select: text;
  }
  .err {
    color: var(--red);
  }
</style>
