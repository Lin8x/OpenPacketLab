// User-facing commands shared by the toolbar, menus, palette and shortcuts.

import { app } from "./state.svelte";
import { prefs, savePrefs } from "./prefs.svelte";
import { openProjectFile, saveProjectFile, readPath, isTauri, basename, download, exportText } from "./platform";
import { SAMPLES } from "./samples";
import { runningConfig } from "../engine/cli/show";
import { IosDevice } from "../engine/devices/ios";
import { LIBRARY } from "../engine/project";

export interface Action {
  id: string;
  title: string;
  group: string;
  shortcut?: string;
  icon?: string;
  run: () => void | Promise<void>;
}

async function confirmDiscard(): Promise<boolean> {
  if (!app.dirty || !app.net.devices.size) return true;
  await app.backupNow("Before closing");
  return true;
}

function remember(name: string, path: string) {
  prefs.recent = [{ name, path, time: Date.now() }, ...prefs.recent.filter((r) => r.path !== path)].slice(0, 10);
  savePrefs();
}

export async function newProject() {
  if (!(await confirmDiscard())) return;
  app.newProject();
  app.sheet = null;
}

export async function openProject() {
  if (!(await confirmDiscard())) return;
  try {
    const f = await openProjectFile();
    if (!f) return;
    app.restore(JSON.parse(f.text));
    app.filePath = f.path;
    app.dirty = false;
    app.sheet = null;
    if (f.path) remember(app.name, f.path);
    app.toast(`Opened ${f.name}`, "success");
  } catch (e) {
    app.toast(`Could not open the file. ${(e as Error).message}`, "error");
  }
}

export async function openRecent(path: string) {
  try {
    const text = await readPath(path);
    app.restore(JSON.parse(text));
    app.filePath = path;
    app.dirty = false;
    app.sheet = null;
    remember(app.name, path);
  } catch (e) {
    app.toast(`Could not open ${basename(path)}. ${(e as Error).message}`, "error");
  }
}

export async function saveProject(saveAs = false) {
  try {
    const text = JSON.stringify(app.snapshot(), null, 1);
    const res = await saveProjectFile(text, app.name.replace(/[\\/:*?"<>|]/g, "-"), app.filePath, saveAs);
    if (res === false) return;
    if (res && isTauri) {
      app.filePath = res;
      remember(app.name, res);
    }
    app.dirty = false;
    await app.backupNow("Saved");
    app.toast(res ? `Saved ${basename(res)}` : "Project downloaded", "success");
  } catch (e) {
    app.toast(`Could not save. ${(e as Error).message}`, "error");
  }
}

export function loadSample(id: string) {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) return;
  app.restore(s.build());
  // Samples open already converged (links up, spanning tree forwarding, routing learned).
  app.net.advance(40000);
  app.events = [];
  app.dirty = false;
  app.sheet = null;
  app.toast(`Loaded “${s.title}”`, "success");
}

export function deleteSelection() {
  if (app.selectedLink) return app.removeLink(app.selectedLink);
  app.removeDevices([...app.selection]);
}

export function duplicateSelection() {
  const devs = app.selectedDevices;
  if (!devs.length) return;
  const ids: string[] = [];
  for (const d of devs) {
    const t = LIBRARY.find((l) => l.kind === d.kind && (!l.variant || l.variant === (d as { variant?: string }).variant)) ?? LIBRARY[0];
    const n = app.addDevice(t, d.x + 40, d.y + 40);
    const cfg = structuredClone(d.serialize()) as Record<string, unknown>;
    // Keep the new device's own name and hardware addresses.
    const hostname = n.hostname;
    stripMacs(cfg);
    n.load(cfg);
    n.hostname = hostname;
    if ((n as IosDevice & { cfg?: { hostname: string } }).cfg) (n as unknown as { cfg: { hostname: string } }).cfg.hostname = hostname;
    if ((n as unknown as { applyConfig?: () => void }).applyConfig) (n as unknown as { applyConfig: () => void }).applyConfig();
    ids.push(n.id);
  }
  app.selection = new Set(ids);
  app.bump();
}

function stripMacs(o: unknown) {
  if (!o || typeof o !== "object") return;
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k === "mac" || k === "macs") delete r[k];
    else if (k === "hostname" && typeof r[k] === "string") delete r[k];
    else stripMacs(r[k]);
  }
}

export function selectAll() {
  app.selection = new Set(app.net.devices.keys());
}

export function exportConfigs() {
  const parts: string[] = [];
  for (const d of app.net.devices.values()) if (d instanceof IosDevice) parts.push(`! ===== ${d.hostname} (${d.model}) =====\n${runningConfig(d)}`);
  if (!parts.length) return app.toast("There are no routers or switches to export.");
  exportText(parts.join("\n\n"), `${app.name}-configs.txt`);
}

export function zoom(delta: number) {
  const z = Math.min(3, Math.max(0.25, app.view.zoom * delta));
  app.view = { ...app.view, zoom: z };
}

export function zoomToFit(width = window.innerWidth - 560, height = window.innerHeight - 200) {
  const ds = [...app.net.devices.values()];
  if (!ds.length) {
    app.view = { x: 0, y: 0, zoom: 1 };
    return;
  }
  const minX = Math.min(...ds.map((d) => d.x)) - 80;
  const maxX = Math.max(...ds.map((d) => d.x)) + 80;
  const minY = Math.min(...ds.map((d) => d.y)) - 80;
  const maxY = Math.max(...ds.map((d) => d.y)) + 100;
  const z = Math.min(1.6, Math.max(0.3, Math.min(width / (maxX - minX), height / (maxY - minY))));
  app.view = { zoom: z, x: -minX * z + (width - (maxX - minX) * z) / 2, y: -minY * z + (height - (maxY - minY) * z) / 2 };
}

export function actions(): Action[] {
  return [
    { id: "new", title: "New Lab", group: "File", shortcut: "N", icon: "doc", run: newProject },
    { id: "open", title: "Open…", group: "File", shortcut: "O", icon: "folder", run: openProject },
    { id: "save", title: "Save", group: "File", shortcut: "S", icon: "save", run: () => saveProject() },
    { id: "saveas", title: "Save As…", group: "File", shortcut: "⇧S", icon: "save", run: () => saveProject(true) },
    { id: "backups", title: "Browse Backups…", group: "File", icon: "history", run: () => void (app.sheet = "backups") },
    { id: "snapshot", title: "Save a Version Now", group: "File", icon: "history", run: async () => {
      await app.backupNow("Manual version");
      app.toast("Version saved to local backups.", "success");
    } },
    { id: "export-configs", title: "Export All Device Configurations", group: "File", icon: "download", run: exportConfigs },
    { id: "project", title: "Project Info…", group: "File", icon: "info", run: () => void (app.sheet = "project") },
    { id: "welcome", title: "Show Welcome & Sample Labs", group: "File", icon: "sparkle", run: () => void (app.sheet = "welcome") },
    { id: "undo", title: "Undo", group: "Edit", shortcut: "Z", icon: "undo", run: () => app.undo() },
    { id: "redo", title: "Redo", group: "Edit", shortcut: "⇧Z", icon: "redo", run: () => app.redo() },
    { id: "dup", title: "Duplicate Selection", group: "Edit", shortcut: "D", icon: "duplicate", run: duplicateSelection },
    { id: "delete", title: "Delete Selection", group: "Edit", icon: "trash", run: deleteSelection },
    { id: "selectall", title: "Select All Devices", group: "Edit", shortcut: "A", run: selectAll },
    { id: "tool-select", title: "Select Tool", group: "Tools", icon: "cursor", run: () => void (app.tool = "select") },
    { id: "tool-connect", title: "Connect Tool (Cables)", group: "Tools", icon: "cable", run: () => void (app.tool = "connect") },
    { id: "tool-note", title: "Note Tool", group: "Tools", icon: "note", run: () => void (app.tool = "note") },
    { id: "tool-pdu", title: "Add Simple PDU (Ping)", group: "Tools", icon: "envelope", run: () => void (app.tool = "pdu") },
    { id: "tool-delete", title: "Delete Tool", group: "Tools", icon: "trash", run: () => void (app.tool = "delete") },
    { id: "realtime", title: "Switch to Realtime Mode", group: "Simulation", icon: "clock", run: () => app.setMode("realtime") },
    { id: "simulation", title: "Switch to Simulation Mode", group: "Simulation", icon: "play", run: () => app.setMode("simulation") },
    { id: "step", title: "Step Forward", group: "Simulation", icon: "step", run: () => app.step() },
    { id: "ff", title: "Fast Forward Time (30 s)", group: "Simulation", icon: "forward", run: () => app.fastForward() },
    { id: "reset", title: "Reset Simulation", group: "Simulation", icon: "reset", run: () => app.resetSimulation() },
    { id: "zoomin", title: "Zoom In", group: "View", shortcut: "+", icon: "zoomIn", run: () => zoom(1.2) },
    { id: "zoomout", title: "Zoom Out", group: "View", shortcut: "-", icon: "zoomOut", run: () => zoom(1 / 1.2) },
    { id: "fit", title: "Zoom to Fit", group: "View", shortcut: "0", icon: "fit", run: () => zoomToFit() },
    { id: "library", title: "Toggle Device Library", group: "View", icon: "sidebar", run: () => void (app.showLibrary = !app.showLibrary) },
    { id: "inspector", title: "Toggle Inspector", group: "View", icon: "inspector", run: () => void (app.showInspector = !app.showInspector) },
    { id: "prefs", title: "Settings…", group: "App", shortcut: ",", icon: "gear", run: () => void (app.sheet = "prefs") },
    { id: "shortcuts", title: "Keyboard Shortcuts", group: "App", icon: "keyboard", run: () => void (app.sheet = "shortcuts") },
    { id: "about", title: "About OpenPacketLab", group: "App", icon: "info", run: () => void (app.sheet = "about") },
    ...LIBRARY.map((t) => ({ id: `add-${t.kind}-${t.variant ?? ""}`, title: `Add ${t.label}`, group: "Devices", icon: "plus", run: () => void app.addDevice(t, (-app.view.x + 400) / app.view.zoom, (-app.view.y + 300) / app.view.zoom) })),
  ];
}
