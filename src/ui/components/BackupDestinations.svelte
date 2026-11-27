<script lang="ts">
  import { backupManager as bm } from "../../backup/manager.svelte";
  import { KINDS, kindInfo } from "../../backup/kinds";
  import { describeSchedule } from "../../backup/schedule";
  import { isDesktop, secrets } from "../../backup/env";
  import { OAUTH, credentialsFor, isSignedIn, signIn, signOut, desktopRedirect, browserRedirect } from "../../backup/oauth";
  import { canPickFolder, saveDirHandle } from "../../backup/providers/native";
  import type { Destination, DestinationKind } from "../../backup/types";
  import { app } from "../state.svelte";
  import Icon from "./Icon.svelte";

  const KIND_ICON: Record<DestinationKind, string> = {
    folder: "folder",
    smb: "share",
    s3: "drive",
    gdrive: "cloud",
    onedrive: "cloud",
    dropbox: "cloud",
    webdav: "globe",
    sftp: "server",
    ftp: "server",
    http: "upload",
    rclone: "bolt",
  };
  const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
  const DAY_TITLES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  let { view = $bindable("list") }: { view?: "list" | "add" | "edit" } = $props();
  let draft = $state<Destination | null>(null);
  let draftSecrets = $state<Record<string, string>>({});
  let isNew = $state(false);
  let testing = $state(false);
  let testResult = $state<{ ok: boolean; message: string } | null>(null);
  let signedIn = $state(false);
  let signingIn = $state(false);
  let showAdvanced = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(t);
  });

  function rel(t: number | null) {
    if (!t) return "never";
    const d = (t - Math.max(now, Date.now())) / 1000;
    const a = Math.abs(d);
    const f = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (a < 60) return d <= 5 ? "just now" : "in a moment";
    if (a < 3600) return f.format(Math.round(d / 60), "minute");
    if (a < 86400) return f.format(Math.round(d / 3600), "hour");
    return f.format(Math.round(d / 86400), "day");
  }

  async function edit(d: Destination, fresh = false) {
    draft = structuredClone($state.snapshot(d)) as Destination;
    isNew = fresh;
    testResult = null;
    showAdvanced = false;
    const s: Record<string, string> = {};
    for (const f of kindInfo(d.kind).fields) if (f.secret) s[f.key] = await secrets.get(d.id, f.key);
    draftSecrets = s;
    signedIn = kindInfo(d.kind).oauth ? await isSignedIn(d.id) : false;
    view = "edit";
  }

  function add(kind: DestinationKind) {
    edit(bm.create(kind), true);
  }

  async function persistSecrets() {
    if (!draft) return;
    for (const [k, v] of Object.entries(draftSecrets)) await secrets.set(draft.id, k, v);
  }

  async function save() {
    if (!draft) return;
    await persistSecrets();
    bm.save(draft);
    app.toast(`Saved “${draft.name}”`, "success");
    view = "list";
    draft = null;
  }

  async function test() {
    if (!draft) return;
    testing = true;
    testResult = null;
    await persistSecrets();
    testResult = await bm.test(draft);
    testing = false;
  }

  async function doSignIn() {
    if (!draft) return;
    signingIn = true;
    testResult = null;
    try {
      const p = OAUTH[draft.kind as "gdrive"];
      await signIn(draft.id, p, credentialsFor(p, draft.settings));
      signedIn = true;
      testResult = await bm.test(draft);
    } catch (e) {
      testResult = { ok: false, message: (e as Error).message };
    }
    signingIn = false;
  }

  async function pickFolder(key: string) {
    if (!draft) return;
    if (isDesktop) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ directory: true, multiple: false });
      if (typeof p === "string") draft.settings[key] = p;
    } else if (canPickFolder) {
      try {
        const h = await (window as unknown as { showDirectoryPicker(o: unknown): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "readwrite" });
        await saveDirHandle(draft.id, h);
        draft.settings[key] = draft.id;
        draft.settings.folderLabel = h.name;
      } catch {
        /* cancelled */
      }
    }
  }

  async function remove() {
    if (!draft) return;
    if (!isNew) await bm.remove(draft.id);
    view = "list";
    draft = null;
  }

  function toggleDay(d: number) {
    if (!draft) return;
    const days = new Set(draft.schedule.days ?? [1]);
    if (days.has(d)) days.delete(d);
    else days.add(d);
    draft.schedule.days = [...days].sort();
  }

  const historyFor = $derived(draft ? bm.history.filter((h) => h.destination === draft!.id).slice(0, 12) : []);
  const info = $derived(draft ? kindInfo(draft.kind) : null);
  const unavailable = $derived(info?.desktopOnly && !isDesktop);
</script>

{#if view === "list"}
  <div class="intro">
    <p class="muted">Send copies of your labs to other places, each on its own schedule. Backups run while OpenPacketLab is open, and a run that was missed while it was closed happens at the next launch.</p>
  </div>
  {#if bm.destinations.length}
    <div class="group dlist">
      {#each bm.destinations as d (d.id)}
        {@const st = bm.state(d.id)}
        {@const last = bm.history.find((h) => h.destination === d.id)}
        {@const next = bm.next(d)}
        <div class="drow">
          <div class="dicon" class:off={!d.enabled}><Icon name={KIND_ICON[d.kind]} size={18} /></div>
          <button class="dmain" onclick={() => edit(d)}>
            <b>{d.name}</b>
            <span class="muted small">{describeSchedule(d.schedule)}{d.scope === "all" ? " · all labs" : ""}</span>
            <span class="small status">
              {#if bm.running[d.id]}
                <span class="dot run"></span>Backing up…
              {:else if last}
                <span class="dot" class:ok={last.ok} class:bad={!last.ok}></span>{last.ok ? `Last backup ${rel(st.lastSuccess ?? last.time)}` : `Failed ${rel(last.time)}: ${last.message}`}
              {:else}
                <span class="dot"></span>No backups yet
              {/if}
              {#if d.enabled && next && !bm.running[d.id]}<span class="muted"> · next {rel(next)}</span>{/if}
            </span>
          </button>
          <button class="btn" disabled={bm.running[d.id]} onclick={() => bm.run(d.id, "manual")}>Back Up Now</button>
          <input type="checkbox" class="switch" checked={d.enabled} onchange={(e) => bm.setEnabled(d.id, e.currentTarget.checked)} aria-label="Enabled" />
          <button class="btn plain icon" aria-label="Edit" onclick={() => edit(d)}><Icon name="chevronRight" size={15} /></button>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty">
      <Icon name="cloud" size={30} stroke={1.4} />
      <p><b>No backup destinations yet</b></p>
      <p class="muted small">Add a folder, a network share, cloud storage or a server.</p>
    </div>
  {/if}
  <div class="actions">
    <button class="btn primary" onclick={() => (view = "add")}><Icon name="plus" size={15} />Add Destination</button>
    {#if bm.destinations.length > 1}<button class="btn" onclick={() => bm.runAll()}>Back Up All Now</button>{/if}
  </div>
{:else if view === "add"}
  <div class="crumbs"><button class="btn plain" onclick={() => (view = "list")}><Icon name="chevronRight" size={14} />Destinations</button></div>
  <h3>Choose where to back up</h3>
  <div class="kinds">
    {#each KINDS as k}
      {@const off = k.desktopOnly && !isDesktop}
      <button class="kind" disabled={off} onclick={() => add(k.kind)} title={off ? "Available in the desktop app" : k.description}>
        <div class="kicon"><Icon name={KIND_ICON[k.kind]} size={20} /></div>
        <b>{k.label}</b>
        <span class="muted small">{off ? "Desktop app only" : k.description}</span>
      </button>
    {/each}
  </div>
{:else if draft && info}
  <div class="crumbs"><button class="btn plain" onclick={() => (view = "list")}><Icon name="chevronRight" size={14} />Destinations</button></div>
  <div class="ehead">
    <div class="dicon big"><Icon name={KIND_ICON[draft.kind]} size={22} /></div>
    <div>
      <input class="field title" bind:value={draft.name} aria-label="Name" />
      <p class="muted small">{info.description}</p>
    </div>
  </div>

  {#if unavailable}
    <p class="note warn"><Icon name="warning" size={15} />This destination needs the OpenPacketLab desktop app.</p>
  {/if}

  {#if info.oauth}
    <div class="section-title">Account</div>
    <div class="group">
      <div class="row">
        <span class="label">{signedIn ? "Signed in" : "Not signed in"}</span>
        {#if signedIn}
          <button class="btn" onclick={async () => { await signOut(draft!.id); signedIn = false; }}>Sign Out</button>
        {:else}
          <button class="btn primary" disabled={signingIn} onclick={doSignIn}>{signingIn ? "Waiting for the browser…" : `Sign In to ${info.label}`}</button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="section-title">{info.oauth ? "Location" : "Connection"}</div>
  <div class="group">
    {#each info.fields.filter((f) => !(info.oauth && (f.key === "clientId" || f.key === "clientSecret"))) as f}
      <div class="row" class:tall={f.type === "textarea"}>
        <span class="label">{f.label}{#if f.help}<br /><span class="muted small">{f.help}</span>{/if}</span>
        {#if f.secret && f.type === "textarea"}
          <textarea class="field mono" rows="4" placeholder={f.placeholder} bind:value={draftSecrets[f.key]}></textarea>
        {:else if f.secret}
          <input class="field" type="password" autocomplete="off" placeholder={f.placeholder ?? (f.optional ? "Optional" : "")} bind:value={draftSecrets[f.key]} />
        {:else if f.type === "select"}
          <select class="field" bind:value={draft.settings[f.key]}>
            {#each f.options ?? [] as [v, l]}<option value={v}>{l}</option>{/each}
          </select>
        {:else if f.type === "textarea"}
          <textarea class="field mono" rows="3" placeholder={f.placeholder} bind:value={draft.settings[f.key]}></textarea>
        {:else if f.type === "folder"}
          <div class="folder">
            {#if isDesktop}
              <input class="field" placeholder={f.placeholder} bind:value={draft.settings[f.key]} />
            {:else}
              <span class="value">{draft.settings.folderLabel ?? "No folder chosen"}</span>
            {/if}
            {#if isDesktop || canPickFolder}<button class="btn" onclick={() => pickFolder(f.key)}>Choose…</button>{/if}
          </div>
        {:else}
          <input class="field" type={f.type === "number" ? "number" : "text"} placeholder={f.placeholder ?? (f.optional ? "Optional" : "")} bind:value={draft.settings[f.key]} />
        {/if}
      </div>
    {/each}
    {#if draft.kind === "sftp" && draft.settings.fingerprint}
      <div class="row"><span class="label">Server key<br /><span class="muted small">Saved on first connection. The backup stops if it changes.</span></span><span class="value mono small">{draft.settings.fingerprint}</span><button class="btn plain" onclick={() => { draft!.settings.fingerprint = ""; }}>Forget</button></div>
    {/if}
  </div>

  <div class="testrow">
    <button class="btn" disabled={testing || unavailable} onclick={test}>{testing ? "Testing…" : "Test Connection"}</button>
    {#if testResult}<span class="small" class:okc={testResult.ok} class:badc={!testResult.ok}><Icon name={testResult.ok ? "check" : "warning"} size={14} />{testResult.message}</span>{/if}
  </div>

  <div class="section-title">Schedule</div>
  <div class="group">
    <div class="row">
      <span class="label">Back up</span>
      <select class="field" bind:value={draft.schedule.mode}>
        <option value="interval">Every…</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="onSave">When I save</option>
        <option value="manual">Only manually</option>
      </select>
    </div>
    {#if draft.schedule.mode === "interval"}
      <div class="row">
        <span class="label">Interval</span>
        <select class="field" bind:value={draft.schedule.every}>
          {#each [[5, "5 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "hour"], [120, "2 hours"], [360, "6 hours"], [720, "12 hours"], [1440, "day"]] as [v, l]}<option value={v}>{l}</option>{/each}
        </select>
      </div>
    {/if}
    {#if draft.schedule.mode === "weekly"}
      <div class="row">
        <span class="label">On</span>
        <div class="days">
          {#each DAYS as d, i}<button class="day" class:on={(draft.schedule.days ?? [1]).includes(i)} title={DAY_TITLES[i]} aria-label={DAY_TITLES[i]} onclick={() => toggleDay(i)}>{d}</button>{/each}
        </div>
      </div>
    {/if}
    {#if draft.schedule.mode === "daily" || draft.schedule.mode === "weekly"}
      <div class="row"><span class="label">At</span><input class="field" type="time" bind:value={draft.schedule.at} /></div>
    {/if}
    <div class="row">
      <span class="label">What to back up</span>
      <div class="segmented">
        <button class:on={draft.scope === "current"} onclick={() => (draft!.scope = "current")}>Open lab</button>
        <button class:on={draft.scope === "all"} onclick={() => (draft!.scope = "all")}>All recent labs</button>
      </div>
    </div>
    <div class="row">
      <span class="label">Keep</span>
      <select class="field" bind:value={draft.keep}>
        {#each [[5, "5 latest per lab"], [10, "10 latest per lab"], [30, "30 latest per lab"], [100, "100 latest per lab"], [0, "Everything"]] as [v, l]}<option value={v}>{l}</option>{/each}
      </select>
    </div>
    <div class="row"><span class="label">Skip when nothing changed</span><input type="checkbox" class="switch" bind:checked={draft.skipUnchanged} /></div>
  </div>

  <button class="btn plain disclose" onclick={() => (showAdvanced = !showAdvanced)}><Icon name={showAdvanced ? "chevronDown" : "chevronRight"} size={14} />Advanced</button>
  {#if showAdvanced}
    <div class="group">
      <div class="row tall">
        <span class="label">File name<br /><span class="muted small">Tokens: {"{name} {date} {time} {datetime} {id}"}. Use / for folders.</span></span>
        <input class="field mono" bind:value={draft.path} />
      </div>
      {#if info.oauth}
        <div class="row tall">
          <span class="label">Use your own app<br /><span class="muted small">{info.fields.find((f) => f.key === "clientId")?.help} Redirect URI: {isDesktop ? desktopRedirect : browserRedirect()}</span></span>
          <div class="stack">
            <input class="field" placeholder="Client ID" bind:value={draft.settings.clientId} />
            {#if draft.kind === "gdrive"}<input class="field" placeholder="Client secret" bind:value={draft.settings.clientSecret} />{/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if historyFor.length}
    <div class="section-title">History</div>
    <div class="group hist">
      {#each historyFor as h}
        <div class="row">
          <span class="dot" class:ok={h.ok} class:bad={!h.ok}></span>
          <span class="label small">{new Date(h.time).toLocaleString()}<br /><span class="muted">{h.message}</span></span>
          <span class="muted small">{h.trigger === "schedule" ? "Scheduled" : h.trigger === "save" ? "On save" : h.trigger === "test" ? "Test" : "Manual"}</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="foot">
    <button class="btn plain danger" onclick={remove}>{isNew ? "Cancel" : "Remove Destination"}</button>
    <span style="flex:1"></span>
    <button class="btn" onclick={() => (view = "list")}>Back</button>
    <button class="btn primary" disabled={unavailable} onclick={save}>{isNew ? "Add" : "Save"}</button>
  </div>
{/if}

<style>
  .foot {
    display: flex;
    gap: 8px;
    margin-top: 18px;
    align-items: center;
    position: sticky;
    bottom: -20px;
    padding: 10px 0;
    background: var(--surface-solid);
  }
  .intro p {
    margin: 0 0 12px;
  }
  .dlist {
    padding: 0;
  }
  .drow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--separator);
  }
  .drow:last-child {
    border-bottom: 0;
  }
  .dicon {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    flex: none;
  }
  .dicon.off {
    filter: grayscale(1);
    opacity: 0.6;
  }
  .dicon.big {
    width: 46px;
    height: 46px;
    border-radius: 12px;
  }
  .dmain {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .dmain > * {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tertiary);
    flex: none;
  }
  .dot.ok {
    background: var(--green);
  }
  .dot.bad {
    background: var(--red);
  }
  .dot.run {
    background: var(--accent);
    animation: pulse 1s infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.3;
    }
  }
  .empty {
    text-align: center;
    padding: 26px 0 10px;
    color: var(--secondary);
  }
  .empty p {
    margin: 4px 0;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }
  .crumbs :global(svg) {
    transform: rotate(180deg);
  }
  .crumbs {
    margin: -6px 0 4px -8px;
  }
  h3 {
    margin: 4px 0 12px;
    font-size: 15px;
  }
  .kinds {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 10px;
  }
  .kind {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid var(--separator);
    background: var(--elevated);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.15s;
  }
  .kind:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .kind:active:not(:disabled) {
    transform: scale(0.98);
  }
  .kind:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .kind .small {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .kicon {
    color: var(--accent);
    margin-bottom: 2px;
  }
  .ehead {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    margin-bottom: 6px;
  }
  .ehead p {
    margin: 4px 0 0;
  }
  .title {
    font-size: 16px;
    font-weight: 600;
    width: 100%;
  }
  .row.tall {
    align-items: flex-start;
  }
  .row textarea {
    width: 260px;
    resize: vertical;
  }
  .row .field:not(select):not([type="checkbox"]) {
    width: 260px;
  }
  .folder {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .folder .field {
    width: 190px !important;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mono {
    font-family: var(--mono);
  }
  .testrow {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 10px 0 2px;
  }
  .testrow span {
    display: flex;
    gap: 5px;
    align-items: center;
    min-width: 0;
  }
  .okc {
    color: var(--green);
  }
  .badc {
    color: var(--red);
  }
  .note.warn {
    display: flex;
    gap: 6px;
    align-items: center;
    color: var(--orange);
  }
  .days {
    display: flex;
    gap: 4px;
  }
  .day {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px solid var(--separator);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .day.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .disclose {
    margin: 12px 0 4px -8px;
  }
  .hist .row {
    gap: 10px;
  }
  .hist .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
