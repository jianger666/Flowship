/**
 * 第五轮 Q3-08：macOS 并发删除时 `rename` 抛 `EINVAL`（不是 `ENOENT`），只认 ENOENT 的降级在 macOS 上失效。
 * 这里用确定性注入（不靠竞态碰运气）钉住 `isDirGoneError` 与 `writeRewindPoints` 的口径：
 *   - ENOENT 一律算「目录已不在」；
 *   - EINVAL / ENOTDIR 只有目录**确实不在**才算，目录还在 = 真错误、必须抛回去；
 *   - 其它 errno（EEXIST / EACCES …）不算。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-fs-gone-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import { writeRewindPoints, getRewindPointsPath } from "@/lib/server/chat-checkpoint";
import { isDirGoneError } from "@/lib/server/fs-gone";
import { appendEventLine, readEvents, taskDir } from "@/lib/server/task-fs-core";
import type { TaskEvent } from "@/lib/types";

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code });
const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("isDirGoneError", () => {
  it("ENOENT 一律算已不在（旧行为，不再 stat）", async () => {
    expect(await isDirGoneError(errno("ENOENT"), path.join(TMP_ROOT, "whatever-exists-or-not"))).toBe(true);
  });

  it("EINVAL / ENOTDIR：目录确实不在 → true", async () => {
    const missing = path.join(TMP_ROOT, "definitely-missing");
    expect(await isDirGoneError(errno("EINVAL"), missing)).toBe(true);
    expect(await isDirGoneError(errno("ENOTDIR"), missing)).toBe(true);
  });

  it("EINVAL：目录还在 → false（真参数错，不能被吞）", async () => {
    const alive = path.join(TMP_ROOT, "alive");
    await fs.mkdir(alive, { recursive: true });
    expect(await isDirGoneError(errno("EINVAL"), alive)).toBe(false);
  });

  it("EINVAL：并发 rm 稍后才拆完目录 → 退避重查后 true", async () => {
    const dying = path.join(TMP_ROOT, "dying");
    await fs.mkdir(dying, { recursive: true });
    setTimeout(() => void fs.rm(dying, { recursive: true, force: true }), 15);
    expect(await isDirGoneError(errno("EINVAL"), dying)).toBe(true);
  });

  it("其它 errno / 非 errno 值都不算", async () => {
    const missing = path.join(TMP_ROOT, "missing-2");
    for (const code of ["EEXIST", "EACCES", "EPERM", "EBUSY"]) {
      expect(await isDirGoneError(errno(code), missing)).toBe(false);
    }
    expect(await isDirGoneError(new Error("no code"), missing)).toBe(false);
    expect(await isDirGoneError(undefined, missing)).toBe(false);
    expect(await isDirGoneError(null, missing)).toBe(false);
  });

  it("第六轮 MFG-6：复查时 stat 本身报 EACCES / EIO（目录状态未知）≠ 目录不在 → EINVAL 不得被吞", async () => {
    const missing = path.join(TMP_ROOT, "stat-fails-so-unknown");
    for (const code of ["EACCES", "EIO", "EPERM"]) {
      const spy = vi.spyOn(fs, "stat").mockRejectedValue(errno(code));
      expect(await isDirGoneError(errno("EINVAL"), missing), code).toBe(false);
      spy.mockRestore();
    }
    // 对照：同一个目录、stat 正常报 ENOENT → 确认不在 → true（证明上面的 false 来自 stat 错误而不是别的）
    expect(await isDirGoneError(errno("EINVAL"), missing)).toBe(true);
  });
});

describe("第六轮 MTF-1：appendEventLine 在 macOS 式并发删除（open / append 抛 EINVAL）时降级为 false，而不是抛", () => {
  /** appendEventLine 会后台（void）写 seq sidecar，与测试里的 rm 并发时 rmdir 可能 ENOTEMPTY——真实并发删除也是这样，重试到删净 */
  const rmDirRetrying = async (dir: string): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  };
  const ev = (id: string): TaskEvent => ({ id, ts: Date.now(), kind: "info", text: "late event" }) as TaskEvent;

  it("追加时任务目录被删并抛 EINVAL → 返回 false、不抛、目录不复活（macOS 真机复现 5/3600 `open:EINVAL`）", async () => {
    const id = "t_1700000060001_append_einval";
    await fs.mkdir(taskDir(id), { recursive: true });
    const spy = vi.spyOn(fs, "appendFile").mockImplementationOnce(async () => {
      await rmDirRetrying(taskDir(id));
      throw errno("EINVAL");
    });
    await expect(appendEventLine(id, ev("e1"))).resolves.toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    // 等后台 best-effort 的 seq sidecar 写完（目录没了它只会静默失败），确认没把目录写回来
    await new Promise((r) => setTimeout(r, 30));
    expect(await exists(taskDir(id))).toBe(false);
  });

  it("对照：EINVAL 但目录仍在 → 真错误，照常抛（不静默吞），且之后同一任务还能正常追加", async () => {
    const id = "t_1700000060002_append_einval_alive";
    await fs.mkdir(taskDir(id), { recursive: true });
    vi.spyOn(fs, "appendFile").mockImplementationOnce(async () => {
      throw errno("EINVAL");
    });
    await expect(appendEventLine(id, ev("e1"))).rejects.toMatchObject({ code: "EINVAL" });
    await expect(appendEventLine(id, ev("e2"))).resolves.toBe(true);
    expect((await readEvents(id)).map((e) => e.id)).toEqual(["e2"]);
  });

  it("对照（旧树能用的情形）：ENOENT 仍降级为 false；目录在、写正常 → true", async () => {
    const id = "t_1700000060003_append_enoent";
    await fs.mkdir(taskDir(id), { recursive: true });
    vi.spyOn(fs, "appendFile").mockImplementationOnce(async () => {
      await rmDirRetrying(taskDir(id));
      throw errno("ENOENT");
    });
    await expect(appendEventLine(id, ev("e1"))).resolves.toBe(false);
    const id2 = "t_1700000060004_append_ok";
    await fs.mkdir(taskDir(id2), { recursive: true });
    await expect(appendEventLine(id2, ev("e1"))).resolves.toBe(true);
  });
});

describe("writeRewindPoints：macOS 式并发删除（rename 抛 EINVAL）也降级而不是抛", () => {
  it("rename 时任务目录被删并抛 EINVAL → 不抛、不复活目录、tmp 不残留", async () => {
    const id = "t_1700000050001_einval";
    await fs.mkdir(taskDir(id), { recursive: true });
    const spy = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
      await fs.rm(taskDir(id), { recursive: true, force: true });
      throw errno("EINVAL");
    });
    await expect(writeRewindPoints(id, [])).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await exists(taskDir(id))).toBe(false);
  });

  it("对照：rename 抛 EINVAL 但目录仍在 → 是真错误，照常抛出（不静默吞）", async () => {
    const id = "t_1700000050002_einval_alive";
    await fs.mkdir(taskDir(id), { recursive: true });
    vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
      throw errno("EINVAL");
    });
    await expect(writeRewindPoints(id, [])).rejects.toMatchObject({ code: "EINVAL" });
    expect(await exists(getRewindPointsPath(id))).toBe(false);
  });

  it("对照（旧树能用的情形）：目录在、rename 正常 → 照常落盘", async () => {
    const id = "t_1700000050003_ok";
    await fs.mkdir(taskDir(id), { recursive: true });
    await writeRewindPoints(id, []);
    expect(await exists(getRewindPointsPath(id))).toBe(true);
  });
});
