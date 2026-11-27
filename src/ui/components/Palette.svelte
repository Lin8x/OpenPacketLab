<script lang="ts">
  import { app } from "../state.svelte";
  import { actions } from "../actions";
  import { mod } from "../platform";
  import Icon from "./Icon.svelte";

  let q = $state("");
  let idx = $state(0);
  const all = actions();
  const devices = $derived((app.tick, [...app.net.devices.values()]));
  const items = $derived.by(() => {
    const s = q.toLowerCase().trim();
    const acts = all.filter((a) => !s || `${a.group} ${a.title}`.toLowerCase().includes(s));
    const devs = devices
      .filter((d) => !s || `${d.hostname} ${d.model}`.toLowerCase().includes(s))
      .map((d) => ({ id: "dev-" + d.id, title: `Open ${d.hostname}`, group: d.model, icon: "chevronRight", shortcut: undefined, run: () => { app.selection = new Set([d.id]); app.openWindow(d.id); } }));
    return [...(s ? devs : []), ...acts].slice(0, 60);
  });

  function run(i: number) {
    const it = items[i];
    if (!it) return;
    app.palette = false;
    it.run();
  }

  function key(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      idx = Math.min(items.length - 1, idx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      idx = Math.max(0, idx - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(idx);
    } else if (e.key === "Escape") app.palette = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && (app.palette = false)}>
  <div class="pal" role="dialog" aria-label="Command palette">
    <div class="in">
      <Icon name="search" size={17} />
      <!-- svelte-ignore a11y_autofocus -->
      <input autofocus placeholder="Search commands and devices" bind:value={q} oninput={() => (idx = 0)} onkeydown={key} />
    </div>
    <div class="res scroll">
      {#each items as it, i (it.id)}
        <button class:on={i === idx} onmouseenter={() => (idx = i)} onclick={() => run(i)}>
          <Icon name={it.icon ?? "chevronRight"} size={15} />
          <span class="t">{it.title}</span>
          <span class="g">{it.group}</span>
          {#if it.shortcut}<kbd>{mod}{it.shortcut}</kbd>{/if}
        </button>
      {:else}
        <div class="muted none">No matches</div>
      {/each}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 1100;
    display: grid;
    place-items: start center;
    padding-top: 14vh;
    background: rgba(0, 0, 0, 0.12);
  }
  .pal {
    width: min(600px, 92vw);
    background: var(--surface);
    backdrop-filter: saturate(180%) blur(30px);
    -webkit-backdrop-filter: saturate(180%) blur(30px);
    border-radius: 14px;
    box-shadow: var(--shadow), 0 30px 80px rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }
  .in {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    height: 52px;
    border-bottom: 0.5px solid var(--separator);
    color: var(--secondary);
  }
  .in input {
    flex: 1;
    border: none;
    background: none;
    outline: none;
    font-size: 17px;
    color: var(--label);
  }
  .res {
    max-height: 50vh;
    padding: 6px;
  }
  .res button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 10px;
    width: calc(100% - 20px);
    padding: 7px 10px;
    border-radius: 7px;
  }
  .res button.on {
    background: var(--accent);
    color: #fff;
  }
  .res button.on .g,
  .res button.on kbd {
    color: rgba(255, 255, 255, 0.8);
    background: transparent;
  }
  .t {
    flex: 1;
  }
  .g {
    font-size: 11px;
    color: var(--secondary);
  }
  .none {
    padding: 14px;
  }
</style>
