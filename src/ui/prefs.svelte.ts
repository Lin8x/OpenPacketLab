// User preferences, stored locally.

const KEY = "openpacketlab.prefs";

interface Prefs {
  appearance: "system" | "light" | "dark";
  autosaveSeconds: number;
  backupCount: number;
  showPortLabels: boolean;
  showLinkLights: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  fastStp: boolean;
  terminalFontSize: number;
  accent: string;
  recent: { name: string; path: string; time: number }[];
}

const defaults: Prefs = {
  appearance: "system",
  autosaveSeconds: 30,
  backupCount: 30,
  showPortLabels: true,
  showLinkLights: true,
  showGrid: true,
  snapToGrid: false,
  fastStp: false,
  terminalFontSize: 13,
  accent: "blue",
  recent: [],
};

function load(): Prefs {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...defaults };
  }
}

export const prefs = $state<Prefs>(typeof localStorage === "undefined" ? { ...defaults } : load());

export function savePrefs() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}
