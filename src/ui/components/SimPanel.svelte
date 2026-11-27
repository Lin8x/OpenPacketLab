<script lang="ts">
  import { app, ALL_PROTOCOLS } from "../state.svelte";
  import { describeLayers } from "../../engine/packets";
  import Icon from "./Icon.svelte";

  let showFilters = $state(false);
  let height = $state(260);
  let listEl: HTMLDivElement | undefined = $state();

  const events = $derived(app.events);
  const selected = $derived(events.find((e) => e.id === app.selectedEvent));
  const layers = $derived(selected?.tx ? describeLayers(selected.tx.frame) : selected?.drop ? describeLayers(selected.drop.frame) : []);

  $effect(() => {
    void events.length;
    if (listEl && listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80) listEl.scrollTop = listEl.scrollHeight;
  });

  function name(id: string) {
    return app.device(id)?.hostname ?? "—";
  }

  function toggle(p: string) {
    const s = new Set(app.filters);
    if (s.has(p)) s.delete(p);
    else s.add(p);
    app.filters = s;
  }

  function resize(e: PointerEvent) {
    const y0 = e.clientY;
    const h0 = height;
    const move = (ev: PointerEvent) => (height = Math.max(140, Math.min(window.innerHeight - 200, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<section class="sim" style:height="{height}px" aria-label="Simulation">
  <div class="grip" onpointerdown={resize} role="separator" aria-orientation="horizontal"></div>
  <div class="bar">
    <div class="ctl">
      <button class="btn plain icon" title="Reset simulation" aria-label="Reset simulation" onclick={() => app.resetSimulation()}><Icon name="reset" /></button>
      <button class="btn primary icon play" title={app.playing ? "Pause" : "Play"} aria-label={app.playing ? "Pause" : "Play"} onclick={() => (app.playing = !app.playing)}><Icon name={app.playing ? "pause" : "play"} fill={!app.playing} /></button>
      <button class="btn plain icon" title="Step forward (Space)" aria-label="Step forward" onclick={() => app.step()}><Icon name="step" /></button>
      <label class="speed" title="Playback speed">
        <Icon name="forward" size={14} />
        <input type="range" min="0.25" max="4" step="0.25" bind:value={app.speed} aria-label="Playback speed" />
        <span class="mono">{app.speed}×</span>
      </label>
    </div>
    <div class="time mono">{(app.tick, (app.net.time / 1000).toFixed(3))} s</div>
    <div class="ctl">
      <span class="muted">{events.length} events</span>
      <div class="fwrap">
        <button class="btn" onclick={() => (showFilters = !showFilters)}><Icon name="filter" size={15} />Protocols ({app.filters.size})</button>
        {#if showFilters}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="scrim" onclick={() => (showFilters = false)}></div>
          <div class="filters">
            <div class="fh">
              <button class="linkbtn" onclick={() => (app.filters = new Set(ALL_PROTOCOLS))}>All</button>
              <button class="linkbtn" onclick={() => (app.filters = new Set())}>None</button>
            </div>
            <div class="fgrid">
              {#each ALL_PROTOCOLS as p}
                <label><input type="checkbox" checked={app.filters.has(p)} onchange={() => toggle(p)} />{p}</label>
              {/each}
            </div>
            <p class="muted small">Hidden protocols still run; they are just skipped when stepping.</p>
          </div>
        {/if}
      </div>
    </div>
  </div>
  <div class="body">
    <div class="list scroll" bind:this={listEl}>
      {#if events.length}
        <table class="list">
          <thead><tr><th>Time (s)</th><th>From</th><th>To</th><th>Type</th><th>Info</th></tr></thead>
          <tbody>
            {#each events as e (e.id)}
              <tr class:sel={app.selectedEvent === e.id} onclick={() => (app.selectedEvent = e.id)}>
                <td class="mono">{(e.time / 1000).toFixed(3)}</td>
                <td>{name(e.from)}</td>
                <td>{e.status === "dropped" ? "✕ dropped" : name(e.to)}</td>
                <td><span class="proto">{e.proto}</span></td>
                <td class="info" title={e.info}>{e.info}{e.status === "lost" ? " (lost: link down)" : ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <div class="emptyl muted">
          <p><b>Simulation mode</b> pauses time so you can follow every frame.</p>
          <p>Send a ping with the Ping tool, or run a command on a device, then press <kbd>Space</kbd> or ▶ to step through the events.</p>
        </div>
      {/if}
    </div>
    <div class="pdu scroll">
      {#if selected}
        <div class="pduhead">
          <span class="proto">{selected.proto}</span>
          <span class="muted">{name(selected.from)}{selected.status === "dropped" ? "" : ` → ${name(selected.to)}`}</span>
        </div>
        {#if selected.status === "dropped"}<div class="drop"><Icon name="warning" size={15} />{selected.info}</div>{/if}
        {#each layers as l}
          <div class="layer">
            <div class="lt"><span>{l.title}</span><span class="muted small">{l.layer}</span></div>
            {#each l.fields as [k, v]}
              <div class="kv"><span class="muted">{k}</span><span class="mono v">{v}</span></div>
            {/each}
          </div>
        {/each}
      {:else}
        <div class="emptyl muted">Select an event to inspect the packet layer by layer.</div>
      {/if}
    </div>
  </div>
</section>

<style>
  .sim {
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--surface-solid);
    border-top: 0.5px solid var(--separator);
    position: relative;
  }
  .grip {
    position: absolute;
    top: -3px;
    left: 0;
    right: 0;
    height: 6px;
    cursor: ns-resize;
    z-index: 2;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 0.5px solid var(--separator);
    gap: 10px;
  }
  .ctl {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .play {
    border-radius: 50%;
    width: 30px;
    height: 30px;
  }
  .speed {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
    color: var(--secondary);
  }
  .speed input {
    width: 90px;
    accent-color: var(--accent);
  }
  .time {
    font-size: 15px;
    font-weight: 500;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .list {
    flex: 1.6;
    min-width: 0;
  }
  .list tr {
    cursor: default;
  }
  .info {
    max-width: 480px;
  }
  .proto {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--fill);
  }
  tr.sel .proto {
    background: rgba(255, 255, 255, 0.25);
  }
  .pdu {
    flex: 1;
    min-width: 260px;
    border-left: 0.5px solid var(--separator);
    padding: 10px 12px;
  }
  .pduhead {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }
  .layer {
    background: var(--elevated);
    border-radius: 8px;
    box-shadow: var(--shadow-sm);
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  .lt {
    display: flex;
    justify-content: space-between;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .kv {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
    padding: 1px 0;
  }
  .v {
    text-align: right;
    word-break: break-all;
    user-select: text;
    white-space: pre-wrap;
  }
  .drop {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--red);
    margin-bottom: 8px;
    font-weight: 500;
  }
  .emptyl {
    padding: 16px;
    max-width: 520px;
  }
  .fwrap {
    position: relative;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
  }
  .filters {
    position: absolute;
    right: 0;
    bottom: 36px;
    z-index: 31;
    width: 280px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--elevated);
    box-shadow: var(--shadow);
  }
  .fh {
    display: flex;
    gap: 12px;
    margin-bottom: 8px;
  }
  .fgrid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 4px 8px;
  }
  .fgrid label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
  }
  .linkbtn {
    all: unset;
    color: var(--accent);
    font-weight: 500;
  }
  .small {
    font-size: 11px;
  }
</style>
