// Local backups in IndexedDB. Nothing leaves the device.

export interface BackupMeta {
  id: number;
  projectId: string;
  name: string;
  time: number;
  label?: string;
  size: number;
}

interface BackupRow extends BackupMeta {
  data: string;
}

const DB = "openpacketlab";
const STORE = "backups";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const s = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      s.createIndex("projectId", "projectId");
      s.createIndex("time", "time");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const s = t.objectStore(STORE);
        const r = fn(s);
        t.oncomplete = () => resolve(r ? r.result : undefined);
        t.onerror = () => reject(t.error);
      }),
  );
}

export const backups = {
  limit: 30,

  async save(projectId: string, name: string, data: string, label?: string) {
    if (typeof indexedDB === "undefined") return;
    const all = await this.list();
    // Skip identical consecutive autosaves.
    const last = all.find((b) => b.projectId === projectId);
    if (!label && last) {
      const prev = await this.load(last.id);
      if (prev && stripTimes(prev) === stripTimes(data)) return;
    }
    await tx("readwrite", (s) => s.add({ projectId, name, time: Date.now(), label, size: data.length, data } as Omit<BackupRow, "id">));
    // Retention: keep labelled versions, trim autosaves beyond the limit per project.
    const mine = (await this.list()).filter((b) => b.projectId === projectId && !b.label);
    for (const old of mine.slice(this.limit)) await this.remove(old.id);
  },

  async list(): Promise<BackupMeta[]> {
    if (typeof indexedDB === "undefined") return [];
    const rows = ((await tx("readonly", (s) => s.getAll())) ?? []) as BackupRow[];
    return rows.map(({ data: _d, ...m }) => m).sort((a, b) => b.time - a.time);
  },

  async load(id: number): Promise<string | undefined> {
    const row = (await tx("readonly", (s) => s.get(id))) as BackupRow | undefined;
    return row?.data;
  },

  async remove(id: number) {
    await tx("readwrite", (s) => s.delete(id));
  },

  async clear() {
    await tx("readwrite", (s) => s.clear());
  },
};

function stripTimes(s: string) {
  return s.replace(/"modified":"[^"]*"/, "");
}
