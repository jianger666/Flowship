/**
 * getUniqueRepoDirNames 的大小写探重只在「大小写不敏感文件系统」上生效（评审 2026-11-01 第 2 轮）。
 *
 * 背景：worktree 目录名**不落库、每次由 repoPaths 重算**（getTaskWorkRepoPaths / removeTaskWorktrees /
 * pruneUnmappedTaskWorktreeDirs / planWorktreeDirChanges 全是现算）。Linux 上 `[Web, web]` 的老任务磁盘上是
 * Web / web 两个目录；若无条件按小写探重，重算结果变成 Web / web-2——
 *   - agent cwd 指到不存在的 web-2；
 *   - 删任务按 web-2 找，真实的 web 工作区（含未提交改动）成了孤儿；
 *   - 活任务兜底把真实存在的 web 当「未映射残留」剪掉（先 WIP 快照再 rm）。
 * mac（APFS）/ Windows（NTFS）上才真的需要把 Web / web 视作同一目录。
 *
 * 纯函数 + 平台注入；链路用例临时改 process.platform（try/finally 还原），不写盘（数据目录指向临时目录）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Task } from "@/lib/types";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-uniq-dir-"));
process.env.FLOWSHIP_DATA_DIR = DATA;

afterAll(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
});

import {
  getRepoWorkDirs,
  getUniqueRepoDirNames,
  isCaseInsensitiveFsPlatform,
} from "@/lib/path-utils";

const withPlatform = async <T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
};

const task = (repoPaths: string[]): Task =>
  ({
    id: "t_1700000000000_abc123",
    mode: "task",
    title: "t",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths,
    isolateWorktree: true,
    actions: [],
    mrs: [],
  }) as unknown as Task;

describe("getUniqueRepoDirNames：探重大小写取决于文件系统", () => {
  it("区分大小写（Linux）：[Web, web] 保持 Web / web（老任务磁盘上的目录名不变）", () => {
    expect(getUniqueRepoDirNames(["/a/Web", "/b/web"], { caseInsensitive: false })).toEqual(["Web", "web"]);
    // 完全同名仍要追加序号
    expect(getUniqueRepoDirNames(["/a/web", "/b/web", "/c/Web"], { caseInsensitive: false })).toEqual([
      "web",
      "web-2",
      "Web",
    ]);
  });

  it("不区分大小写（mac / Windows）：Web 与 web 是同一目录，后来者追加 -N、保留原始大小写", () => {
    expect(getUniqueRepoDirNames(["/a/Web", "/b/web"], { caseInsensitive: true })).toEqual(["Web", "web-2"]);
    expect(getUniqueRepoDirNames(["/a/web", "/b/WEB", "/c/Web"], { caseInsensitive: true })).toEqual([
      "web",
      "WEB-2",
      "Web-3",
    ]);
    expect(getUniqueRepoDirNames(["/a/web", "/b/Web", "/c/WEB-2"], { caseInsensitive: true })).toEqual([
      "web",
      "Web-2",
      "WEB-2-2",
    ]);
  });

  it("缺省按当前平台判定", () => {
    const expected = isCaseInsensitiveFsPlatform();
    expect(getUniqueRepoDirNames(["/a/Web", "/b/web"])).toEqual(expected ? ["Web", "web-2"] : ["Web", "web"]);
  });
});

describe("isCaseInsensitiveFsPlatform", () => {
  it("darwin / win32 → 不敏感；linux 等 → 敏感", () => {
    expect(isCaseInsensitiveFsPlatform({ platform: "darwin" })).toBe(true);
    expect(isCaseInsensitiveFsPlatform({ platform: "win32" })).toBe(true);
    expect(isCaseInsensitiveFsPlatform({ platform: "linux" })).toBe(false);
    expect(isCaseInsensitiveFsPlatform({ platform: "freebsd" })).toBe(false);
  });

  it("浏览器端（process.platform 不可用）：嗅探 navigator", () => {
    const macUa = "MacIntel Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    const winUa = "Win32 Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
    const linuxUa = "Linux x86_64 Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";
    expect(isCaseInsensitiveFsPlatform({ platform: "browser", navigatorHint: macUa })).toBe(true);
    expect(isCaseInsensitiveFsPlatform({ platform: undefined, navigatorHint: winUa })).toBe(true);
    expect(isCaseInsensitiveFsPlatform({ platform: "browser", navigatorHint: linuxUa })).toBe(false);
    expect(isCaseInsensitiveFsPlatform({ navigatorHint: "Linux armv8l Mozilla/5.0 (Linux; Android 14)" })).toBe(false);
  });

  it("完全判不出：按「不敏感」（多个 -N 后缀无害，误判成敏感才会让两仓撞同一目录）", () => {
    expect(isCaseInsensitiveFsPlatform({})).toBe(true);
    expect(isCaseInsensitiveFsPlatform({ platform: "browser", navigatorHint: "" })).toBe(true);
  });
});

describe("链路：旧 Linux 任务 [Web, web] 重算出的目录必须还是磁盘上已有的那两个", () => {
  const repos = ["/work/Web", "/work2/web"];

  it("Linux：getTaskWorkRepoPaths 指向 <task>/Web 与 <task>/web（不是 web-2）", async () => {
    const { getTaskWorkRepoPaths, getTaskWorktreesDir } = await import("@/lib/server/task-worktrees");
    const t = task(repos);
    const dir = getTaskWorktreesDir(t.id);
    await withPlatform("linux", () => {
      expect(getTaskWorkRepoPaths(t)).toEqual([path.join(dir, "Web"), path.join(dir, "web")]);
    });
  });

  it("mac / Windows：同一份 repoPaths 第二仓是 web-2（APFS / NTFS 上 Web 与 web 是同一目录）", async () => {
    const { getTaskWorkRepoPaths, getTaskWorktreesDir } = await import("@/lib/server/task-worktrees");
    const t = task(repos);
    const dir = getTaskWorktreesDir(t.id);
    for (const platform of ["darwin", "win32"] as const) {
      await withPlatform(platform, () => {
        expect(getTaskWorkRepoPaths(t)).toEqual([path.join(dir, "Web"), path.join(dir, "web-2")]);
      });
    }
  });

  it("client 侧 getRepoWorkDirs 与 server 同源：Linux 下 shortName 也是 Web / web", async () => {
    await withPlatform("linux", () => {
      const dirs = getRepoWorkDirs(repos, "/data/worktrees/t1", true);
      expect(dirs.map((d) => d.shortName)).toEqual(["Web", "web"]);
      expect(dirs.map((d) => d.workDir)).toEqual(["/data/worktrees/t1/Web", "/data/worktrees/t1/web"]);
    });
  });
});
