<script lang="ts">
  import { app } from "../state.svelte";
  import type { Device } from "../../engine/network";
  import Icon from "./Icon.svelte";

  let { dev }: { dev: Device } = $props();
  const ports = $derived((app.tick, dev.ports));
  const LED: Record<string, string> = { green: "#30d158", amber: "#ff9f0a", red: "#ff453a", off: "#3a3a3c" };
</script>

<div class="phys scroll">
  <div class="panel">
    <div class="chassis">
      <button class="pwr" class:on={dev.powered} title={dev.powered ? "Power off" : "Power on"} aria-label="Power" onclick={() => { dev.setPower(!dev.powered); app.markDirty(); app.bump(); }}><Icon name="power" size={16} stroke={2.2} /></button>
      <div class="brand"><b>{dev.model}</b><span>OpenPacketLab</span></div>
      <div class="ports">
        {#each ports as p}
          <div class="port" title="{p.name}: {p.link ? 'connected' : 'empty'}">
            <span class="led" style="background:{dev.powered ? LED[p.light] : LED.off}"></span>
            <span class="jack" class:serial={p.media === "serial"} class:fiber={p.media === "fiber"} class:console={p.media === "console"} class:used={!!p.link}></span>
            <span class="pl">{p.short}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
  <table class="list">
    <thead><tr><th>Port</th><th>Media</th><th>Speed</th><th>MAC</th><th>Connected to</th></tr></thead>
    <tbody>
      {#each ports as p}
        <tr>
          <td>{p.name}</td>
          <td>{p.media}</td>
          <td>{p.media === "console" ? "9600 baud" : p.media === "serial" ? "1.544 Mbps" : `${p.speed} Mbps`}</td>
          <td class="mono">{p.media === "console" ? "" : p.mac}</td>
          <td>{p.peer ? `${p.peer.device.hostname} ${p.peer.name}` : ""}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .phys {
    padding: 16px;
  }
  .panel {
    margin-bottom: 16px;
  }
  .chassis {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    border-radius: 10px;
    background: linear-gradient(#4a4f57, #2d3138);
    color: #e5e5ea;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15), var(--shadow-sm);
  }
  .pwr {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: none;
    background: #1c1c1e;
    color: #8e8e93;
    display: grid;
    place-items: center;
    flex: none;
  }
  .pwr.on {
    color: #30d158;
    box-shadow: 0 0 8px rgba(48, 209, 88, 0.5);
  }
  .brand {
    display: flex;
    flex-direction: column;
    font-size: 11px;
    min-width: 110px;
  }
  .brand span {
    opacity: 0.6;
  }
  .ports {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .port {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    width: 30px;
  }
  .led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .jack {
    width: 22px;
    height: 16px;
    border-radius: 2px;
    background: #111;
    border: 1px solid #000;
    box-shadow: inset 0 -4px 0 #2a2a2a;
  }
  .jack.used {
    box-shadow: inset 0 -4px 0 #4c8bf5;
  }
  .jack.serial {
    border-radius: 6px 6px 3px 3px;
    background: #2b2b6b;
  }
  .jack.fiber {
    width: 16px;
    background: #222;
  }
  .jack.console {
    background: #3d6fb6;
  }
  .pl {
    font-size: 8.5px;
    opacity: 0.75;
    white-space: nowrap;
  }
</style>
