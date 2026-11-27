// WebDAV: Nextcloud, ownCloud, Box, Koofr, pCloud, Synology, Apache/nginx dav, and others.
import type { Provider, StoredFile } from "../types";
import { checkOk, httpFetch, joinPath } from "../env";

export interface WebDavConfig {
  url: string;
  folder: string;
  username: string;
  password: string;
}

export function webdavProvider(c: WebDavConfig): Provider {
  const root = c.url.replace(/\/+$/, "");
  const auth: Record<string, string> = c.username || c.password ? { authorization: "Basic " + btoa(unescape(encodeURIComponent(`${c.username}:${c.password}`))) } : {};
  const urlOf = (p: string) => root + "/" + joinPath(c.folder, p).split("/").filter(Boolean).map(encodeURIComponent).join("/");

  async function ensureFolders(path: string) {
    const parts = joinPath(c.folder, path).split("/").filter(Boolean);
    parts.pop();
    let cur = "";
    for (const part of parts) {
      cur += "/" + encodeURIComponent(part);
      const res = await httpFetch(root + cur + "/", { method: "MKCOL", headers: auth });
      // 201 created, 405 already exists, 301/302 some servers redirect existing collections.
      if (!res.ok && ![301, 302, 405].includes(res.status)) await checkOk(res, "Creating a folder");
    }
  }

  return {
    async put(path, data) {
      await ensureFolders(path);
      await checkOk(await httpFetch(urlOf(path), { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: data }), "WebDAV upload");
    },
    async list(folder) {
      const u = urlOf(folder).replace(/\/?$/, "/");
      const res = await httpFetch(u, { method: "PROPFIND", headers: { ...auth, depth: "1", "content-type": "application/xml" }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' });
      if (res.status === 404) return [];
      await checkOk(res, "Listing the folder");
      const xml = await res.text();
      const out: StoredFile[] = [];
      for (const m of xml.matchAll(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/g)) {
        const block = m[0];
        if (/<(?:\w+:)?collection\s*\/>/.test(block)) continue;
        const href = /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/.exec(block)?.[1];
        if (!href) continue;
        const name = decodeURIComponent(href.replace(/\/+$/, "").split("/").pop() ?? "");
        if (name) out.push({ name });
      }
      return out;
    },
    async remove(path) {
      await checkOk(await httpFetch(urlOf(path), { method: "DELETE", headers: auth }), "Deleting an old backup");
    },
    async test() {
      const res = await httpFetch(root + "/", { method: "PROPFIND", headers: { ...auth, depth: "0" } });
      await checkOk(res, "Connecting to the WebDAV server");
      return `Connected to ${new URL(root).host}.`;
    },
  };
}
