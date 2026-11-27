<script lang="ts">
  import { app } from "../state.svelte";
  import type { Host } from "../../engine/devices/host";
  import { IosDevice } from "../../engine/devices/ios";
  import { browse } from "../../engine/cli/hostcmd";
  import { isValidIp, isValidMask } from "../../engine/addr";
  import Icon from "./Icon.svelte";
  import Terminal from "./Terminal.svelte";

  let { host }: { host: Host } = $props();
  let appId = $state<null | "ip" | "cmd" | "web" | "term">(null);

  const apps = [
    { id: "ip", name: "IP Configuration", icon: "network", color: "#007aff" },
    { id: "cmd", name: "Command Prompt", icon: "terminal", color: "#1d1d1f" },
    { id: "web", name: "Web Browser", icon: "globe", color: "#34c759" },
    { id: "term", name: "Terminal", icon: "keyboard", color: "#5856d6" },
  ] as const;

  // IP configuration
  let form = $state({ mode: "static" as "static" | "dhcp", ip: "", mask: "", gateway: "", dns: "" });
  $effect(() => {
    form = { ...host.ipConfig };
  });
  function apply() {
    if (form.mode === "static") {
      for (const [k, v] of Object.entries(form)) {
        if (k === "mode" || !v) continue;
        if (k === "mask" ? !isValidMask(v) : !isValidIp(v)) return app.toast(`The ${k === "ip" ? "IP address" : k} is not valid.`, "error");
      }
    }
    app.checkpoint();
    host.ipConfig = { ...form };
    host.applyConfig();
    app.markDirty();
    app.bump();
    app.toast("IP configuration applied.", "success");
  }

  // Browser
  let url = $state("");
  let page = $state<{ html: string; title: string; error?: string } | null>(null);
  let loading = $state(false);
  let history: string[] = [];

  function sanitize(html: string, base: string): { html: string; title: string } {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const allowed = new Set(["H1", "H2", "H3", "H4", "P", "A", "UL", "OL", "LI", "B", "I", "STRONG", "EM", "BR", "HR", "TABLE", "TR", "TD", "TH", "THEAD", "TBODY", "DIV", "SPAN", "PRE", "CODE", "BLOCKQUOTE", "SMALL"]);
    const walk = (n: Node): string => {
      if (n.nodeType === 3) return (n.textContent ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
      if (n.nodeType !== 1) return "";
      const el = n as Element;
      const inner = [...el.childNodes].map(walk).join("");
      if (!allowed.has(el.tagName)) return inner;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") {
        const href = el.getAttribute("href") ?? "";
        return `<a data-href="${href.replace(/"/g, "&quot;")}" href="#">${inner}</a>`;
      }
      return `<${tag}>${inner}</${tag}>`;
    };
    void base;
    return { html: walk(doc.body), title: doc.title || "" };
  }

  function go(target = url, push = true) {
    if (!target.trim()) return;
    url = target;
    loading = true;
    browse(host, target, (r) => {
      loading = false;
      if (push) history.push(target);
      if (!r.ok && !r.body) page = { html: "", title: "", error: r.error ?? `HTTP ${r.status}` };
      else page = sanitize(r.body, target);
    });
    app.bump();
  }

  function onPageClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a[data-href]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const href = a.dataset.href ?? "";
    if (/^https?:\/\//i.test(href)) return go(href);
    const m = url.match(/^(https?:\/\/)?([^/]+)/i);
    go(`${m?.[1] ?? "http://"}${m?.[2] ?? ""}/${href.replace(/^\/+/, "")}`);
  }

  // Terminal over a console cable
  const consoleTarget = $derived.by(() => {
    void app.tick;
    const link = host.nic.link;
    if (!link || link.cable !== "console") return undefined;
    const peer = link.other(host.nic).device;
    return peer instanceof IosDevice ? peer : undefined;
  });
</script>

<div class="desk">
  {#if !appId}
    <div class="grid">
      {#each apps as a}
        <button class="app" onclick={() => (appId = a.id)}>
          <span class="ic" style="background:{a.color}"><Icon name={a.icon} size={28} stroke={1.8} /></span>
          <span>{a.name}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="apphead">
      <button class="btn plain" onclick={() => (appId = null)}><Icon name="chevronRight" size={14} stroke={2.2} />Desktop</button>
      <span class="at">{apps.find((a) => a.id === appId)?.name}</span>
    </div>
    <div class="appbody">
      {#if appId === "ip"}
        <div class="pad scroll">
          <div class="group">
            <div class="row"><span class="label">Configuration</span>
              <div class="segmented">
                <button class:on={form.mode === "dhcp"} onclick={() => (form.mode = "dhcp")}>DHCP</button>
                <button class:on={form.mode === "static"} onclick={() => (form.mode = "static")}>Static</button>
              </div>
            </div>
            {#each [["ip", "IPv4 address"], ["mask", "Subnet mask"], ["gateway", "Default gateway"], ["dns", "DNS server"]] as [k, label]}
              <div class="row"><span class="label">{label}</span>
                {#if form.mode === "static"}
                  <input class="field mono" bind:value={form[k as "ip"]} placeholder="0.0.0.0" />
                {:else}
                  <span class="value mono">{(app.tick, host.active[k as "ip"] || "—")}</span>
                {/if}
              </div>
            {/each}
            {#if form.mode === "dhcp"}<div class="row muted">{(app.tick, host.dhcpStatus)}</div>{/if}
          </div>
          <div class="btns">
            {#if form.mode === "dhcp"}<button class="btn" onclick={() => host.renew()}>Renew lease</button>{/if}
            <button class="btn primary" onclick={apply}>Apply</button>
          </div>
          <div class="group" style="margin-top:14px">
            <div class="row"><span class="label">MAC address</span><span class="value mono">{host.nic.mac}</span></div>
            <div class="row"><span class="label">Link</span><span class="value">{(app.tick, host.nic.isUp ? "Connected" : "Disconnected")}</span></div>
          </div>
        </div>
      {:else if appId === "cmd"}
        <Terminal session={app.promptFor(host)} />
      {:else if appId === "web"}
        <div class="browser">
          <form class="urlbar" onsubmit={(e) => { e.preventDefault(); go(); }}>
            <button type="button" class="btn plain icon" aria-label="Back" disabled={history.length < 2} onclick={() => { history.pop(); const prev = history.pop(); if (prev) go(prev); }}><Icon name="undo" size={15} /></button>
            <input class="field" bind:value={url} placeholder="Enter a name or address, e.g. intranet.lab" aria-label="Address" />
            <button class="btn primary" type="submit">{loading ? "Loading…" : "Go"}</button>
          </form>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="page scroll" onclick={onPageClick}>
            {#if loading}<div class="muted">Connecting… {app.mode === "simulation" ? "Step the simulation to deliver the request." : ""}</div>
            {:else if page?.error}<div class="err"><h2>Can't open this page</h2><p class="muted">{page.error}</p></div>
            {:else if page}<div class="doc">{@html page.html}</div>
            {:else}<div class="muted">Type an address above. Pages come from simulated web servers in this lab.</div>{/if}
          </div>
        </div>
      {:else if appId === "term"}
        {#if consoleTarget}
          <Terminal session={app.cliFor(consoleTarget)} />
        {:else}
          <div class="pad muted">Connect this computer's port to a router or switch Console port with a console cable to use the terminal.</div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .desk {
    display: flex;
    flex-direction: column;
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 16%, var(--window)), var(--window) 60%);
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 22px;
    padding: 28px;
    align-content: flex-start;
  }
  .app {
    all: unset;
    width: 96px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
    font-size: 12px;
    font-weight: 500;
    padding: 8px 4px;
    border-radius: 10px;
  }
  .app:hover {
    background: var(--fill);
  }
  .ic {
    width: 56px;
    height: 56px;
    border-radius: 14px;
    display: grid;
    place-items: center;
    color: #fff;
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.2);
  }
  .apphead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--surface);
    border-bottom: 0.5px solid var(--separator);
  }
  .apphead :global(svg) {
    transform: rotate(180deg);
  }
  .at {
    font-weight: 600;
  }
  .appbody {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--window);
  }
  .appbody > :global(*) {
    flex: 1;
    min-height: 0;
  }
  .pad {
    padding: 16px;
    max-width: 560px;
  }
  .pad .field {
    width: 180px;
  }
  .btns {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
  .browser {
    display: flex;
    flex-direction: column;
  }
  .urlbar {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-bottom: 0.5px solid var(--separator);
  }
  .urlbar .field {
    flex: 1;
  }
  .page {
    flex: 1;
    background: #fff;
    color: #1d1d1f;
    padding: 18px 22px;
    user-select: text;
  }
  .doc :global(a) {
    color: #0066cc;
  }
  .err h2 {
    font: 600 18px var(--font-display);
  }
</style>
