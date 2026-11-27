<script lang="ts">
  import { app, LIBRARY, type CableChoice } from "../state.svelte";
  import { CABLE_LABEL } from "../../engine/network";
  import DeviceGlyph from "./DeviceGlyph.svelte";
  import Icon from "./Icon.svelte";

  let query = $state("");
  const cats = ["Routers", "Switches", "Hubs", "End Devices"] as const;
  const filtered = $derived(LIBRARY.filter((t) => !query || `${t.label} ${t.description} ${t.category}`.toLowerCase().includes(query.toLowerCase())));
  let collapsed = $state<Record<string, boolean>>({});

  const cables: { id: CableChoice; label: string; color: string; dash?: string }[] = [
    { id: "auto", label: "Automatic", color: "var(--accent)" },
    { id: "straight", label: CABLE_LABEL.straight, color: "#3a3a3c" },
    { id: "crossover", label: CABLE_LABEL.crossover, color: "#3a3a3c", dash: "5 3" },
    { id: "fiber", label: CABLE_LABEL.fiber, color: "#ff9500" },
    { id: "serial", label: CABLE_LABEL.serial, color: "#ff3b30" },
    { id: "console", label: CABLE_LABEL.console, color: "#5ac8fa" },
  ];

  function dragStart(e: DragEvent, i: number) {
    e.dataTransfer?.setData("application/x-opl-device", String(i));
    e.dataTransfer!.effectAllowed = "copy";
  }
</script>

<aside class="lib" aria-label="Device library">
  <div class="search">
    <Icon name="search" size={14} />
    <input placeholder="Search devices" bind:value={query} aria-label="Search devices" />
  </div>
  <div class="scroll body">
    {#each cats as c}
      {@const items = filtered.filter((t) => t.category === c)}
      {#if items.length}
        <button class="cat" onclick={() => (collapsed[c] = !collapsed[c])} aria-expanded={!collapsed[c]}>
          <span class="chev" class:closed={collapsed[c]}><Icon name="chevronDown" size={12} stroke={2.2} /></span>{c}
        </button>
        {#if !collapsed[c]}
          <div class="items">
            {#each items as t}
              {@const i = LIBRARY.indexOf(t)}
              <button
                class="item"
                class:on={app.placing === t}
                draggable="true"
                ondragstart={(e) => dragStart(e, i)}
                onclick={() => {
                  app.placing = app.placing === t ? null : t;
                  app.tool = "select";
                }}
                title={t.description}
              >
                <DeviceGlyph kind={t.kind} size={34} />
                <span class="txt"><span class="nm">{t.label}</span><span class="ds">{t.description}</span></span>
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    {/each}

    <button class="cat" onclick={() => (collapsed.cables = !collapsed.cables)} aria-expanded={!collapsed.cables}>
      <span class="chev" class:closed={collapsed.cables}><Icon name="chevronDown" size={12} stroke={2.2} /></span>Connections
    </button>
    {#if !collapsed.cables}
      <div class="items">
        {#each cables as c}
          <button class="item cable" class:on={app.tool === "connect" && app.cable === c.id} onclick={() => { app.cable = c.id; app.tool = "connect"; app.pendingConnect = null; }}>
            <svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true"><path d="M3 18 C 12 18, 22 4, 31 4" stroke={c.color} stroke-width="2.6" fill="none" stroke-dasharray={c.dash} stroke-linecap="round" />{#if c.id === "auto"}<path d="M24 14l2 2 4-5" stroke={c.color} stroke-width="2" fill="none" stroke-linecap="round" />{/if}</svg>
            <span class="txt"><span class="nm">{c.label}</span>{#if c.id === "auto"}<span class="ds">Picks the right cable and ports</span>{/if}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <div class="hint muted">
    {#if app.placing}Click on the canvas to place {app.placing.label}. Press Esc to stop.{:else if app.tool === "connect"}Click a device, then another device to connect them.{:else}Drag a device onto the canvas, or click it and then click where it should go.{/if}
  </div>
</aside>

<style>
  .lib {
    width: 250px;
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-right: 0.5px solid var(--separator);
  }
  .search {
    margin: 10px 10px 6px;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border-radius: 7px;
    background: var(--fill);
    color: var(--secondary);
  }
  .search input {
    border: none;
    background: transparent;
    outline: none;
    flex: 1;
    min-width: 0;
    color: var(--label);
    user-select: text;
  }
  .body {
    flex: 1;
    padding: 0 8px 10px;
  }
  .cat {
    all: unset;
    display: flex;
    align-items: center;
    gap: 4px;
    width: calc(100% - 8px);
    margin: 12px 4px 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--secondary);
  }
  .chev {
    display: inline-flex;
    transition: transform 0.15s;
  }
  .chev.closed {
    transform: rotate(-90deg);
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .item {
    all: unset;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-radius: 7px;
  }
  .item:hover {
    background: var(--fill);
  }
  .item.on {
    background: var(--accent);
    color: #fff;
  }
  .item.on .ds {
    color: rgba(255, 255, 255, 0.8);
  }
  .txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .nm {
    font-weight: 500;
  }
  .ds {
    font-size: 11px;
    color: var(--secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 170px;
  }
  .hint {
    font-size: 11px;
    padding: 10px 14px;
    border-top: 0.5px solid var(--separator);
  }
</style>
