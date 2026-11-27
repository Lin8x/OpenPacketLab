<script lang="ts">
  import { app, type Tool } from "../state.svelte";
  import { isMac, isTauri, mod } from "../platform";
  import { saveProject, openProject, newProject } from "../actions";
  import Icon from "./Icon.svelte";

  const tools: { id: Tool; icon: string; label: string; key: string }[] = [
    { id: "select", icon: "cursor", label: "Select", key: "V" },
    { id: "connect", icon: "cable", label: "Connect", key: "C" },
    { id: "pdu", icon: "envelope", label: "Ping", key: "P" },
    { id: "note", icon: "note", label: "Note", key: "N" },
    { id: "delete", icon: "trash", label: "Delete", key: "" },
  ];

  let menu = $state(false);
  const inset = isTauri && isMac;
</script>

<header class="toolbar" class:inset data-tauri-drag-region>
  <div class="left" data-tauri-drag-region>
    <button class="btn plain icon" title="Device library" aria-label="Toggle device library" onclick={() => (app.showLibrary = !app.showLibrary)}><Icon name="sidebar" /></button>
    <div class="title" data-tauri-drag-region>
      <button class="name" onclick={() => (app.sheet = "project")} title="Project info">{app.name}</button>
      <span class="sub" data-tauri-drag-region>{app.dirty ? "Edited" : app.filePath ? "Saved" : "Not saved"}</span>
    </div>
    <div class="menuwrap">
      <button class="btn plain icon" aria-label="File menu" title="File" onclick={() => (menu = !menu)}><Icon name="folder" /></button>
      {#if menu}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="scrim" onclick={() => (menu = false)}></div>
        <div class="menu" role="menu">
          <button role="menuitem" onclick={() => { menu = false; newProject(); }}>New Lab<kbd>{mod}N</kbd></button>
          <button role="menuitem" onclick={() => { menu = false; openProject(); }}>Open…<kbd>{mod}O</kbd></button>
          <button role="menuitem" onclick={() => { menu = false; app.sheet = "welcome"; }}>Sample Labs…</button>
          <hr />
          <button role="menuitem" onclick={() => { menu = false; saveProject(); }}>Save<kbd>{mod}S</kbd></button>
          <button role="menuitem" onclick={() => { menu = false; saveProject(true); }}>Save As…<kbd>⇧{mod}S</kbd></button>
          <button role="menuitem" onclick={() => { menu = false; app.sheet = "backups"; }}>Backups & Versions…</button>
          <hr />
          <button role="menuitem" onclick={() => { menu = false; app.palette = true; }}>All Commands…<kbd>{mod}K</kbd></button>
          <button role="menuitem" onclick={() => { menu = false; app.sheet = "prefs"; }}>Settings…<kbd>{mod},</kbd></button>
          <button role="menuitem" onclick={() => { menu = false; app.sheet = "about"; }}>About OpenPacketLab</button>
        </div>
      {/if}
    </div>
    <button class="btn plain icon" title="Undo ({mod}Z)" aria-label="Undo" disabled={!app.canUndo} onclick={() => app.undo()}><Icon name="undo" /></button>
    <button class="btn plain icon" title="Redo (⇧{mod}Z)" aria-label="Redo" disabled={!app.canRedo} onclick={() => app.redo()}><Icon name="redo" /></button>
  </div>

  <div class="mid" data-tauri-drag-region>
    <div class="segmented" role="toolbar" aria-label="Tools">
      {#each tools as t}
        <button class:on={app.tool === t.id} title="{t.label}{t.key ? ` (${t.key})` : ''}" aria-pressed={app.tool === t.id} onclick={() => { app.tool = t.id; app.pendingConnect = null; app.pendingPdu = null; }}>
          <Icon name={t.icon} size={16} /><span class="tl">{t.label}</span>
        </button>
      {/each}
    </div>
  </div>

  <div class="right" data-tauri-drag-region>
    <div class="segmented mode" role="radiogroup" aria-label="Mode">
      <button class:on={app.mode === "realtime"} role="radio" aria-checked={app.mode === "realtime"} onclick={() => app.setMode("realtime")}><Icon name="clock" size={15} />Realtime</button>
      <button class:on={app.mode === "simulation"} role="radio" aria-checked={app.mode === "simulation"} onclick={() => app.setMode("simulation")}><Icon name="play" size={15} />Simulation</button>
    </div>
    <button class="btn plain icon" title="Search commands ({mod}K)" aria-label="Search commands" onclick={() => (app.palette = true)}><Icon name="search" /></button>
    <button class="btn plain icon" title="Inspector" aria-label="Toggle inspector" onclick={() => (app.showInspector = !app.showInspector)}><Icon name="inspector" /></button>
  </div>
</header>

<style>
  .toolbar {
    height: var(--toolbar-h);
    flex: none;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 10px;
    background: var(--surface);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 0.5px solid var(--separator);
    position: relative;
    z-index: 20;
  }
  .toolbar.inset {
    padding-left: 84px;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .right {
    justify-content: flex-end;
    gap: 8px;
  }
  .title {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    margin: 0 8px 0 4px;
    min-width: 0;
  }
  .name {
    all: unset;
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
    cursor: default;
  }
  .sub {
    font-size: 11px;
    color: var(--secondary);
  }
  .menuwrap {
    position: relative;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
  }
  .menu {
    position: absolute;
    top: 34px;
    left: 0;
    z-index: 31;
    min-width: 230px;
    padding: 5px;
    border-radius: 10px;
    background: var(--elevated);
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
  }
  .menu button {
    all: unset;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 10px;
    border-radius: 5px;
  }
  .menu button:hover {
    background: var(--accent);
    color: #fff;
  }
  .menu button:hover kbd {
    color: #fff;
    background: transparent;
  }
  .menu hr {
    border: none;
    border-top: 0.5px solid var(--separator);
    margin: 4px 6px;
  }
  @media (max-width: 1100px) {
    .tl {
      display: none;
    }
  }
</style>
