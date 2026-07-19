/**
 * 「更新就位未重启」marker 检测（V0.10.1）——
 * 壳替换 bundle 后写 marker、server 起新 agent run 前必须拦住（防 shell 永久挂死假死任务）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TMP_DATA = path.join(os.tmpdir(), `fe-update-pending-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_DATA;

import {
  assertNoUpdatePendingRestart,
  checkUpdatePendingRestart,
} from "@/lib/server/update-pending";

const MARKER = path.join(TMP_DATA, "update-pending-restart.json");

beforeAll(async () => {
  await fs.mkdir(TMP_DATA, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(TMP_DATA, { recursive: true, force: true });
});

describe("checkUpdatePendingRestart", () => {
  it("无 marker：放行（返 null、assert 不抛）", async () => {
    await fs.rm(MARKER, { force: true });
    expect(await checkUpdatePendingRestart()).toBeNull();
    await expect(assertNoUpdatePendingRestart()).resolves.toBeUndefined();
  });

  it("有 marker：拒绝文案带版本号、assert 抛错", async () => {
    await fs.writeFile(MARKER, JSON.stringify({ version: "0.9.14", at: 1 }));
    const msg = await checkUpdatePendingRestart();
    expect(msg).toContain("v0.9.14");
    expect(msg).toContain("重启");
    await expect(assertNoUpdatePendingRestart()).rejects.toThrow(/重启/);
  });

  it("marker 内容损坏：照样拦（存在即信号）", async () => {
    await fs.writeFile(MARKER, "not-json{{{");
    const msg = await checkUpdatePendingRestart();
    expect(msg).not.toBeNull();
    expect(msg).toContain("重启");
  });

  it("读 marker 非 ENOENT（如 EACCES）：fail-closed、提示重启", async () => {
    // 旧行为任何 read 错误都当无 marker 放行 → EACCES 时硬闸失效
    await fs.rm(MARKER, { force: true });
    const err = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    // assert 内部再调一次 check——mock 两次，避免落到盘上真实文件
    vi.spyOn(fs, "readFile")
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);
    const msg = await checkUpdatePendingRestart();
    expect(msg).toBe("读更新标记失败、为安全起见请重启应用");
    await expect(assertNoUpdatePendingRestart()).rejects.toThrow(/读更新标记失败/);
  });
});
