/**
 * WIP 快照守卫（第三轮 review D2b-15 / F1-05）：`git status --porcelain=v2 -z` 的纯解析。
 *
 * 为什么要 v2：v1 的 ` M vendor/sub` 分不出「子模块指针变了」还是「子模块里有未提交改动」，
 * 而后者进不了父仓的 tree（只有 gitlink），快照树 == HEAD 树 → 被判 clean → 整目录删掉、改动永久丢失。
 * v2 的 `<sub>` 字段 `S<c><m><u>` 直接给出「子模块里有 tracked 改动（m）/ 未跟踪文件（u）」。
 */
import { describe, expect, it } from "vitest";

import { parseWorktreeStatusV2 } from "@/lib/server/worktree-status";

const NUL = "\0";
const H = "0000000000000000000000000000000000000000";

/** 拼 v2 `1` 记录：1 XY sub mH mI mW hH hI path */
const ord = (xy: string, sub: string, p: string) =>
  `1 ${xy} ${sub} 100644 100644 100644 ${H} ${H} ${p}`;
/** `u` 记录：u XY sub m1 m2 m3 mW h1 h2 h3 path */
const unmerged = (xy: string, p: string) =>
  `u ${xy} N... 100644 100644 100644 100644 ${H} ${H} ${H} ${p}`;
/** `2` 记录（改名 / 复制）：2 XY sub mH mI mW hH hI Xscore path<NUL>origPath */
const renamed = (p: string, orig: string) =>
  `2 R. N... 100644 100644 100644 ${H} ${H} R100 ${p}${NUL}${orig}`;

const z = (...records: string[]) => records.join(NUL) + NUL;

describe("parseWorktreeStatusV2", () => {
  it("空输出 = 干净", () => {
    expect(parseWorktreeStatusV2("")).toEqual({
      total: 0,
      unmerged: [],
      dirtySubmodules: [],
      movedSubmodules: [],
      untrackedDirs: [],
    });
  });

  it("普通改动 / 未跟踪文件：计数、不报子模块与未合并", () => {
    const r = parseWorktreeStatusV2(z(ord(".M", "N...", "a.txt"), "? new.ts"));
    expect(r.total).toBe(2);
    expect(r.unmerged).toEqual([]);
    expect(r.dirtySubmodules).toEqual([]);
    expect(r.untrackedDirs).toEqual([]);
  });

  it("子模块：里面有 tracked 改动（S.M.）/ 有未跟踪文件（S..U）/ 两者都有（S.MU）→ 都算脏", () => {
    const r = parseWorktreeStatusV2(
      z(
        ord(".M", "S.M.", "vendor/a"),
        ord(".M", "S..U", "vendor/b"),
        ord(".M", "S.MU", "vendor/c"),
      ),
    );
    expect(r.dirtySubmodules).toEqual(["vendor/a", "vendor/b", "vendor/c"]);
  });

  it("子模块：只有指针变化（SC..）不算「里面脏」，但单独记进 movedSubmodules（提交可能只在子模块本地，Q3-03）；完全干净（S...）两边都不报", () => {
    const r = parseWorktreeStatusV2(
      z(ord(".M", "SC..", "vendor/ptr"), ord(".M", "S...", "vendor/clean")),
    );
    expect(r.dirtySubmodules).toEqual([]);
    expect(r.movedSubmodules).toEqual(["vendor/ptr"]);
    expect(r.total).toBe(2);
  });

  it("子模块：指针变了且里面也脏（SCM. / SC.U / SCMU）→ 既是 dirty 也是 moved", () => {
    const r = parseWorktreeStatusV2(
      z(ord(".M", "SCM.", "v/a"), ord(".M", "SC.U", "v/b"), ord(".M", "SCMU", "v/c")),
    );
    expect(r.dirtySubmodules).toEqual(["v/a", "v/b", "v/c"]);
    expect(r.movedSubmodules).toEqual(["v/a", "v/b", "v/c"]);
  });

  it("非子模块记录（N...）永远不进 moved / dirty", () => {
    const r = parseWorktreeStatusV2(z(ord(".M", "N...", "a.ts")));
    expect(r.movedSubmodules).toEqual([]);
    expect(r.dirtySubmodules).toEqual([]);
  });

  it("未合并 `u` 记录 → unmerged（不依赖 XY 码枚举）", () => {
    const r = parseWorktreeStatusV2(z(unmerged("UU", "conflict.ts"), unmerged("AA", "both.ts")));
    expect(r.unmerged).toEqual(["conflict.ts", "both.ts"]);
  });

  it("路径里有空格 / 中文：完整保留", () => {
    const r = parseWorktreeStatusV2(
      z(unmerged("UU", "目录 有 空格/冲突 文件.ts"), ord(".M", "S.M.", "第三方 库/子 模块")),
    );
    expect(r.unmerged).toEqual(["目录 有 空格/冲突 文件.ts"]);
    expect(r.dirtySubmodules).toEqual(["第三方 库/子 模块"]);
  });

  it("改名记录（`2`）后面多带一个原路径字段：不能把它当成独立记录，也不影响后续记录的解析", () => {
    const r = parseWorktreeStatusV2(
      z(renamed("new-name.ts", "old-name.ts"), ord(".M", "S.M.", "vendor/after")),
    );
    expect(r.total).toBe(2);
    expect(r.dirtySubmodules).toEqual(["vendor/after"]);
  });

  it("未跟踪目录（以 / 结尾）单独列出：调用方据此探测里面是不是嵌套 git 仓", () => {
    const r = parseWorktreeStatusV2(z("? scaffold/", "? loose.txt", "? deep dir/"));
    expect(r.untrackedDirs).toEqual(["scaffold/", "deep dir/"]);
    expect(r.total).toBe(3);
  });

  it("被忽略项（`!`）与表头（`#`）不计入", () => {
    const r = parseWorktreeStatusV2(z("# branch.oid abc", "! ignored.log", "? a.txt"));
    expect(r.total).toBe(1);
  });
});
