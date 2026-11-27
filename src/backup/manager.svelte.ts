// Runs backups to every configured destination on its own schedule.
import type { Destination, DestinationKind, RunRecord } from "./types";
import { isDue, expandPath, nextRun, pruneList, retentionKey } from "./schedule";
import { kindInfo, providerFor } from "./kinds";
import { secrets } from "./env";

export interface LabPayload {
  id: string;
  name: string;
  data: string;
}

export interface BackupSources {
  current(): LabPayload | null;
  all(): Promise<LabPayload[]>;
}

const DEST_KEY = "openpacketlab.backupDestinations";
const HIST_KEY = "openpacketlab.backupHistory";
const STATE_KEY = "openpacketlab.backupState";
const HISTORY_MAX = 300;

interface DestState {
  lastRun: number | null; // last attempt
  lastSuccess: number | null;
  lastHash: string | null;
  failures: number;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or unavailable */
  }
}

async function hash(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.replace(/"modified":"[^"]*"/, "")));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

class BackupManager {
  destinations = $state<Destination[]>(typeof localStorage === "undefined" ? [] : loadJson(DEST_KEY, []));
  history = $state<RunRecord[]>(typeof localStorage === "undefined" ? [] : loadJson(HIST_KEY, []));
  states = $state<Record<string, DestState>>(typeof localStorage === "undefined" ? {} : loadJson(STATE_KEY, {}));
  running = $state<Record<string, boolean>>({});
  private sources: BackupSources | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  onResult: ((d: Destination, r: RunRecord) => void) | null = null;

  start(sources: BackupSources) {
    this.sources = sources;
    this.stop();
    this.timer = setInterval(() => this.tick(), 30_000);
    setTimeout(() => this.tick(), 5_000); // catch up on missed slots shortly after launch
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private persist() {
    saveJson(DEST_KEY, this.destinations);
    saveJson(STATE_KEY, this.states);
  }

  state(id: string): DestState {
    return this.states[id] ?? { lastRun: null, lastSuccess: null, lastHash: null, failures: 0 };
  }

  next(d: Destination): number | null {
    if (!d.enabled) return null;
    const s = this.state(d.id);
    const n = nextRun(d.schedule, s.lastRun, Date.now());
    // After failures, back off: 5, 10, 20 ... up to 60 minutes.
    if (n != null && s.failures > 0 && s.lastRun) return Math.max(n, s.lastRun + Math.min(60, 5 * 2 ** (s.failures - 1)) * 60_000);
    return n;
  }

  create(kind: DestinationKind): Destination {
    const info = kindInfo(kind);
    const settings: Record<string, string> = {};
    for (const f of info.fields) if (!f.secret && f.default) settings[f.key] = f.default;
    const sameKind = this.destinations.filter((d) => d.kind === kind).length;
    return {
      id: "dst_" + Math.random().toString(36).slice(2, 10),
      name: info.label + (sameKind ? ` ${sameKind + 1}` : ""),
      kind,
      enabled: true,
      schedule: { mode: "daily", at: "02:00" },
      scope: "current",
      path: "{name}/{name}_{datetime}.opl",
      keep: 30,
      skipUnchanged: true,
      settings,
      created: Date.now(),
    };
  }

  save(d: Destination) {
    const i = this.destinations.findIndex((x) => x.id === d.id);
    const copy = $state.snapshot(d) as Destination;
    if (i < 0) this.destinations = [...this.destinations, copy];
    else this.destinations = this.destinations.map((x) => (x.id === d.id ? copy : x));
    this.persist();
  }

  async remove(id: string) {
    this.destinations = this.destinations.filter((d) => d.id !== id);
    delete this.states[id];
    this.history = this.history.filter((h) => h.destination !== id);
    saveJson(HIST_KEY, this.history);
    this.persist();
    await secrets.removeAll(id);
  }

  setEnabled(id: string, on: boolean) {
    const d = this.destinations.find((x) => x.id === id);
    if (!d) return;
    this.save({ ...d, enabled: on });
  }

  private record(r: RunRecord) {
    this.history = [r, ...this.history].slice(0, HISTORY_MAX);
    saveJson(HIST_KEY, this.history);
  }

  historyFor(id: string) {
    return this.history.filter((h) => h.destination === id);
  }

  /** Called every 30 seconds while the app is open. */
  async tick() {
    const now = Date.now();
    for (const d of this.destinations) {
      if (!d.enabled || this.running[d.id]) continue;
      const due = this.next(d);
      if (due != null && due <= now && isDue(d.schedule, this.state(d.id).lastRun, now)) await this.run(d.id, "schedule");
    }
  }

  /** Called after the user saves a project. */
  async onSaved() {
    for (const d of this.destinations) if (d.enabled && d.schedule.mode === "onSave") await this.run(d.id, "save");
  }

  async test(d: Destination): Promise<{ ok: boolean; message: string }> {
    try {
      const p = await providerFor(d, {
        onFingerprint: (fp) => {
          d.settings = { ...d.settings, fingerprint: fp };
          if (this.destinations.some((x) => x.id === d.id)) this.save(d);
        },
      });
      return { ok: true, message: await p.test() };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async run(id: string, trigger: RunRecord["trigger"] = "manual"): Promise<RunRecord | null> {
    const d = this.destinations.find((x) => x.id === id);
    if (!d || !this.sources || this.running[id]) return null;
    this.running = { ...this.running, [id]: true };
    const st = { ...this.state(id) };
    const time = Date.now();
    let rec: RunRecord;
    try {
      const labs = d.scope === "all" ? await this.sources.all() : [this.sources.current()].filter((x): x is LabPayload => !!x && x.data.length > 0);
      if (!labs.length) throw new Error("There is no lab to back up yet.");
      const digest = await hash(labs.map((l) => l.data).join("\n"));
      if (trigger !== "manual" && d.skipUnchanged && st.lastHash === digest) {
        rec = { destination: id, time, ok: true, message: "No changes since the last backup", trigger };
        st.lastRun = time;
        st.failures = 0;
      } else {
        const provider = await providerFor(d);
        const files: string[] = [];
        let bytes = 0;
        for (const lab of labs) {
          const path = expandPath(d.path || "{name}_{datetime}.opl", { name: lab.name, id: lab.id, time });
          await provider.put(path, lab.data);
          files.push(path);
          bytes += lab.data.length;
          if (d.keep > 0 && provider.list && provider.remove) {
            const { folder } = retentionKey(path);
            const names = (await provider.list(folder)).map((f) => f.name);
            for (const old of pruneList(names, d.path, { name: lab.name, id: lab.id }, d.keep)) await provider.remove(folder ? `${folder}/${old}` : old);
          }
        }
        rec = { destination: id, time, ok: true, message: files.length === 1 ? `Saved ${files[0]}` : `Saved ${files.length} labs`, files, bytes, trigger };
        st.lastRun = time;
        st.lastSuccess = time;
        st.lastHash = digest;
        st.failures = 0;
      }
    } catch (e) {
      rec = { destination: id, time, ok: false, message: (e as Error).message || String(e), trigger };
      st.lastRun = time;
      st.failures += 1;
    }
    this.states = { ...this.states, [id]: st };
    this.persist();
    this.record(rec);
    const { [id]: _, ...rest } = this.running;
    this.running = rest;
    this.onResult?.(d, rec);
    return rec;
  }

  async runAll() {
    for (const d of this.destinations) if (d.enabled) await this.run(d.id, "manual");
  }
}

export const backupManager = new BackupManager();
