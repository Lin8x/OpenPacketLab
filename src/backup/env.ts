// Platform glue for backups: HTTP without CORS limits on desktop, secrets, native commands.

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** fetch() that goes through the desktop app's HTTP client (no CORS) when available. */
export async function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isDesktop) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch(input, init);
  }
  return fetch(input, init);
}

export async function native<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isDesktop) throw new Error("This destination needs the OpenPacketLab desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : (e as Error).message ?? String(e));
  }
}

export async function openExternal(url: string) {
  if (isDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    return openUrl(url);
  }
  window.open(url, "_blank", "noopener");
}

/**
 * Secrets (passwords, keys, tokens). Desktop: a file in the app's config folder readable only
 * by you. Browser: this site's local storage on this device.
 */
const LS_KEY = "openpacketlab.secrets";
let cache: Record<string, string> | null = null;

async function loadAll(): Promise<Record<string, string>> {
  if (cache) return cache;
  if (isDesktop) cache = await native<Record<string, string>>("secrets_load");
  else {
    try {
      cache = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
    } catch {
      cache = {};
    }
  }
  return cache!;
}

async function persist() {
  if (!cache) return;
  if (isDesktop) await native("secrets_save", { secrets: cache });
  else localStorage.setItem(LS_KEY, JSON.stringify(cache));
}

export const secrets = {
  async get(destId: string, key: string): Promise<string> {
    return (await loadAll())[`${destId}.${key}`] ?? "";
  },
  async set(destId: string, key: string, value: string) {
    const all = await loadAll();
    if (value) all[`${destId}.${key}`] = value;
    else delete all[`${destId}.${key}`];
    await persist();
  },
  async removeAll(destId: string) {
    const all = await loadAll();
    for (const k of Object.keys(all)) if (k.startsWith(destId + ".")) delete all[k];
    await persist();
  },
  /** For tests. */
  useMemory(initial: Record<string, string> = {}) {
    cache = initial;
  },
};

export function joinPath(...parts: string[]) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "");
}

export async function checkOk(res: Response, what: string) {
  if (res.ok) return res;
  let body = "";
  try {
    body = await res.text();
    const xmlMsg = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
    let jsonMsg: string | undefined;
    try {
      const j = JSON.parse(body);
      jsonMsg = j.error_description ?? j.error?.message ?? j.error_summary ?? (typeof j.error === "string" ? j.error : undefined);
    } catch {
      /* not JSON */
    }
    body = (xmlMsg ?? jsonMsg ?? body.replace(/<[^>]+>/g, " ")).trim().slice(0, 200);
  } catch {
    /* ignore */
  }
  const hint = res.status === 401 || res.status === 403 ? " Check the credentials and permissions." : res.status === 404 ? " Check the bucket, folder or URL." : "";
  throw new Error(`${what} failed (HTTP ${res.status}).${hint}${body ? " " + body.replace(/\s+/g, " ") : ""}`);
}
