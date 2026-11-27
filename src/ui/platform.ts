// File access for the desktop app (Tauri) and the browser/Docker build.

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const FILTERS = [{ name: "OpenPacketLab Project", extensions: ["opl", "json"] }];

export interface OpenedFile {
  name: string;
  path: string | null;
  text: string;
}

export async function openProjectFile(): Promise<OpenedFile | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, directory: false, filters: FILTERS });
    if (!path || Array.isArray(path)) return null;
    return { name: basename(path), path, text: await readTextFile(path) };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".opl,.json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, path: null, text: await f.text() });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function readPath(path: string): Promise<string> {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  return readTextFile(path);
}

/** Saves text. Returns the path written to (desktop) or null (download). */
export async function saveProjectFile(text: string, suggested: string, path: string | null, saveAs = false): Promise<string | null | false> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    let target = path;
    if (!target || saveAs) {
      const p = await save({ defaultPath: `${suggested}.opl`, filters: FILTERS });
      if (!p) return false;
      target = p;
    }
    await writeTextFile(target, text);
    return target;
  }
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: `${suggested}.opl`, types: [{ description: "OpenPacketLab Project", accept: { "application/json": [".opl"] } }] });
      const ws = await handle.createWritable();
      await ws.write(text);
      await ws.close();
      return handle.name;
    } catch (e) {
      if ((e as Error).name === "AbortError") return false;
    }
  }
  download(text, `${suggested}.opl`, "application/json");
  return null;
}

export function download(text: string, filename: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function basename(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const mod = isMac ? "⌘" : "Ctrl+";
