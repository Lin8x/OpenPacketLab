import type { Schedule } from "./types";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function parseAt(at = "02:00"): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) return [2, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

/** Most recent scheduled moment at or before `now` (local time), or null for manual/onSave. */
export function lastSlot(s: Schedule, now: number): number | null {
  if (s.mode === "manual" || s.mode === "onSave") return null;
  if (s.mode === "interval") return null;
  const [h, m] = parseAt(s.at);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  let t = d.getTime();
  const days = s.mode === "weekly" ? (s.days?.length ? s.days : [1]) : [0, 1, 2, 3, 4, 5, 6];
  for (let i = 0; i < 8; i++) {
    if (t <= now && days.includes(new Date(t).getDay())) return t;
    const prev = new Date(t);
    prev.setDate(prev.getDate() - 1);
    prev.setHours(h, m, 0, 0);
    t = prev.getTime();
  }
  return null;
}

/** Next time the schedule wants to run after `lastRun`, or null when it never runs on its own. */
export function nextRun(s: Schedule, lastRun: number | null, now: number): number | null {
  if (s.mode === "manual" || s.mode === "onSave") return null;
  if (s.mode === "interval") {
    const every = Math.max(1, s.every ?? 60) * MIN;
    return lastRun == null ? now : lastRun + every;
  }
  const [h, m] = parseAt(s.at);
  const days = s.mode === "weekly" ? (s.days?.length ? s.days : [1]) : [0, 1, 2, 3, 4, 5, 6];
  // A missed slot (app was closed) runs as soon as possible.
  const slot = lastSlot(s, now);
  if (slot != null && (lastRun == null || lastRun < slot)) return slot;
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 9; i++) {
    const t = d.getTime();
    if (t > now && days.includes(d.getDay())) return t;
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return now + DAY;
}

export function isDue(s: Schedule, lastRun: number | null, now: number): boolean {
  const n = nextRun(s, lastRun, now);
  return n != null && n <= now;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(s: Schedule): string {
  switch (s.mode) {
    case "manual":
      return "Only when you click Back Up Now";
    case "onSave":
      return "Every time you save";
    case "interval": {
      const e = s.every ?? 60;
      if (e % 1440 === 0) return e === 1440 ? "Every day" : `Every ${e / 1440} days`;
      if (e % 60 === 0) return e === 60 ? "Every hour" : `Every ${e / 60} hours`;
      return `Every ${e} minutes`;
    }
    case "daily":
      return `Daily at ${s.at ?? "02:00"}`;
    case "weekly": {
      const days = (s.days?.length ? s.days : [1]).slice().sort();
      return `${days.map((d) => DAY_NAMES[d]).join(", ")} at ${s.at ?? "02:00"}`;
    }
  }
}

/** Expands a path template like "{name}/{name}-{datetime}.opl". */
export function expandPath(template: string, vars: { name: string; id: string; time: number }): string {
  const d = new Date(vars.time);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const safe = vars.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").trim() || "Untitled";
  return template
    .replaceAll("{name}", safe)
    .replaceAll("{id}", vars.id)
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replaceAll("{datetime}", `${date}_${time}`)
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

/** The folder part of a path and the file-name prefix that identifies backups of the same lab. */
export function retentionKey(path: string): { folder: string; file: string } {
  const i = path.lastIndexOf("/");
  return { folder: i < 0 ? "" : path.slice(0, i), file: i < 0 ? path : path.slice(i + 1) };
}

/** Files to delete so that only `keep` backups matching the template remain (newest by name). */
export function pruneList(names: string[], template: string, vars: { name: string; id: string }, keep: number): string[] {
  if (keep <= 0) return [];
  const fileTpl = template.slice(template.lastIndexOf("/") + 1);
  // Turn the file template into a regex: lab tokens become literals, time tokens become wildcards.
  const safe = vars.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").trim() || "Untitled";
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    "^" +
      fileTpl
        .split(/(\{name\}|\{id\}|\{date\}|\{time\}|\{datetime\})/)
        .map((part) =>
          part === "{name}" ? esc(safe) : part === "{id}" ? esc(vars.id) : part === "{date}" ? "\\d{4}-\\d{2}-\\d{2}" : part === "{time}" ? "\\d{6}" : part === "{datetime}" ? "\\d{4}-\\d{2}-\\d{2}_\\d{6}" : esc(part),
        )
        .join("") +
      "$",
  );
  const mine = names.filter((n) => re.test(n)).sort();
  return mine.slice(0, Math.max(0, mine.length - keep));
}
