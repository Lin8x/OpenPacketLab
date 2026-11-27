// Any HTTP endpoint that accepts an upload (your own server, a webhook, an object store presigned URL).
import type { Provider } from "../types";
import { checkOk, httpFetch } from "../env";

export interface HttpConfig {
  url: string; // may contain {path}
  method: string;
  headers: string; // "Name: value" lines
  token: string;
}

export function httpProvider(c: HttpConfig): Provider {
  const headers = () => {
    const h: Record<string, string> = { "content-type": "application/json" };
    for (const line of (c.headers ?? "").split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (c.token) h.authorization = `Bearer ${c.token}`;
    return h;
  };
  const target = (path: string) => (c.url.includes("{path}") ? c.url.replace("{path}", path.split("/").map(encodeURIComponent).join("/")) : c.url.replace(/\/?$/, "/") + path.split("/").map(encodeURIComponent).join("/"));
  return {
    async put(path, data) {
      const h = headers();
      h["x-openpacketlab-path"] = path;
      await checkOk(await httpFetch(target(path), { method: c.method || "PUT", headers: h, body: data }), "Upload");
    },
    async test() {
      const res = await httpFetch(target("openpacketlab-test.json"), { method: c.method || "PUT", headers: { ...headers(), "x-openpacketlab-path": "openpacketlab-test.json" }, body: JSON.stringify({ test: true, time: new Date().toISOString() }) });
      await checkOk(res, "Test upload");
      return `The server accepted a test upload (HTTP ${res.status}).`;
    },
  };
}
