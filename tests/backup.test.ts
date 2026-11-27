import { describe, expect, it } from "vitest";
import { describeSchedule, expandPath, isDue, nextRun, pruneList } from "../src/backup/schedule";
import { signV4 } from "../src/backup/providers/s3";

const at = (s: string) => new Date(s).getTime();

describe("backup schedules", () => {
  it("interval runs immediately the first time, then after the interval", () => {
    const s = { mode: "interval" as const, every: 30 };
    const now = at("2026-03-02T10:00:00");
    expect(isDue(s, null, now)).toBe(true);
    expect(nextRun(s, now, now)).toBe(now + 30 * 60_000);
    expect(isDue(s, now, now + 29 * 60_000)).toBe(false);
    expect(isDue(s, now, now + 30 * 60_000)).toBe(true);
  });

  it("daily runs at the set time and catches up a missed run", () => {
    const s = { mode: "daily" as const, at: "02:00" };
    const ranYesterday = at("2026-03-01T02:00:05");
    expect(isDue(s, ranYesterday, at("2026-03-02T01:59:00"))).toBe(false);
    expect(isDue(s, ranYesterday, at("2026-03-02T02:00:00"))).toBe(true);
    // App was closed at 02:00 and opened at 09:00: run now.
    expect(isDue(s, ranYesterday, at("2026-03-02T09:00:00"))).toBe(true);
    expect(isDue(s, at("2026-03-02T09:00:10"), at("2026-03-02T12:00:00"))).toBe(false);
    expect(nextRun(s, at("2026-03-02T09:00:10"), at("2026-03-02T12:00:00"))).toBe(at("2026-03-03T02:00:00"));
  });

  it("weekly runs only on chosen days", () => {
    // 2026-03-02 is a Monday.
    const s = { mode: "weekly" as const, at: "18:30", days: [3, 5] };
    const last = at("2026-02-27T18:30:00"); // Friday
    expect(nextRun(s, last, at("2026-03-02T12:00:00"))).toBe(at("2026-03-04T18:30:00"));
    expect(isDue(s, last, at("2026-03-04T18:30:00"))).toBe(true);
  });

  it("manual and on-save never run by themselves", () => {
    expect(nextRun({ mode: "manual" }, null, Date.now())).toBeNull();
    expect(nextRun({ mode: "onSave" }, null, Date.now())).toBeNull();
    expect(describeSchedule({ mode: "interval", every: 120 })).toBe("Every 2 hours");
    expect(describeSchedule({ mode: "weekly", at: "09:00", days: [1, 5] })).toBe("Mon, Fri at 09:00");
  });
});

describe("backup paths and retention", () => {
  it("expands templates safely", () => {
    const p = expandPath("{name}/{name}_{datetime}.opl", { name: 'Lab: 1/2 "x"', id: "p1", time: at("2026-03-02T04:05:06") });
    expect(p).toBe("Lab- 1-2 -x-/Lab- 1-2 -x-_2026-03-02_040506.opl");
  });

  it("keeps the newest N backups of the same lab and ignores other files", () => {
    const names = ["Net_2026-01-01_000000.opl", "Net_2026-01-03_000000.opl", "Net_2026-01-02_000000.opl", "Other_2026-01-01_000000.opl", "notes.txt"];
    expect(pruneList(names, "{name}_{datetime}.opl", { name: "Net", id: "x" }, 2)).toEqual(["Net_2026-01-01_000000.opl"]);
    expect(pruneList(names, "{name}_{datetime}.opl", { name: "Net", id: "x" }, 0)).toEqual([]);
  });
});

describe("S3 signature v4", () => {
  it("matches AWS's published GET Object example", async () => {
    const h = await signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      body: "",
      headers: { range: "bytes=0-9" },
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});
