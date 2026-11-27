<script lang="ts">
  import { app } from "../state.svelte";
  import type { Host } from "../../engine/devices/host";
  import { isValidIp, isValidMask } from "../../engine/addr";

  let { host }: { host: Host } = $props();
  let tab = $state<"http" | "dns" | "dhcp" | "syslog">("http");
  const s = $derived(host.services!);
  let file = $state("index.html");
  let newFile = $state("");
  let rec = $state({ name: "", type: "A" as "A" | "CNAME", value: "" });

  function changed() {
    host.syncServices();
    app.markDirty();
    app.bump();
  }
</script>

<div class="svc">
  <nav class="side">
    {#each [["http", "HTTP / HTTPS"], ["dns", "DNS"], ["dhcp", "DHCP"], ["syslog", "Syslog"]] as [id, label]}
      <button class:on={tab === id} onclick={() => (tab = id as typeof tab)}>
        <span class="dot" style="background:{(app.tick, s[id as "http"].enabled) ? 'var(--green)' : 'var(--fill-strong)'}"></span>{label}
      </button>
    {/each}
  </nav>
  <div class="pane scroll">
    {#if tab === "http"}
      <div class="group">
        <div class="row"><span class="label">HTTP (port 80)</span><input type="checkbox" class="switch" bind:checked={s.http.enabled} onchange={changed} /></div>
        <div class="row"><span class="label">HTTPS (port 443)</span><input type="checkbox" class="switch" bind:checked={s.http.https} onchange={changed} /></div>
      </div>
      <div class="files">
        <select class="field" bind:value={file}>
          {#each Object.keys(s.http.files) as f}<option>{f}</option>{/each}
        </select>
        <input class="field" placeholder="new-page.html" bind:value={newFile} />
        <button class="btn" disabled={!newFile.trim()} onclick={() => { s.http.files[newFile.trim()] = "<html><body><h1>New page</h1></body></html>"; file = newFile.trim(); newFile = ""; changed(); }}>Add</button>
        <button class="btn danger" disabled={file === "index.html"} onclick={() => { delete s.http.files[file]; file = "index.html"; changed(); }}>Delete</button>
      </div>
      <textarea class="field mono editor" bind:value={s.http.files[file]} oninput={changed}></textarea>
    {:else if tab === "dns"}
      <div class="group">
        <div class="row"><span class="label">DNS service</span><input type="checkbox" class="switch" bind:checked={s.dns.enabled} onchange={changed} /></div>
      </div>
      <table class="list" style="margin-top:12px">
        <thead><tr><th>Name</th><th>Type</th><th>Value</th><th></th></tr></thead>
        <tbody>
          {#each s.dns.records as r, i}
            <tr><td>{r.name}</td><td>{r.type}</td><td class="mono">{r.value}</td><td><button class="btn plain danger" onclick={() => { s.dns.records.splice(i, 1); changed(); }}>Remove</button></td></tr>
          {:else}
            <tr><td colspan="4" class="muted">No records yet.</td></tr>
          {/each}
        </tbody>
      </table>
      <div class="files">
        <input class="field" placeholder="www.example.lab" bind:value={rec.name} />
        <select class="field" bind:value={rec.type}><option>A</option><option>CNAME</option></select>
        <input class="field mono" placeholder={rec.type === "A" ? "10.0.0.10" : "example.lab"} bind:value={rec.value} />
        <button class="btn primary" disabled={!rec.name || (rec.type === "A" ? !isValidIp(rec.value) : !rec.value)} onclick={() => { s.dns.records.push({ ...rec }); rec = { name: "", type: "A", value: "" }; changed(); }}>Add</button>
      </div>
    {:else if tab === "dhcp"}
      <div class="group">
        <div class="row"><span class="label">DHCP service</span><input type="checkbox" class="switch" bind:checked={s.dhcp.enabled} onchange={changed} /></div>
      </div>
      {#each s.dhcp.pools as p}
        <h4>Pool {p.name}</h4>
        <div class="group">
          <div class="row"><span class="label">Default gateway</span><input class="field mono" bind:value={p.defaultRouter} class:invalid={!isValidIp(p.defaultRouter)} onchange={changed} /></div>
          <div class="row"><span class="label">DNS server</span><input class="field mono" bind:value={p.dns} class:invalid={!isValidIp(p.dns)} onchange={changed} /></div>
          <div class="row"><span class="label">Start address</span><input class="field mono" bind:value={p.start} class:invalid={!isValidIp(p.start)} onchange={changed} /></div>
          <div class="row"><span class="label">Subnet mask</span><input class="field mono" bind:value={p.mask} class:invalid={!isValidMask(p.mask)} onchange={changed} /></div>
          <div class="row"><span class="label">Maximum users</span><input class="field" type="number" min="1" max="1000" bind:value={p.max} onchange={changed} /></div>
        </div>
      {/each}
      <h4>Leases</h4>
      <table class="list">
        <thead><tr><th>IP address</th><th>MAC address</th></tr></thead>
        <tbody>
          {#each (app.tick, [...(host.dhcpServer?.bindings.values() ?? [])]) as b}<tr><td class="mono">{b.ip}</td><td class="mono">{b.mac}</td></tr>{:else}<tr><td colspan="2" class="muted">No leases.</td></tr>{/each}
        </tbody>
      </table>
    {:else}
      <div class="group">
        <div class="row"><span class="label">Syslog service (UDP 514)</span><input type="checkbox" class="switch" bind:checked={s.syslog.enabled} onchange={changed} /></div>
      </div>
      <table class="list" style="margin-top:12px">
        <thead><tr><th>Time</th><th>From</th><th>Message</th></tr></thead>
        <tbody>
          {#each (app.tick, s.syslog.entries) as e}<tr><td class="mono">{(e.time / 1000).toFixed(1)}</td><td class="mono">{e.from}</td><td>{e.text}</td></tr>{:else}<tr><td colspan="3" class="muted">No messages received.</td></tr>{/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .svc {
    display: flex;
    min-height: 0;
  }
  .side {
    width: 170px;
    flex: none;
    padding: 10px 8px;
    border-right: 0.5px solid var(--separator);
    background: var(--surface);
  }
  .side button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 7px;
    width: calc(100% - 16px);
    padding: 5px 8px;
    border-radius: 6px;
  }
  .side button:hover {
    background: var(--fill);
  }
  .side button.on {
    background: var(--accent);
    color: #fff;
  }
  .pane {
    flex: 1;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
  }
  .files {
    display: flex;
    gap: 6px;
    margin: 12px 0 8px;
  }
  .files .field {
    flex: 1;
  }
  .editor {
    flex: 1;
    min-height: 180px;
    font-size: 12px;
  }
  h4 {
    margin: 14px 2px 6px;
    font-weight: 600;
  }
  .row .field {
    width: 170px;
  }
</style>
