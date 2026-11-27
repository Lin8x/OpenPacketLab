// Google Drive, OneDrive and Dropbox, using the tokens from oauth.ts.
import type { Provider, StoredFile } from "../types";
import { checkOk, httpFetch, joinPath } from "../env";
import { OAUTH, accessToken, credentialsFor } from "../oauth";

type Settings = Record<string, string>;

// ------------------------------------------------------------------ Google Drive

export function gdriveProvider(destId: string, s: Settings): Provider {
  const p = OAUTH.gdrive;
  const cred = credentialsFor(p, s);
  const token = () => accessToken(destId, p, cred);
  const API = "https://www.googleapis.com/drive/v3";
  const FOLDER = "application/vnd.google-apps.folder";
  const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  async function api(url: string, init: RequestInit = {}) {
    const res = await httpFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await token()}` } });
    return checkOk(res, "Google Drive");
  }
  async function findChild(parent: string, name: string, folder: boolean): Promise<string | null> {
    const query = `name='${q(name)}' and '${parent}' in parents and trashed=false and mimeType${folder ? "=" : "!="}'${FOLDER}'`;
    const res = await api(`${API}/files?${new URLSearchParams({ q: query, fields: "files(id,name)", spaces: "drive", pageSize: "10" })}`);
    const json = (await res.json()) as { files: { id: string }[] };
    return json.files[0]?.id ?? null;
  }
  async function folderId(path: string, create: boolean): Promise<string | null> {
    let parent = "root";
    for (const part of path.split("/").filter(Boolean)) {
      let id = await findChild(parent, part, true);
      if (!id) {
        if (!create) return null;
        const res = await api(`${API}/files?fields=id`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: part, mimeType: FOLDER, parents: [parent] }) });
        id = ((await res.json()) as { id: string }).id;
      }
      parent = id;
    }
    return parent;
  }
  const split = (path: string) => {
    const full = joinPath(s.folder || "OpenPacketLab Backups", path);
    const i = full.lastIndexOf("/");
    return { dir: i < 0 ? "" : full.slice(0, i), name: i < 0 ? full : full.slice(i + 1) };
  };

  return {
    async put(path, data) {
      const { dir, name } = split(path);
      const parent = (await folderId(dir, true))!;
      const existing = await findChild(parent, name, false);
      const boundary = "opl" + Math.random().toString(36).slice(2);
      const meta = existing ? { name } : { name, parents: [parent] };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${data}\r\n--${boundary}--`;
      const url = existing ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=multipart` : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
      await api(url, { method: existing ? "PATCH" : "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
    },
    async list(folder) {
      const id = await folderId(joinPath(s.folder || "OpenPacketLab Backups", folder), false);
      if (!id) return [];
      const out: StoredFile[] = [];
      let page = "";
      do {
        const params = new URLSearchParams({ q: `'${id}' in parents and trashed=false and mimeType!='${FOLDER}'`, fields: "nextPageToken,files(name)", pageSize: "1000" });
        if (page) params.set("pageToken", page);
        const json = (await (await api(`${API}/files?${params}`)).json()) as { files: { name: string }[]; nextPageToken?: string };
        out.push(...json.files.map((f) => ({ name: f.name })));
        page = json.nextPageToken ?? "";
      } while (page);
      return out;
    },
    async remove(path) {
      const { dir, name } = split(path);
      const parent = await folderId(dir, false);
      const id = parent && (await findChild(parent, name, false));
      if (id) await api(`${API}/files/${id}`, { method: "DELETE" });
    },
    async test() {
      const json = (await (await api(`${API}/about?fields=user(emailAddress,displayName)`)).json()) as { user?: { emailAddress?: string; displayName?: string } };
      return `Signed in to Google Drive${json.user?.emailAddress ? ` as ${json.user.emailAddress}` : ""}.`;
    },
  };
}

// ------------------------------------------------------------------ OneDrive

export function onedriveProvider(destId: string, s: Settings): Provider {
  const p = OAUTH.onedrive;
  const cred = credentialsFor(p, s);
  const G = "https://graph.microsoft.com/v1.0/me/drive/special/approot";
  const enc = (path: string) => joinPath(s.folder, path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  async function api(url: string, init: RequestInit = {}) {
    const res = await httpFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await accessToken(destId, p, cred)}` } });
    return res;
  }
  return {
    async put(path, data) {
      await checkOk(await api(`${G}:/${enc(path)}:/content`, { method: "PUT", headers: { "content-type": "application/json" }, body: data }), "OneDrive upload");
    },
    async list(folder) {
      const e = enc(folder);
      let url: string | undefined = e ? `${G}:/${e}:/children?$select=name,file&$top=999` : `${G}/children?$select=name,file&$top=999`;
      const out: StoredFile[] = [];
      while (url) {
        const res = await api(url);
        if (res.status === 404) return [];
        const json = (await (await checkOk(res, "OneDrive")).json()) as { value: { name: string; file?: unknown }[]; "@odata.nextLink"?: string };
        out.push(...json.value.filter((v) => v.file).map((v) => ({ name: v.name })));
        url = json["@odata.nextLink"];
      }
      return out;
    },
    async remove(path) {
      const res = await api(`${G}:/${enc(path)}`, { method: "DELETE" });
      if (res.status !== 404) await checkOk(res, "OneDrive delete");
    },
    async test() {
      const res = await checkOk(await api("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName"), "OneDrive");
      const json = (await res.json()) as { userPrincipalName?: string };
      return `Signed in to OneDrive${json.userPrincipalName ? ` as ${json.userPrincipalName}` : ""}. Backups go to Apps/OpenPacketLab.`;
    },
  };
}

// ------------------------------------------------------------------ Dropbox

/** Dropbox-API-Arg must be ASCII. */
const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

export function dropboxProvider(destId: string, s: Settings): Provider {
  const p = OAUTH.dropbox;
  const cred = credentialsFor(p, s);
  const full = (path: string) => "/" + joinPath(s.folder || "OpenPacketLab", path);
  async function rpc(endpoint: string, arg: unknown) {
    return httpFetch(`https://api.dropboxapi.com/2/${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${await accessToken(destId, p, cred)}`, "content-type": "application/json" }, body: JSON.stringify(arg) });
  }
  return {
    async put(path, data) {
      const res = await httpFetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: { authorization: `Bearer ${await accessToken(destId, p, cred)}`, "content-type": "application/octet-stream", "Dropbox-API-Arg": asciiJson({ path: full(path), mode: "overwrite", mute: true }) },
        body: data,
      });
      await checkOk(res, "Dropbox upload");
    },
    async list(folder) {
      let res = await rpc("files/list_folder", { path: full(folder).replace(/\/$/, "") });
      if (res.status === 409) return [];
      const out: StoredFile[] = [];
      for (;;) {
        const json = (await (await checkOk(res, "Dropbox")).json()) as { entries: { ".tag": string; name: string }[]; has_more: boolean; cursor: string };
        out.push(...json.entries.filter((e) => e[".tag"] === "file").map((e) => ({ name: e.name })));
        if (!json.has_more) break;
        res = await rpc("files/list_folder/continue", { cursor: json.cursor });
      }
      return out;
    },
    async remove(path) {
      const res = await rpc("files/delete_v2", { path: full(path) });
      if (res.status !== 409) await checkOk(res, "Dropbox delete");
    },
    async test() {
      const res = await checkOk(await rpc("users/get_current_account", null), "Dropbox");
      const json = (await res.json()) as { email?: string };
      return `Signed in to Dropbox${json.email ? ` as ${json.email}` : ""}.`;
    },
  };
}
