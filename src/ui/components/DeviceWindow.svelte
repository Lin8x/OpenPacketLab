<script lang="ts">
  import { app, type DeviceWindowState } from "../state.svelte";
  import { Host } from "../../engine/devices/host";
  import { IosDevice } from "../../engine/devices/ios";
  import DeviceGlyph from "./DeviceGlyph.svelte";
  import Icon from "./Icon.svelte";
  import Terminal from "./Terminal.svelte";
  import IosConfig from "./IosConfig.svelte";
  import HostDesktop from "./HostDesktop.svelte";
  import HostConfig from "./HostConfig.svelte";
  import ServerServices from "./ServerServices.svelte";
  import Physical from "./Physical.svelte";

  let { win }: { win: DeviceWindowState } = $props();
  const dev = $derived((app.tick, app.device(win.id)));
  let size = $state({ w: 760, h: 520 });

  const tabs = $derived.by(() => {
    if (!dev) return [];
    if (dev instanceof IosDevice) return [["cli", "CLI"], ["config", "Config"], ["physical", "Physical"]];
    if (dev instanceof Host) return [["desktop", "Desktop"], ["config", "Config"], ...(dev.services ? [["services", "Services"]] : []), ["physical", "Physical"]];
    return [["physical", "Physical"]];
  });

  function startDrag(e: PointerEvent) {
    if ((e.target as HTMLElement).closest("button, input, .segmented")) return;
    app.focusWindow(win.id);
    const sx = e.clientX - win.x;
    const sy = e.clientY - win.y;
    const move = (ev: PointerEvent) => {
      win.x = Math.max(-size.w + 120, Math.min(window.innerWidth - 120, ev.clientX - sx));
      win.y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - sy));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startResize(e: PointerEvent) {
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const w0 = size.w;
    const h0 = size.h;
    const move = (ev: PointerEvent) => (size = { w: Math.max(480, w0 + ev.clientX - sx), h: Math.max(320, h0 + ev.clientY - sy) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

{#if dev}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="win" style="left:{win.x}px; top:{win.y}px; width:{size.w}px; height:{size.h}px; z-index:{win.z}" onpointerdown={() => app.focusWindow(win.id)} role="dialog" tabindex="-1" aria-label="{dev.hostname} window">
    <div class="titlebar" onpointerdown={startDrag}>
      <button class="close" aria-label="Close window" title="Close" onclick={() => app.closeWindow(win.id)}><Icon name="close" size={9} stroke={2.6} /></button>
      <DeviceGlyph kind={dev.kind} size={20} />
      <span class="t">{dev.hostname}</span>
      <span class="muted m">{dev.model}</span>
      <div class="spacer"></div>
      <div class="segmented">
        {#each tabs as [id, label]}
          <button class:on={win.tab === id} onclick={() => (win.tab = id)}>{label}</button>
        {/each}
      </div>
    </div>
    <div class="content">
      {#if win.tab === "cli" && dev instanceof IosDevice}
        {#if dev.powered}
          <Terminal session={app.cliFor(dev)} />
        {:else}
          <div class="off muted"><Icon name="power" size={28} />This device is turned off.</div>
        {/if}
      {:else if win.tab === "config" && dev instanceof IosDevice}
        <IosConfig {dev} />
      {:else if win.tab === "desktop" && dev instanceof Host}
        {#if dev.powered}<HostDesktop host={dev} />{:else}<div class="off muted"><Icon name="power" size={28} />This device is turned off.</div>{/if}
      {:else if win.tab === "config" && dev instanceof Host}
        <HostConfig host={dev} />
      {:else if win.tab === "services" && dev instanceof Host}
        <ServerServices host={dev} />
      {:else}
        <Physical {dev} />
      {/if}
    </div>
    <div class="resize" onpointerdown={startResize} role="separator"></div>
  </div>
{/if}

<style>
  .win {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--window);
    border-radius: 12px;
    box-shadow: var(--shadow), 0 24px 64px rgba(0, 0, 0, 0.22);
    overflow: hidden;
    animation: pop 0.16s ease-out;
  }
  @keyframes pop {
    from {
      transform: scale(0.97);
      opacity: 0;
    }
  }
  .titlebar {
    height: 44px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 14px;
    background: var(--surface);
    border-bottom: 0.5px solid var(--separator);
    cursor: default;
  }
  .close {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: none;
    padding: 0;
    background: var(--red);
    color: transparent;
    display: grid;
    place-items: center;
    margin-right: 6px;
  }
  .close:hover {
    color: rgba(0, 0, 0, 0.6);
  }
  .t {
    font-weight: 600;
  }
  .m {
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .content > :global(*) {
    flex: 1;
    min-height: 0;
  }
  .off {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
  }
</style>
