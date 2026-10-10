/**
 * sdk-store-quarantine：旧 `run_events.ndjson` 归档（改用内存版 run_events 之后不会再被追加）
 * 与旁路目录的保留策略。GC 自愈走的是同一个目录 / 同一套命名与保留（见 sdk-store-gc-heal.test.ts）。
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveLegacyRunEvents,
  KEEP_QUARANTINE,
  pruneQuarantine,
  QUARANTINE_DIRNAME,
  quarantineFileName,
  RUN_EVENTS_FILENAME,
} from "@/lib/server/sdk-store-quarantine";

import { cleanupTmps, mkTmp } from "./helpers/fast-store-helpers";

const NOW = 1_791_600_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTmps();
});

const legacy = (dir: string): string => path.join(dir, RUN_EVENTS_FILENAME);
const qDirOf = (dir: string): string => path.join(dir, QUARANTINE_DIRNAME);
const names = (dir: string): string[] => fs.readdirSync(qDirOf(dir)).sort();

describe("quarantineFileName", () => {
  it("run_events-<13 位毫秒时间戳>.ndjson，字典序即时间序", () => {
    expect(quarantineFileName(NOW)).toBe(`run_events-${NOW}.ndjson`);
    expect(quarantineFileName(NOW) < quarantineFileName(NOW + 1)).toBe(true);
  });
});

describe("archiveLegacyRunEvents", () => {
  it("没有旧文件：什么都不做，不建旁路目录", async () => {
    const dir = mkTmp();
    expect(await archiveLegacyRunEvents(dir, { now: NOW })).toEqual({ status: "none" });
    expect(fs.existsSync(qDirOf(dir))).toBe(false);
  });

  it("空文件（SDK 的 runs.delete 会顺手建一个）：不挪，原样留着", async () => {
    const dir = mkTmp();
    fs.writeFileSync(legacy(dir), "");
    expect(await archiveLegacyRunEvents(dir, { now: NOW })).toEqual({ status: "none" });
    expect(fs.existsSync(legacy(dir))).toBe(true);
    expect(fs.existsSync(qDirOf(dir))).toBe(false);
  });

  it("有内容：整个挪进 .quarantine/run_events-<ts>.ndjson，内容逐字节一致，原位置不再有", async () => {
    const dir = mkTmp();
    const content = '{"runId":"r","seq":1}\n{"runId":"r","seq":2,"payload":"中文\\n"}\r\n';
    fs.writeFileSync(legacy(dir), content);

    const r = await archiveLegacyRunEvents(dir, { now: NOW });
    expect(r.status).toBe("archived");
    expect(r.bytes).toBe(Buffer.byteLength(content));
    expect(r.file).toBe(path.join(qDirOf(dir), `run_events-${NOW}.ndjson`));
    expect(fs.readFileSync(r.file!, "utf8")).toBe(content);
    expect(fs.existsSync(legacy(dir))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("旁路目录权限 0700（和 GC 自愈一致）", async () => {
    const dir = mkTmp();
    fs.writeFileSync(legacy(dir), "x\n");
    await archiveLegacyRunEvents(dir, { now: NOW });
    expect(fs.statSync(qDirOf(dir)).mode & 0o777).toBe(0o700);
  });

  it("旁路已满 KEEP_QUARANTINE 份：归档后只留最新的几份，最老的被清", async () => {
    const dir = mkTmp();
    fs.mkdirSync(qDirOf(dir), { recursive: true });
    const old: string[] = [];
    for (let i = 1; i <= KEEP_QUARANTINE; i++) {
      const n = quarantineFileName(NOW - 1_000_000 + i);
      old.push(n);
      fs.writeFileSync(path.join(qDirOf(dir), n), `old-${i}`);
    }
    fs.writeFileSync(legacy(dir), "fresh\n");

    const r = await archiveLegacyRunEvents(dir, { now: NOW });
    expect(r.status).toBe("archived");
    const left = names(dir);
    expect(left).toHaveLength(KEEP_QUARANTINE);
    expect(left).not.toContain(old[0]); // 最老的没了
    expect(left).toContain(quarantineFileName(NOW)); // 新归档的在
  });

  it("旁路目录建不出来：不抛、返回 skipped、旧文件原样（最坏回到归档之前的行为）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkTmp();
    fs.writeFileSync(legacy(dir), "keep me\n");
    fs.writeFileSync(qDirOf(dir), "我是个文件，占着旁路目录的位置");

    const r = await archiveLegacyRunEvents(dir, { now: NOW });
    expect(r.status).toBe("skipped");
    expect(r.reason).toBeTruthy();
    expect(fs.readFileSync(legacy(dir), "utf8")).toBe("keep me\n");
    expect(warn).toHaveBeenCalled();
  });

  it("目录本身不存在：当作没有旧文件，不抛", async () => {
    const dir = path.join(mkTmp(), "not-created");
    expect(await archiveLegacyRunEvents(dir, { now: NOW })).toEqual({ status: "none" });
  });
});

describe("pruneQuarantine", () => {
  it("只动 run_events-*.ndjson，别的文件不碰；目录不存在不抛", async () => {
    const dir = mkTmp();
    const q = qDirOf(dir);
    fs.mkdirSync(q, { recursive: true });
    for (let i = 0; i < KEEP_QUARANTINE + 2; i++) {
      fs.writeFileSync(path.join(q, quarantineFileName(NOW + i)), "x");
    }
    fs.writeFileSync(path.join(q, "README.txt"), "别删我");
    fs.writeFileSync(path.join(q, "other.ndjson"), "别删我");

    await pruneQuarantine(q);
    const left = fs.readdirSync(q).sort();
    expect(left.filter((n) => n.startsWith("run_events-"))).toHaveLength(KEEP_QUARANTINE);
    expect(left).toContain("README.txt");
    expect(left).toContain("other.ndjson");

    await expect(pruneQuarantine(path.join(dir, "nope"))).resolves.toBeUndefined();
  });
});
