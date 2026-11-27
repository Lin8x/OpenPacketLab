// Amazon S3 and S3-compatible storage, signed with AWS Signature Version 4.
import type { Provider, StoredFile } from "../types";
import { checkOk, httpFetch, joinPath } from "../env";

export interface S3Config {
  endpoint: string; // e.g. https://s3.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://localhost:9000
  region: string;
  bucket: string;
  prefix: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: string | Uint8Array) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : (data as BufferSource)));
async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
const uriEncode = (s: string, slash = true) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(slash ? /%2F/g : /$^/, "/");

export async function signV4(opts: {
  method: string;
  url: URL;
  region: string;
  accessKey: string;
  secretKey: string;
  body: string;
  headers?: Record<string, string>;
  now?: Date;
}): Promise<Record<string, string>> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(opts.body);
  const headers: Record<string, string> = { ...(opts.headers ?? {}), host: opts.url.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const query = [...opts.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [opts.method, uriEncode(decodeURIComponent(opts.url.pathname)), query, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${opts.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key: ArrayBuffer = await hmac(enc.encode("AWS4" + opts.secretKey), day);
  key = await hmac(key, opts.region);
  key = await hmac(key, "s3");
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  const out: Record<string, string> = { ...(opts.headers ?? {}), "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  out.authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return out;
}

export function s3Provider(c: S3Config): Provider {
  const base = new URL(c.endpoint || `https://s3.${c.region || "us-east-1"}.amazonaws.com`);
  const region = c.region || "us-east-1";
  const urlFor = (key: string, query: Record<string, string> = {}) => {
    const u = new URL(base.toString());
    const k = key ? "/" + key.split("/").map((p) => uriEncode(p, false)).join("/") : "/";
    if (c.pathStyle) u.pathname = `/${c.bucket}${k}`.replace(/\/{2,}/g, "/");
    else {
      u.hostname = `${c.bucket}.${u.hostname}`;
      u.pathname = k;
    }
    for (const [q, v] of Object.entries(query)) u.searchParams.set(q, v);
    return u;
  };
  const call = async (method: string, key: string, body = "", query: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const url = urlFor(key, query);
    const signed = await signV4({ method, url, region, accessKey: c.accessKey, secretKey: c.secretKey, body, headers });
    return httpFetch(url.toString(), { method, headers: signed, body: method === "PUT" ? body : undefined });
  };
  const full = (p: string) => joinPath(c.prefix, p);

  return {
    async put(path, data) {
      await checkOk(await call("PUT", full(path), data, {}, { "content-type": "application/json" }), "Upload to S3");
    },
    async list(folder) {
      const prefix = full(folder) ? full(folder) + "/" : "";
      const out: StoredFile[] = [];
      let token = "";
      do {
        const q: Record<string, string> = { "list-type": "2", delimiter: "/" };
        if (prefix) q.prefix = prefix;
        if (token) q["continuation-token"] = token;
        const res = await checkOk(await call("GET", "", "", q), "Listing the bucket");
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<\/Contents>/g)) {
          const key = decodeXml(m[1]);
          out.push({ name: key.slice(prefix.length) });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? "") : "";
      } while (token);
      return out;
    },
    async remove(path) {
      await checkOk(await call("DELETE", full(path)), "Deleting an old backup");
    },
    async test() {
      const q: Record<string, string> = { "list-type": "2", "max-keys": "1" };
      if (c.prefix) q.prefix = c.prefix.replace(/\/?$/, "/");
      const res = await call("GET", "", "", q);
      await checkOk(res, "Connecting to the bucket");
      return `Connected to bucket “${c.bucket}”.`;
    },
  };
}

function decodeXml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
