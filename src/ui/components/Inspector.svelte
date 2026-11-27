<script lang="ts">
  import { app } from "../state.svelte";
  import { CABLE_LABEL, cableWorks, type Device } from "../../engine/network";
  import { Host } from "../../engine/devices/host";
  import { IosDevice } from "../../engine/devices/ios";
  import { Router } from "../../engine/devices/router";
  import { Switch } from "../../engine/devices/switch";
  import { isValidIp, isValidMask } from "../../engine/addr";
  import { duplicateSelection } from "../actions";
  import DeviceGlyph from "./DeviceGlyph.svelte";
  import Icon from "./Icon.svelte";

  const sel = $derived((app.tick, app.selectedDevices));
  const dev = $derived(sel.length === 1 ? sel[0] : undefined);
  const link = $derived((app.tick, app.selectedLink ? app.net.links.get(app.selectedLink) : undefined));

  let ipForm = $state({ mode: "static" as "static" | "dhcp", ip: "", mask: "", gateway: "", dns: "" });
  let formFor = "";
  $effect(() => {
    if (dev instanceof Host && formFor !== dev.id) {
      formFor = dev.id;
      ipForm = { ...dev.ipConfig };
    }
  });

  function applyIp(h: Host) {
    if (ipForm.mode === "static") {
      if (ipForm.ip && !isValidIp(ipForm.ip)) return app.toast("The IP address is not valid.", "error");
      if (ipForm.mask && !isValidMask(ipForm.mask)) return app.toast("The subnet mask is not valid.", "error");
    }
    app.checkpoint();
    h.ipConfig = { ...ipForm };
    if (ipForm.mode === "static" && ipForm.ip && !ipForm.mask) {
      const f = Number(ipForm.ip.split(".")[0]);
      h.ipConfig.mask = f < 128 ? "255.0.0.0" : f < 192 ? "255.255.0.0" : "255.255.255.0";
      ipForm.mask = h.ipConfig.mask;
    }
    h.applyConfig();
    app.markDirty();
    app.bump();
  }

  function rename(d: Device, name: string) {
    const n = name.trim();
    if (!n || n === d.hostname) return;
    app.checkpoint();
    d.hostname = n;
    if (d instanceof Router || d instanceof Switch) d.cfg.hostname = n;
    app.markDirty();
    app.bump();
  }

  function portRows(d: Device) {
    void app.tick;
    return d.ports.map((p) => {
      let ip = "";
      if (d instanceof Router) ip = d.cfg.interfaces[p.name]?.ip ?? "";
      else if (d instanceof Host) ip = d.active.ip;
      else if (d instanceof Switch && p.media !== "console") {
        const c = d.cfg.ports[p.name];
        ip = c?.routed ? c.ip ?? "" : d.opMode(p) === "trunk" ? "trunk" : `VLAN ${c?.accessVlan ?? 1}`;
      }
      return { p, ip, peer: p.peer ? `${p.peer.device.hostname} ${p.peer.short}` : "" };
    });
  }

  const pdus = $derived((app.tick, app.pdus));
</script>

<aside class="insp scroll" aria-label="Inspector">
  {#if dev}
    <div class="head">
      <DeviceGlyph kind={dev.kind} size={44} dim={!dev.powered} />
      <div class="hn">
        <input class="namefield" value={dev.hostname} aria-label="Device name" onchange={(e) => rename(dev, (e.target as HTMLInputElement).value)} onkeydown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <div class="muted">{dev.model}</div>
      </div>
    </div>
    <div class="actions">
      {#if dev instanceof IosDevice}
        <button class="btn primary" onclick={() => app.openWindow(dev.id, "cli")}><Icon name="terminal" size={15} />CLI</button>
        <button class="btn" onclick={() => app.openWindow(dev.id, "config")}>Config</button>
      {:else if dev instanceof Host}
        <button class="btn primary" onclick={() => app.openWindow(dev.id, "desktop")}>Desktop</button>
        <button class="btn" onclick={() => app.openWindow(dev.id, dev.services ? "services" : "config")}>{dev.services ? "Services" : "Config"}</button>
      {:else}
        <button class="btn" onclick={() => app.openWindow(dev.id, "config")}>Open</button>
      {/if}
      <button class="btn icon" title={dev.powered ? "Turn off" : "Turn on"} aria-label="Power" onclick={() => { dev.setPower(!dev.powered); app.markDirty(); app.bump(); }} style:color={dev.powered ? "var(--green)" : "var(--red)"}><Icon name="power" size={16} /></button>
    </div>

    {#if dev instanceof Host}
      <div class="section-title">IP configuration</div>
      <div class="group">
        <div class="row">
          <div class="segmented" style="width:100%">
            <button style="flex:1" class:on={ipForm.mode === "dhcp"} onclick={() => { ipForm.mode = "dhcp"; applyIp(dev); }}>DHCP</button>
            <button style="flex:1" class:on={ipForm.mode === "static"} onclick={() => (ipForm.mode = "static")}>Static</button>
          </div>
        </div>
        {#if ipForm.mode === "static"}
          {#each [["ip", "IP address"], ["mask", "Subnet mask"], ["gateway", "Gateway"], ["dns", "DNS server"]] as [k, label]}
            <div class="row">
              <span class="label">{label}</span>
              <input class="field mono sm" class:invalid={ipForm[k as "ip"] && !(k === "mask" ? isValidMask(ipForm[k as "ip"]) : isValidIp(ipForm[k as "ip"]))} bind:value={ipForm[k as "ip"]} placeholder="0.0.0.0" onkeydown={(e) => e.key === "Enter" && applyIp(dev)} onblur={() => applyIp(dev)} />
            </div>
          {/each}
        {:else}
          <div class="row"><span class="label">Address</span><span class="value mono">{dev.active.ip || "—"}</span></div>
          <div class="row"><span class="label">Gateway</span><span class="value mono">{dev.active.gateway || "—"}</span></div>
          <div class="row"><span class="label muted" style="font-size:11px">{dev.dhcpStatus}</span><button class="btn sm" onclick={() => dev.renew()}>Renew</button></div>
        {/if}
      </div>
    {/if}

    <div class="section-title">Ports</div>
    <div class="group ports">
      {#each portRows(dev) as r}
        <div class="row">
          <span class="dot" style="background:{r.p.light === 'green' ? 'var(--green)' : r.p.light === 'amber' ? 'var(--orange)' : r.p.light === 'red' ? 'var(--red)' : 'var(--fill-strong)'}"></span>
          <span class="label"><span class="pn">{r.p.short}</span>{#if r.peer}<span class="muted peer"> → {r.peer}</span>{/if}</span>
          <span class="value mono small">{r.ip}</span>
        </div>
      {/each}
    </div>
    {#if dev instanceof Switch}
      <div class="section-title">Switching</div>
      <div class="group">
        <div class="row"><span class="label">VLANs</span><span class="value">{Object.keys(dev.cfg.vlans).length - 4}</span></div>
        <div class="row"><span class="label">MAC table entries</span><span class="value">{dev.macTableEntries().length}</span></div>
        <div class="row"><span class="label">Spanning tree root</span><span class="value">{dev.rootInfo().rootId === dev.bridgeId() ? "This switch" : "Elsewhere"}</span></div>
      </div>
    {/if}
  {:else if sel.length > 1}
    <div class="multi">
      <h3>{sel.length} devices selected</h3>
      <div class="actions">
        <button class="btn" onclick={duplicateSelection}><Icon name="duplicate" size={15} />Duplicate</button>
        <button class="btn danger" onclick={() => app.removeDevices(sel.map((d) => d.id))}><Icon name="trash" size={15} />Delete</button>
      </div>
      <div class="actions">
        <button class="btn" onclick={() => { app.checkpoint(); const y = sel.reduce((a, d) => a + d.y, 0) / sel.length; for (const d of sel) d.y = y; app.bump(); }}>Align rows</button>
        <button class="btn" onclick={() => { app.checkpoint(); const x = sel.reduce((a, d) => a + d.x, 0) / sel.length; for (const d of sel) d.x = x; app.bump(); }}>Align columns</button>
      </div>
    </div>
  {:else if link}
    <div class="multi">
      <h3>Connection</h3>
      <div class="group">
        <div class="row"><span class="label">{link.a.device.hostname}</span><span class="value">{link.a.name}</span></div>
        <div class="row"><span class="label">{link.b.device.hostname}</span><span class="value">{link.b.name}</span></div>
        <div class="row"><span class="label">Cable</span><span class="value">{CABLE_LABEL[link.cable]}</span></div>
        <div class="row"><span class="label">Status</span><span class="value">{link.isUp ? "Up" : !cableWorks(link.cable, link.a, link.b) ? "Wrong cable type" : "Down"}</span></div>
        {#if link.cable === "serial"}<div class="row"><span class="label">DCE end</span><span class="value">{link.a.device.hostname} {link.a.short}</span></div>{/if}
      </div>
      <div class="actions"><button class="btn danger" onclick={() => app.removeLink(link.id)}><Icon name="trash" size={15} />Remove connection</button></div>
    </div>
  {:else}
    <div class="multi">
      <h3>{app.name}</h3>
      <div class="group">
        <div class="row"><span class="label">Devices</span><span class="value">{(app.tick, app.net.devices.size)}</span></div>
        <div class="row"><span class="label">Connections</span><span class="value">{(app.tick, app.net.links.size)}</span></div>
        <div class="row"><span class="label">Simulated time</span><span class="value">{(app.tick, (app.net.time / 1000).toFixed(1))} s</span></div>
      </div>
      <p class="muted tip">Select a device to see its ports and settings. Double-click it to open its CLI or desktop.</p>
    </div>
  {/if}

  <div class="section-title pduh">
    <span>Pings & PDUs</span>
    {#if pdus.length}<button class="linkbtn" onclick={() => (app.pdus = [])}>Clear</button>{/if}
  </div>
  {#if pdus.length}
    <div class="group">
      {#each pdus as p (p.id)}
        <div class="row pdu">
          <span class="dot" style="background:{p.status === 'successful' ? 'var(--green)' : p.status === 'failed' ? 'var(--red)' : 'var(--orange)'}"></span>
          <span class="label">
            <span>{app.device(p.src)?.hostname ?? "?"} → {app.device(p.dst)?.hostname ?? p.dstIp}</span>
            <span class="muted small block">{p.status === "pending" ? (app.mode === "simulation" ? "In progress. Step the simulation." : "In progress") : p.detail}</span>
          </span>
          <button class="btn plain icon sm" title="Send again" aria-label="Send again" onclick={() => app.addPdu(p.src, p.dst)}><Icon name="reset" size={14} /></button>
          <button class="btn plain icon sm" title="Remove" aria-label="Remove" onclick={() => app.removePdu(p.id)}><Icon name="close" size={14} /></button>
        </div>
      {/each}
    </div>
  {:else}
    <p class="muted tip">Use the Ping tool (P) and click two devices to send a test packet.</p>
  {/if}
</aside>

<style>
  .insp {
    width: 290px;
    flex: none;
    background: var(--surface);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-left: 0.5px solid var(--separator);
    padding: 14px 12px 20px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .hn {
    min-width: 0;
    flex: 1;
  }
  .namefield {
    all: unset;
    font: 600 16px var(--font-display);
    width: 100%;
    border-radius: 5px;
    padding: 1px 4px;
    margin-left: -4px;
    user-select: text;
  }
  .namefield:hover {
    background: var(--fill);
  }
  .namefield:focus {
    background: var(--control);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 12px;
    flex-wrap: wrap;
  }
  .field.sm {
    width: 130px;
    height: 24px;
    font-size: 12px;
  }
  .btn.sm {
    height: 24px;
  }
  .btn.icon.sm {
    width: 24px;
  }
  .ports .row {
    min-height: 28px;
    padding: 3px 12px;
  }
  .pn {
    font-weight: 500;
  }
  .peer,
  .small {
    font-size: 11px;
  }
  .block {
    display: block;
  }
  .multi h3 {
    font: 600 16px var(--font-display);
    margin: 0 0 10px;
  }
  .tip {
    font-size: 12px;
    margin: 10px 4px;
  }
  .pduh {
    display: flex;
    justify-content: space-between;
    margin-top: 22px;
  }
  .linkbtn {
    all: unset;
    color: var(--accent);
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
  }
  .pdu .label {
    display: flex;
    flex-direction: column;
  }
</style>
