<script lang="ts">
  import { app } from "../state.svelte";
  import type { Host } from "../../engine/devices/host";

  let { host }: { host: Host } = $props();
  let name = $state("");
  $effect(() => {
    name = host.hostname;
  });
  const adminUp = $derived((app.tick, host.nic.adminUp));
</script>

<div class="pad scroll">
  <h3>General</h3>
  <div class="group">
    <div class="row"><span class="label">Display name</span><input class="field" bind:value={name} /><button class="btn" onclick={() => { app.checkpoint(); host.hostname = name.trim() || host.hostname; app.markDirty(); app.bump(); }}>Set</button></div>
    <div class="row"><span class="label">Model</span><span class="value">{host.model}</span></div>
  </div>
  <h3>Interface {host.nic.name}</h3>
  <div class="group">
    <div class="row"><span class="label">Port enabled</span><input type="checkbox" class="switch" checked={adminUp} onchange={(e) => { host.nic.adminUp = (e.target as HTMLInputElement).checked; if (host.nic.link) app.net.linkChanged(host.nic.link); app.markDirty(); app.bump(); }} /></div>
    <div class="row"><span class="label">MAC address</span><span class="value mono">{host.nic.mac}</span></div>
    <div class="row"><span class="label">Bandwidth</span><span class="value">{host.nic.speed} Mbps, full duplex</span></div>
    <div class="row"><span class="label">Addressing</span><span class="value">{(app.tick, host.ipConfig.mode === "dhcp" ? "DHCP" : "Static")} · {(app.tick, host.active.ip || "no address")}</span></div>
  </div>
  <p class="muted small">Change the IP address in Desktop → IP Configuration or in the inspector.</p>
</div>

<style>
  .pad {
    padding: 4px 18px 18px;
  }
  h3 {
    font: 600 14px var(--font-display);
    margin: 14px 2px 8px;
  }
  .small {
    font-size: 12px;
  }
</style>
