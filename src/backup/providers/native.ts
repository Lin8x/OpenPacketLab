// Destinations handled by the desktop app's native side: folders and shares, SFTP, FTP/FTPS, rclone.
import type { Provider } from "../types";
import { isDesktop, joinPath, native } from "../env";

// ------------------------------------------------------------------ Folder / SMB share

export function folderProvider(root: string): Provider {
  if (!isDesktop) return browserFolderProvider(root);
  const full = (p: string) => (p ? `${root.replace(/[\\/]+$/, "")}/${p}` : root);
  return {
    put: (path, data) => native("backup_folder_write", { path: full(path), contents: data }),
    list: async (folder) => (await native<string[]>("backup_folder_list", { path: full(folder) })).map((name) => ({ name })),
    remove: (path) => native("backup_folder_remove", { path: full(path) }),
    test: async () => {
      await native("backup_folder_write", { path: full(".openpacketlab-test"), contents: "ok" });
      await native("backup_folder_remove", { path: full(".openpacketlab-test") });
      return `Can write to ${root}.`;
    },
  };
}

// The browser build can write to a folder the user picked (Chromium's File System Access API).
type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  queryPermission?(o: { mode: string }): Promise<string>;
  requestPermission?(o: { mode: string }): Promise<string>;
};

const HANDLE_DB = "openpacketlab-handles";
function handleStore(mode: IDBTransactionMode) {
  return new Promise<IDBObjectStore>((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("h");
    req.onsuccess = () => resolve(req.result.transaction("h", mode).objectStore("h"));
    req.onerror = () => reject(req.error);
  });
}
export async function saveDirHandle(key: string, h: FileSystemDirectoryHandle) {
  const s = await handleStore("readwrite");
  await new Promise((r, j) => {
    const q = s.put(h, key);
    q.onsuccess = r;
    q.onerror = j;
  });
}
async function loadDirHandle(key: string): Promise<DirHandle | null> {
  const s = await handleStore("readonly");
  return new Promise((r) => {
    const q = s.get(key);
    q.onsuccess = () => r((q.result as DirHandle) ?? null);
    q.onerror = () => r(null);
  });
}
export const canPickFolder = typeof window !== "undefined" && "showDirectoryPicker" in window;

function browserFolderProvider(key: string): Provider {
  async function dir(path: string, create: boolean): Promise<DirHandle | null> {
    let h = await loadDirHandle(key);
    if (!h) throw new Error("Choose a folder for this destination first.");
    if (h.queryPermission && (await h.queryPermission({ mode: "readwrite" })) !== "granted") {
      if (!h.requestPermission || (await h.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("Permission to write to the folder was not granted.");
    }
    for (const part of path.split("/").filter(Boolean)) {
      try {
        h = (await h.getDirectoryHandle(part, { create })) as DirHandle;
      } catch {
        return null;
      }
    }
    return h;
  }
  const split = (p: string) => {
    const i = p.lastIndexOf("/");
    return [i < 0 ? "" : p.slice(0, i), i < 0 ? p : p.slice(i + 1)];
  };
  return {
    async put(path, data) {
      const [d, name] = split(path);
      const h = (await dir(d, true))!;
      const f = await h.getFileHandle(name, { create: true });
      const w = await f.createWritable();
      await w.write(data);
      await w.close();
    },
    async list(folder) {
      const h = await dir(folder, false);
      if (!h) return [];
      const out = [];
      for await (const e of h.values()) if (e.kind === "file") out.push({ name: e.name });
      return out;
    },
    async remove(path) {
      const [d, name] = split(path);
      const h = await dir(d, false);
      await h?.removeEntry(name).catch(() => {});
    },
    async test() {
      const h = await dir("", false);
      return `Can write to “${h?.name}”.`;
    },
  };
}

// ------------------------------------------------------------------ SFTP

export interface SftpConfig {
  host: string;
  port: string;
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  folder: string;
  fingerprint: string;
}

export function sftpProvider(c: SftpConfig, onFingerprint?: (fp: string) => void): Provider {
  const conn = () => ({
    host: c.host,
    port: Number(c.port) || 22,
    username: c.username,
    password: c.password || null,
    privateKey: c.privateKey || null,
    passphrase: c.passphrase || null,
    fingerprint: c.fingerprint || null,
  });
  const full = (p: string) => joinPath(c.folder, p) || ".";
  return {
    put: (path, data) => native("backup_sftp_put", { conn: conn(), path: full(path), contents: data }),
    list: async (folder) => (await native<string[]>("backup_sftp_list", { conn: conn(), path: full(folder) })).map((name) => ({ name })),
    remove: (path) => native("backup_sftp_remove", { conn: conn(), path: full(path) }),
    async test() {
      const fp = await native<string>("backup_sftp_test", { conn: conn() });
      if (!c.fingerprint) onFingerprint?.(fp);
      return `Connected to ${c.host}. Server key ${fp}.`;
    },
  };
}

// ------------------------------------------------------------------ FTP / FTPS

export interface FtpConfig {
  host: string;
  port: string;
  username: string;
  password: string;
  folder: string;
  security: string; // "none" | "explicit" | "implicit"
}

export function ftpProvider(c: FtpConfig): Provider {
  const conn = () => ({ host: c.host, port: Number(c.port) || (c.security === "implicit" ? 990 : 21), username: c.username || "anonymous", password: c.password || "", security: c.security || "explicit" });
  const full = (p: string) => joinPath(c.folder, p);
  return {
    put: (path, data) => native("backup_ftp_put", { conn: conn(), path: full(path), contents: data }),
    list: async (folder) => (await native<string[]>("backup_ftp_list", { conn: conn(), path: full(folder) })).map((name) => ({ name })),
    remove: (path) => native("backup_ftp_remove", { conn: conn(), path: full(path) }),
    test: async () => `Connected to ${c.host}. ${await native<string>("backup_ftp_test", { conn: conn() })}`,
  };
}

// ------------------------------------------------------------------ rclone

export function rcloneProvider(remote: string, binary: string): Provider {
  const target = (p: string) => `${remote.replace(/\/+$/, "")}${remote.endsWith(":") ? "" : "/"}${p}`;
  const bin = binary || "rclone";
  return {
    put: (path, data) => native("backup_rclone_put", { binary: bin, target: target(path), contents: data }),
    list: async (folder) => (await native<string[]>("backup_rclone_list", { binary: bin, target: target(folder) })).map((name) => ({ name })),
    remove: (path) => native("backup_rclone_remove", { binary: bin, target: target(path) }),
    test: async () => native<string>("backup_rclone_test", { binary: bin, target: target("") }),
  };
}
