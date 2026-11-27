// Runs against local servers when OPL_IT=1 (see scripts/opl.mjs "it" command):
//   S3 (SeaweedFS) on :8333, WebDAV on :8081.
import { describe, expect, it } from "vitest";
import { s3Provider, signV4 } from "../src/backup/providers/s3";
import { webdavProvider } from "../src/backup/providers/webdav";
import type { Provider } from "../src/backup/types";

const run = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.OPL_IT === "1" ? describe : describe.skip;

async function roundTrip(p: Provider, folder: string) {
  expect(await p.test()).toBeTruthy();
  await p.put(`${folder}/Lab_2026-01-01_000000.opl`, '{"a":1}');
  await p.put(`${folder}/Lab_2026-01-02_000000.opl`, '{"a":2}');
  const names = (await p.list!(folder)).map((f) => f.name).sort();
  expect(names).toEqual(["Lab_2026-01-01_000000.opl", "Lab_2026-01-02_000000.opl"]);
  await p.remove!(`${folder}/Lab_2026-01-01_000000.opl`);
  expect((await p.list!(folder)).map((f) => f.name)).toEqual(["Lab_2026-01-02_000000.opl"]);
}

run("backup providers against real servers", () => {
  it("S3-compatible storage", async () => {
    const cfg = { endpoint: "http://127.0.0.1:8333", region: "us-east-1", bucket: "opl-it", prefix: "nested/prefix", accessKey: "opltest", secretKey: "opltest123", pathStyle: true };
    const url = new URL(`${cfg.endpoint}/${cfg.bucket}`);
    const h = await signV4({ method: "PUT", url, region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey, body: "" });
    await fetch(url, { method: "PUT", headers: h });
    await roundTrip(s3Provider(cfg), "My Lab (1)");
  });

  it("rejects bad S3 credentials with a clear message", async () => {
    const p = s3Provider({ endpoint: "http://127.0.0.1:8333", region: "us-east-1", bucket: "opl-it", prefix: "", accessKey: "opltest", secretKey: "wrong", pathStyle: true });
    await expect(p.test()).rejects.toThrow(/HTTP 403/);
  });

  it("WebDAV", async () => {
    await roundTrip(webdavProvider({ url: "http://127.0.0.1:8081", folder: "backups/deep", username: "opl", password: "oplpass" }), "Lab ü");
  });
});
