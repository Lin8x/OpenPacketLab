<script lang="ts">
  import { app } from "../state.svelte";
  import { prefs, savePrefs } from "../prefs.svelte";
  import { backups, type BackupMeta } from "../storage";
  import { SAMPLES } from "../samples";
  import { newProject, openProject, loadSample, openRecent } from "../actions";
  import { isTauri, mod, exportText, basename } from "../platform";
  import Icon from "./Icon.svelte";

  const VERSION = __APP_VERSION__;
  let list = $state<BackupMeta[]>([]);
  let lastSession = $state<BackupMeta | null>(null);

  $effect(() => {
    if (app.sheet === "backups" || app.sheet === "welcome") {
      backups.list().then((l) => {
        list = l;
        lastSession = l[0] ?? null;
      });
    }
  });

  async function restoreBackup(b: BackupMeta) {
    const data = await backups.load(b.id);
    if (!data) return;
    await app.backupNow("Before restoring a backup");
    app.restore(JSON.parse(data));
    app.projectId = b.projectId;
    app.sheet = null;
    app.toast(`Restored “${b.name}” from ${new Date(b.time).toLocaleString()}`, "success");
  }

  async function exportBackup(b: BackupMeta) {
    const data = await backups.load(b.id);
    if (data) exportText(data, `${b.name}-${new Date(b.time).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.opl`, "application/json");
  }

  function fmtSize(n: number) {
    return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  const shortcuts = [
    ["New lab", `${mod}N`],
    ["Open", `${mod}O`],
    ["Save / Save As", `${mod}S / ⇧${mod}S`],
    ["Command palette", `${mod}K`],
    ["Undo / Redo", `${mod}Z / ⇧${mod}Z`],
    ["Duplicate", `${mod}D`],
    ["Select all", `${mod}A`],
    ["Delete selection", "Delete"],
    ["Open selected device", "Return"],
    ["Select tool", "V"],
    ["Connect tool", "C"],
    ["Ping tool", "P"],
    ["Note tool", "N"],
    ["Step simulation", "Space"],
    ["Pan canvas", "Space + drag, or scroll"],
    ["Zoom", `${mod}scroll, ${mod}+ / ${mod}-`],
    ["Zoom to fit", `${mod}0`],
    ["Cancel", "Esc"],
    ["Terminal: help / complete", "? / Tab"],
    ["Terminal: abort / end", "Ctrl+C / Ctrl+Z"],
  ];
</script>

{#if app.sheet}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => e.target === e.currentTarget && app.sheet !== "welcome" && (app.sheet = null)}>
    <div class="sheet" class:wide={app.sheet === "welcome"} role="dialog" aria-modal="true">
      {#if app.sheet === "welcome"}
        <div class="welcome">
          <div class="hero">
            <div class="logo"><Icon name="network" size={34} stroke={1.6} /></div>
            <h1>OpenPacketLab</h1>
            <p class="muted">Design, configure and watch networks come alive. Free and open source. No account needed.</p>
            <div class="cta">
              <button class="btn primary lg" onclick={newProject}><Icon name="plus" size={16} />New Lab</button>
              <button class="btn lg" onclick={openProject}><Icon name="folder" size={16} />Open…</button>
            </div>
            {#if lastSession}
              <button class="resume" onclick={() => restoreBackup(lastSession!)}>
                <Icon name="history" size={15} />Resume “{lastSession.name}” <span class="muted">· {new Date(lastSession.time).toLocaleString()}</span>
              </button>
            {/if}
            {#if isTauri && prefs.recent.length}
              <div class="recent">
                <div class="section-title">Recent</div>
                {#each prefs.recent.slice(0, 5) as r}
                  <button class="rec" onclick={() => openRecent(r.path)}><Icon name="doc" size={14} />{r.name}<span class="muted">{basename(r.path)}</span></button>
                {/each}
              </div>
            {/if}
          </div>
          <div class="samples">
            <div class="section-title">Sample labs</div>
            <div class="sgrid">
              {#each SAMPLES as s}
                <button class="card" onclick={() => loadSample(s.id)}>
                  <span class="lvl lvl-{s.level.toLowerCase()}">{s.level}</span>
                  <b>{s.title}</b>
                  <span class="muted">{s.summary}</span>
                </button>
              {/each}
            </div>
            <div class="foot">
              <button class="btn plain" onclick={() => (app.sheet = null)}>Continue with the current lab</button>
            </div>
          </div>
        </div>
      {:else if app.sheet === "backups"}
        <h2>Backups & versions</h2>
        <p class="muted">OpenPacketLab saves your work on this device every {prefs.autosaveSeconds} seconds while you edit, and keeps the last {prefs.backupCount} autosaves per lab plus every version you save. Nothing is uploaded.</p>
        <div class="blist scroll">
          {#each list as b}
            <div class="brow">
              <div class="bmain">
                <b>{b.name}</b>
                <span class="muted">{new Date(b.time).toLocaleString()} · {fmtSize(b.size)}{b.projectId === app.projectId ? " · this lab" : ""}</span>
              </div>
              {#if b.label}<span class="tag">{b.label}</span>{/if}
              <button class="btn" onclick={() => restoreBackup(b)}>Restore</button>
              <button class="btn plain icon" title="Export" aria-label="Export" onclick={() => exportBackup(b)}><Icon name="download" size={15} /></button>
              <button class="btn plain icon danger" title="Delete" aria-label="Delete" onclick={async () => { await backups.remove(b.id); list = await backups.list(); }}><Icon name="trash" size={15} /></button>
            </div>
          {:else}
            <p class="muted">No backups yet.</p>
          {/each}
        </div>
        <div class="foot">
          <button class="btn" onclick={async () => { await app.backupNow("Manual version"); list = await backups.list(); }}>Save a version now</button>
          <span style="flex:1"></span>
          <button class="btn primary" onclick={() => (app.sheet = null)}>Done</button>
        </div>
      {:else if app.sheet === "prefs"}
        <h2>Settings</h2>
        <div class="section-title">Appearance</div>
        <div class="group">
          <div class="row"><span class="label">Theme</span>
            <div class="segmented">
              {#each [["system", "Automatic"], ["light", "Light"], ["dark", "Dark"]] as [v, l]}
                <button class:on={prefs.appearance === v} onclick={() => { prefs.appearance = v as "system"; savePrefs(); }}>{l}</button>
              {/each}
            </div>
          </div>
          <div class="row"><span class="label">Show grid</span><input type="checkbox" class="switch" bind:checked={prefs.showGrid} onchange={savePrefs} /></div>
          <div class="row"><span class="label">Snap devices to grid</span><input type="checkbox" class="switch" bind:checked={prefs.snapToGrid} onchange={savePrefs} /></div>
          <div class="row"><span class="label">Port labels on links</span><input type="checkbox" class="switch" bind:checked={prefs.showPortLabels} onchange={savePrefs} /></div>
          <div class="row"><span class="label">Link lights</span><input type="checkbox" class="switch" bind:checked={prefs.showLinkLights} onchange={savePrefs} /></div>
          <div class="row"><span class="label">Terminal text size</span><input type="range" min="11" max="18" bind:value={prefs.terminalFontSize} onchange={savePrefs} /><span class="value">{prefs.terminalFontSize} pt</span></div>
        </div>
        <div class="section-title">Simulation</div>
        <div class="group">
          <div class="row"><span class="label">Fast spanning tree for new switches<br /><span class="muted small">Ports forward after 3 seconds instead of 30</span></span><input type="checkbox" class="switch" bind:checked={prefs.fastStp} onchange={savePrefs} /></div>
        </div>
        <div class="section-title">Backups</div>
        <div class="group">
          <div class="row"><span class="label">Autosave every</span><select class="field" bind:value={prefs.autosaveSeconds} onchange={savePrefs}><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={300}>5 minutes</option></select></div>
          <div class="row"><span class="label">Autosaves to keep per lab</span><select class="field" bind:value={prefs.backupCount} onchange={savePrefs}><option value={10}>10</option><option value={30}>30</option><option value={100}>100</option></select></div>
        </div>
        <div class="foot"><span style="flex:1"></span><button class="btn primary" onclick={() => (app.sheet = null)}>Done</button></div>
      {:else if app.sheet === "project"}
        <h2>Project</h2>
        <div class="group">
          <div class="row"><span class="label">Name</span><input class="field" style="width:260px" bind:value={app.name} oninput={() => app.markDirty()} /></div>
          <div class="row"><span class="label">Created</span><span class="value">{new Date(app.created).toLocaleString()}</span></div>
          <div class="row"><span class="label">File</span><span class="value">{app.filePath ?? "Not saved to a file"}</span></div>
        </div>
        <div class="section-title">Description</div>
        <textarea class="field" style="width:100%;min-height:110px" bind:value={app.description} oninput={() => app.markDirty()} placeholder="Instructions or notes for this lab"></textarea>
        <div class="foot"><span style="flex:1"></span><button class="btn primary" onclick={() => (app.sheet = null)}>Done</button></div>
      {:else if app.sheet === "shortcuts"}
        <h2>Keyboard shortcuts</h2>
        <div class="group">
          {#each shortcuts as [a, k]}<div class="row"><span class="label">{a}</span><kbd>{k}</kbd></div>{/each}
        </div>
        <div class="foot"><span style="flex:1"></span><button class="btn primary" onclick={() => (app.sheet = null)}>Done</button></div>
      {:else if app.sheet === "about"}
        <div class="about">
          <div class="logo"><Icon name="network" size={34} stroke={1.6} /></div>
          <h2>OpenPacketLab</h2>
          <p class="muted">Version {VERSION}</p>
          <p>A free, open-source network simulator for learning and teaching. Licensed under the Apache License 2.0.</p>
          <p class="muted small">OpenPacketLab is an independent project and is not affiliated with Cisco Systems or Apple. Command syntax follows widely taught industry conventions so skills carry over to real equipment.</p>
          <a class="btn" href="https://github.com/Lin8x/OpenPacketLab" target="_blank" rel="noreferrer"><Icon name="github" size={15} />Source code</a>
        </div>
        <div class="foot"><span style="flex:1"></span><button class="btn primary" onclick={() => (app.sheet = null)}>Close</button></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.25);
    display: grid;
    place-items: start center;
    padding-top: 8vh;
    z-index: 1000;
    animation: fade 0.15s;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .sheet {
    width: min(560px, 94vw);
    max-height: 84vh;
    overflow: auto;
    background: var(--window);
    border-radius: 14px;
    box-shadow: var(--shadow), 0 30px 80px rgba(0, 0, 0, 0.3);
    padding: 20px 22px;
    animation: drop 0.2s ease-out;
  }
  .sheet.wide {
    width: min(980px, 96vw);
    padding: 0;
    overflow: hidden;
  }
  @keyframes drop {
    from {
      transform: translateY(-12px);
      opacity: 0;
    }
  }
  h2 {
    font: 600 18px var(--font-display);
    margin: 0 0 8px;
  }
  .foot {
    display: flex;
    gap: 8px;
    margin-top: 18px;
    align-items: center;
  }
  .small {
    font-size: 11px;
  }
  .welcome {
    display: grid;
    grid-template-columns: 340px 1fr;
    min-height: 520px;
  }
  .hero {
    padding: 36px 30px;
    background: var(--surface);
    border-right: 0.5px solid var(--separator);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }
  .logo {
    width: 64px;
    height: 64px;
    border-radius: 16px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(135deg, #4b8cff, #6b3fe0);
    box-shadow: 0 6px 18px rgba(75, 100, 255, 0.35);
  }
  h1 {
    font: 700 26px var(--font-display);
    margin: 18px 0 6px;
    letter-spacing: -0.01em;
  }
  .cta {
    display: flex;
    gap: 8px;
    margin: 18px 0;
  }
  .resume,
  .rec {
    all: unset;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    margin-left: -8px;
    border-radius: 6px;
    color: var(--accent);
    font-weight: 500;
  }
  .rec {
    color: var(--label);
    font-weight: 400;
  }
  .rec span {
    font-size: 11px;
  }
  .resume:hover,
  .rec:hover {
    background: var(--fill);
  }
  .recent {
    width: 100%;
  }
  .samples {
    padding: 22px 26px;
    overflow: auto;
    max-height: 84vh;
  }
  .sgrid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .card {
    all: unset;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    border-radius: 10px;
    background: var(--elevated);
    box-shadow: var(--shadow-sm);
    font-size: 12px;
  }
  .card b {
    font-size: 13px;
  }
  .card:hover {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .lvl {
    align-self: flex-start;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .lvl-beginner {
    background: color-mix(in srgb, var(--green) 20%, transparent);
    color: var(--green);
  }
  .lvl-intermediate {
    background: color-mix(in srgb, var(--orange) 20%, transparent);
    color: var(--orange);
  }
  .lvl-advanced {
    background: color-mix(in srgb, var(--purple) 20%, transparent);
    color: var(--purple);
  }
  .blist {
    max-height: 50vh;
    margin-top: 10px;
  }
  .brow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px;
    border-bottom: 0.5px solid var(--separator);
  }
  .bmain {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .bmain span {
    font-size: 11px;
  }
  .about {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .about h2 {
    margin-top: 14px;
  }
  .about a {
    text-decoration: none;
  }
  @media (max-width: 760px) {
    .welcome {
      grid-template-columns: 1fr;
    }
    .sgrid {
      grid-template-columns: 1fr;
    }
  }
</style>
