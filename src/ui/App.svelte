<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "./state.svelte";
  import { prefs } from "./prefs.svelte";
  import { backups } from "./storage";
  import { actions, deleteSelection, duplicateSelection, saveProject, openProject, newProject, selectAll, zoom, zoomToFit } from "./actions";
  import Toolbar from "./components/Toolbar.svelte";
  import Library from "./components/Library.svelte";
  import Canvas from "./components/Canvas.svelte";
  import Inspector from "./components/Inspector.svelte";
  import SimPanel from "./components/SimPanel.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import DeviceWindow from "./components/DeviceWindow.svelte";
  import Sheets from "./components/Sheets.svelte";
  import Palette from "./components/Palette.svelte";
  import Toasts from "./components/Toasts.svelte";

  // Theme -----------------------------------------------------------------
  $effect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = prefs.appearance === "dark" || (prefs.appearance === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });

  $effect(() => {
    backups.limit = prefs.backupCount;
  });

  $effect(() => {
    document.title = `${app.dirty ? "• " : ""}${app.name} — OpenPacketLab`;
  });

  onMount(() => {
    let raf = 0;
    const loop = (t: number) => {
      app.frame(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Autosave to local backups.
    const timer = setInterval(() => {
      if (app.dirty && app.net.devices.size) app.backupNow();
    }, Math.max(10, prefs.autosaveSeconds) * 1000);

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (app.dirty && app.net.devices.size) {
        app.backupNow("Before closing");
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  });

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = target.closest("input, textarea, select, [contenteditable], .terminal");
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const map: Record<string, () => void> = {
        s: () => saveProject(e.shiftKey),
        o: () => openProject(),
        n: () => newProject(),
        k: () => (app.palette = !app.palette),
        ",": () => (app.sheet = "prefs"),
      };
      if (!typing) {
        Object.assign(map, {
          z: () => (e.shiftKey ? app.redo() : app.undo()),
          y: () => app.redo(),
          d: () => duplicateSelection(),
          a: () => selectAll(),
          "=": () => zoom(1.2),
          "+": () => zoom(1.2),
          "-": () => zoom(1 / 1.2),
          "0": () => zoomToFit(),
        });
      }
      const fn = map[k];
      if (fn) {
        e.preventDefault();
        fn();
      }
      return;
    }
    if (typing) return;
    if (e.key === "Escape") {
      if (app.palette) app.palette = false;
      else if (app.sheet) app.sheet = null;
      else {
        app.tool = "select";
        app.pendingConnect = null;
        app.pendingPdu = null;
        app.placing = null;
        app.selection = new Set();
        app.selectedLink = null;
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === " " && app.mode === "simulation") {
      e.preventDefault();
      app.step();
    } else if (e.key === "v") app.tool = "select";
    else if (e.key === "c") app.tool = "connect";
    else if (e.key === "n") app.tool = "note";
    else if (e.key === "p") app.tool = "pdu";
    else if (e.key === "Enter" && app.selection.size === 1) app.openWindow([...app.selection][0]);
  }
  void actions;
</script>

<svelte:window onkeydown={onKey} />

<div class="app">
  <Toolbar />
  <div class="main">
    {#if app.showLibrary}<Library />{/if}
    <div class="center">
      <Canvas />
      {#if app.mode === "simulation"}<SimPanel />{/if}
      <StatusBar />
    </div>
    {#if app.showInspector}<Inspector />{/if}
  </div>
  {#each app.windows as w (w.id)}
    <DeviceWindow win={w} />
  {/each}
  <Sheets />
  {#if app.palette}<Palette />{/if}
  <Toasts />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
  }
</style>
