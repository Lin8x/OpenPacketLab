<script lang="ts">
  import { app } from "../state.svelte";
  import Icon from "./Icon.svelte";
  const time = $derived((app.tick, app.net.time));
  function fmt(ms: number) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
</script>

<footer class="status">
  {#if app.mode === "realtime"}
    <button class="btn plain sm" onclick={() => (app.paused = !app.paused)} title={app.paused ? "Resume time" : "Pause time"}>
      <Icon name={app.paused ? "play" : "pause"} size={14} />{app.paused ? "Paused" : "Realtime"}
    </button>
    <span class="mono clock">{fmt(time)}</span>
    <button class="btn plain sm" onclick={() => app.fastForward()} title="Move time forward 30 seconds (spanning tree, DHCP, routing convergence)"><Icon name="forward" size={14} />Fast forward</button>
  {:else}
    <span class="muted">Simulation mode: time only moves when you step or play.</span>
  {/if}
  <span class="spacer"></span>
  {#if app.tool === "connect"}<span class="muted">Connect: {app.cable === "auto" ? "automatic cable" : app.cable}</span>{/if}
  {#if app.pendingConnect}<span class="tag">Choose the second device</span>{/if}
  {#if app.pendingPdu}<span class="tag">Choose the destination</span>{/if}
  {#if app.net.stormWarning}<span class="warn"><Icon name="warning" size={14} />Broadcast storm detected</span>{/if}
  <span class="muted">{(app.tick, app.net.devices.size)} devices · {Math.round(app.view.zoom * 100)}%</span>
</footer>

<style>
  .status {
    height: 28px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px;
    font-size: 12px;
    background: var(--surface-solid);
    border-top: 0.5px solid var(--separator);
  }
  .btn.sm {
    height: 22px;
    padding: 0 8px;
    font-size: 12px;
  }
  .clock {
    font-variant-numeric: tabular-nums;
  }
  .spacer {
    flex: 1;
  }
  .warn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--red);
    font-weight: 500;
  }
</style>
